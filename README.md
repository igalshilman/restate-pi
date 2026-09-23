# restate-pi

Run [pi](https://github.com/badlogic/pi-mono), the open-source coding agent, inside
[Restate](https://restate.dev) durable execution.

pi's agent loop runs unmodified. Every model call and tool call it makes becomes a
journaled Restate step. So if you kill the process mid-turn, the turn picks up where it
stopped, with the same tool calls and the same answer. A tool can wait hours for a
human with no process held, a running agent can be steered, and one agent can call
another over Restate.

Everything is written against Restate's generator SDK,
[`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen).

| Package | What it is |
| --- | --- |
| [`libs/restate-pi`](libs/restate-pi) | The library: the bridge between pi and Restate, tools as Restate operations, durable model calls, steering, and hosting for pi's `AgentHarness`. |
| [`examples/virtual-object`](examples/virtual-object) | pi as a Restate virtual object, at three layers: `piAgent`, `piHarness`, `piCoding`. |
| [`examples/approval`](examples/approval) | A deploy tool that waits, suspended, for a human to approve production. |
| [`examples/delegation`](examples/delegation) | A lead agent that hands research to other agents over Restate, in parallel. |

## Quick start

You need Node.js 22.19+, pnpm, and a Restate server. No API key is required: without
one, the examples run on a scripted fake model that is deterministic and needs no
network.

1. Install the dependencies:

   ```bash
   pnpm install
   ```

2. Start Restate in its own terminal:

   ```bash
   npx @restatedev/restate-server
   # or, with Docker:
   # docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:latest
   ```

3. Serve the virtual-object example on port 9080. It keeps running and restarts on changes:

   ```bash
   pnpm dev
   ```

4. From another terminal, register the service with Restate. You only do this once:

   ```bash
   npx @restatedev/restate deployments register http://localhost:9080
   # With the Docker server, register http://host.docker.internal:9080 instead.
   ```

Then talk to it:

```bash
curl localhost:8080/piAgent/demo/prompt --json '{}'
curl localhost:8080/piAgent/demo/prompt --json '{"message": "Please also run the linter."}'
curl localhost:8080/piAgent/demo/transcript --json '{}'
```

To run the virtual-object example on a real model, set `OPENAI_API_KEY`, and optionally
`OPENAI_MODEL`, before `pnpm dev`. The approval and delegation examples always use the
scripted model.

## What the code looks like

A Restate handler builds a pi `Agent` as usual, but hands it a mailbox instead of a
real model and real tools. pi's side runs as plain async code, while the handler serves
whatever pi asks for:

```ts
function* prompt({message}: {message: string}): restate.Operation<string> {
  const mailbox = new Mailbox();
  const agent = new Agent({
    initialState: {systemPrompt, model, tools: TOOLS.map((t) => toAgentTool(mailbox, t))},
    streamFn: durableStreamFn(mailbox),
  });

  runPi(mailbox, async () => {                  // pi's side: plain async
    await agent.prompt(message);
    return lastAssistantText(agent.state.messages);
  });

  return yield* servePi<string>(mailbox, {       // Restate's side: serve each request as a journaled step
    serve: (request) => serveRequest(request, {mailbox, models, tools: TOOLS}),
    onSteer: (note) => agent.steer({role: "user", content: note, timestamp: Date.now()}),
  });
}
```

Tools are generator functions that return a Restate `Operation`, so a tool body can
`run` a side effect, `sleep`, `call` another service, or wait on an `awakeable`:

```ts
export const deploy = tool({
  name: "deploy",
  label: "Deploy build",
  description: "Deploy the current build to an environment.",
  parameters: Type.Object({env: Type.String()}),
  *execute(params, call) {
    const allowed = yield* restate.run(() => guard(call), {name: "Check guardrail"});
    if (!allowed) return textResult("blocked by guardrail");
    return textResult(yield* restate.run(() => deployTo(params.env), {name: `Deploy to ${params.env}`}));
  },
});
```

One tool definition works with pi's classic `Agent`, its durable `AgentHarness`, and
the coding agent. The [library README](libs/restate-pi) lists the full API.

## How it works

pi's hooks are async functions, but the generator SDK's operations only work inside a
running Restate handler. So the bridge runs one way: pi posts each request to a
mailbox, and the handler serves it.

```text
pi (plain async)                     Restate handler (generator)
streamFn / tool.execute ──post──▶    run(() => mailbox.next())    journals a small request descriptor
                                     spawn(serve(request))         model call, tool, or timer
                        ◀─answer──   task settles → mailbox.answer(seq, value)
```

- **Ordering.** `servePi` is a single `select` over pi's next request, the `steer`
  signal, and every task in flight. The order in which they win is journaled, so a
  replay sees exactly the same sequence.
- **Replay.** On replay the handler reads answers from the journal and parks them in
  the mailbox by sequence number. pi's loop re-runs for real and picks them up without
  contacting the model or re-running tools. If pi asks for something different from what
  the journal recorded, the invocation fails instead of silently diverging.
- **Suspension.** Once pi is only waiting on answers and has gone quiet, the handler
  stops listening to pi and waits on its tasks alone. No step is left open across a long
  tool call, timer or approval, so Restate can suspend the invocation until something
  happens.
- **Steering.** A steering note is delivered only while pi is waiting on a request.
  That fixes the note's place in the transcript, so a replay puts it in the same spot.

## Examples

### Virtual objects

The object key is the pi session, and each `prompt` is one durable turn. The
conversation is stored in object state one entry per turn, so the next prompt carries
on from it.

| Object | pi layer | What Restate adds |
| --- | --- | --- |
| `piAgent` | `Agent` from `pi-agent-core` | Every model call and tool call is a journaled step. |
| `piHarness` | `AgentHarness`, pi's own durable runtime | Restate acts as the serving layer the harness spec describes: it calls `accept`, loops on `drive`, and turns every wait the harness asks for (retry backoff, deferred responses) into a Restate timer. |
| `piCoding` | `createAgentSession` from `pi-coding-agent` | pi's real `read`, `bash`, `edit` and `write` tools run as journaled steps in a per-session workspace. A failing command comes back to pi as an error result instead of being retried. |

`steer` hands a note to the running turn and waits until the turn confirms it took it.
No note is lost. A note that arrives after pi has finished starts a follow-up turn in
the same invocation. A note that no turn takes, because the session is idle or the turn
ended first, becomes the next `prompt`.

```bash
# Slow tools make the turn easy to steer: deploy and test wait on a 6 s durable timer.
PI_TOOL_DELAY_MS=6000 pnpm dev

ID=$(curl -s localhost:8080/piAgent/s1/prompt/send --json '{}' | jq -r .invocationId)
curl localhost:8080/piAgent/s1/steer --json '{"note": "Please also run the linter."}'
curl localhost:8080/restate/invocation/$ID/attach

curl localhost:8080/piHarness/demo/prompt --json '{}'
curl localhost:8080/piCoding/demo/prompt --json '{"message": "Create hello.txt with a greeting, then list the directory."}'
```

To see durability, kill the service mid-turn and start it again. The log shows
`Replaying invocation`, journaled steps return without running again, timers that
already elapsed fire at once, and the turn finishes with the same tool calls and the
same answer.

`piCoding` runs pi's tools directly on your machine, with no sandbox, so with a real
model it refuses to start unless `PI_CODING_HOST_ACCESS=1` is set. Tool results are
journaled but the files themselves are not, so a session belongs to the machine that
ran it.

### Approval

`releaseAgent` ships a release to staging and then production. For production, its
`deploy` tool creates an awakeable, records it in object state, and waits for
`approve`, `reject`, or a deadline. Nothing runs while it waits: the invocation is
suspended until someone decides.

```bash
pnpm --filter @restate-pi/example-approval dev

ID=$(curl -s localhost:8080/releaseAgent/r1/prompt/send --json '{"message": "Ship v2.1 to production"}' | jq -r .invocationId)
curl localhost:8080/releaseAgent/r1/pending --json '{}'
curl localhost:8080/releaseAgent/r1/approve --json '{"by": "sam"}'
curl localhost:8080/restate/invocation/$ID/attach
```

### Delegation

`lead` and `researcher` are Restate services, and each call to either one runs one pi
agent. The lead's `ask_researcher` tool is a Restate call to `researcher`. pi runs the
model's tool calls in parallel, so a single reply from the lead starts two researcher
agents at once, each one durable.

```bash
pnpm --filter @restate-pi/example-delegation dev

curl localhost:8080/lead/brief --json '{"goal": "Should we run pi on Restate?"}'
```

Every example listens on port 9080, so run one at a time or set `PORT`.

## Configuration

| Variable | Effect |
| --- | --- |
| `PORT` | Port the example listens on. Default `9080`. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Use OpenAI through pi-ai in the virtual-object example. The default model is `gpt-5.6-luna`. |
| `PI_PROVIDER` | `openai` or `faux`. Overrides the choice made from `OPENAI_API_KEY`. |
| `PI_WORKSPACE_ROOT` | Where `piCoding` keeps its workspaces. Default `./.pi-workspaces`. |
| `PI_CODING_HOST_ACCESS=1` | Let `piCoding` run pi's tools on this machine with a real model. |
| `PI_TOOL_DELAY_MS` | Make `deploy` and `test` wait on a durable timer, which leaves time to steer. |
| `PI_FINISH_DELAY_MS` | Hold a turn open after pi's last answer, so you can watch a late steer start a follow-up turn. |
| `PI_DEFERRED=1` | Make `piHarness` ask for deferred responses: the run suspends, sleeps durably, and polls. |

## Tests

`pnpm test` runs the library's unit tests, which cover the mailbox's rules for
ordering, replay, divergence and going idle. It then runs each example's integration
tests against a real Restate server in Docker, started with
`@restatedev/restate-sdk-testcontainers`.

The virtual-object tests cover:
- turns;
- steering: mid-turn, twice in one turn, late, idle, and after a stale turn;
- the deferred-response path;
- failing commands.

They also run all three objects on a server that suspends and replays after every
journal entry. The approval tests check that a turn waiting for a decision is actually
suspended. Set `RESTATE_IMAGE` to test against a different server image.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Serve the virtual-object example from the library's sources, restarting on changes. |
| `pnpm start` | Build, then serve the virtual-object example. |
| `pnpm build` | Build the library and the examples (`tsc -b`). |
| `pnpm typecheck` | Build, then type-check the tests. |
| `pnpm test` | Run the unit tests, then the Docker integration tests. |
