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
| [`e2e`](e2e) | End-to-end tests for every example, run live and always replaying. |

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

A pi session as a Restate virtual object is one call:

```ts
import {agentObject} from "restate-pi";

export const releaseBot = agentObject({
  name: "releaseBot",
  systemPrompt: "You ship releases.",
  model: () => ({models, model}),
  tools: [deploy, test],
});
```

That gives you `prompt`, `steer` and `transcript` handlers, with the conversation kept
in object state. To run a single pi turn inside any other handler (a service, a
workflow, a tool), use `runAgent`:

```ts
function* brief({goal}: {goal: string}): restate.Operation<string> {
  const {text} = yield* runAgent({systemPrompt, model: {models, model}, tools: [askResearcher], message: goal});
  return text;
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
the coding agent. Underneath `agentObject` and `runAgent` sit the building blocks
described next: a mailbox, the `servePi` loop and the adapters. They stay available for
hosting other pi layers. The [library README](libs/restate-pi) lists the full API.

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
| `piAgent` | `Agent` from `pi-agent-core`, through `agentObject` | Every model call and tool call is a journaled step. The whole object is a single `agentObject(...)` call. |
| `piHarness` | `AgentHarness`, pi's own durable runtime, hand-written on the building blocks | Restate acts as the serving layer the harness spec describes: it calls `accept`, loops on `drive`, and turns every wait the harness asks for (retry backoff, deferred responses) into a Restate timer. |
| `piCoding` | `createAgentSession` from `pi-coding-agent`, hand-written on the building blocks | pi's real `read`, `bash`, `edit` and `write` tools run as journaled steps in a per-session workspace. A failing command comes back to pi as an error result instead of being retried. |

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

`releaseAgent` is an `agentObject` with three extra handlers: `pending`, `approve` and
`reject`. It ships a release to staging and then production. For production, its
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
agent with `runAgent`. The lead's `ask_researcher` tool is a Restate call to `researcher`. pi runs the
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

`pnpm test:unit` runs the library's unit tests, which cover the mailbox's rules for
ordering, replay, divergence and going idle. They need nothing but Node.

`pnpm test:e2e` runs the end-to-end tests in [`e2e/`](e2e). They start every example
against a real Restate server in Docker, using `@restatedev/restate-sdk-testcontainers`,
and run each suite twice:

- **live:** the server keeps an invocation running while it makes progress, as in
  production;
- **always replaying:** the server suspends the invocation at every await and replays
  its whole journal to continue. Any non-determinism between an execution and its
  replay fails the test, for example pi asking for a different tool call or a step
  taken in a different order.

Retries are disabled in both modes, so a failure shows up at once instead of being
retried in the background.

The suites cover:
- turns and conversation history;
- steering: mid-turn, twice in one turn, late, idle, and after a stale turn;
- the harness's deferred-response path;
- failing commands in the coding agent;
- approvals: approved, rejected, expired, and the invocation suspended while it waits;
- parallel delegation to sub-agents;
- that no tool effect runs twice.

Set `E2E_MODES=live` or `E2E_MODES=replay` to run one mode, and `pnpm test` to run
everything.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Serve the virtual-object example from the library's sources, restarting on changes. |
| `pnpm start` | Build, then serve the virtual-object example. |
| `pnpm build` | Build the library and the examples (`tsc -b`). |
| `pnpm typecheck` | Build, then type-check the tests. |
| `pnpm test` | Run the unit tests, then the end-to-end tests. |
| `pnpm test:unit` | Run the library's unit tests. |
| `pnpm test:e2e` | Run the end-to-end tests in both modes (needs Docker). |
