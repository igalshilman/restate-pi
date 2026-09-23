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

The library is on npm:

```bash
npm install restate-pi @restatedev/restate-sdk @restatedev/restate-sdk-gen \
  @earendil-works/pi-agent-core @earendil-works/pi-ai typebox
```

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
the coding agent. Underneath `agentObject` and `runAgent` sit the building blocks: a mailbox, the
`servePi` loop and the adapters. [How it works](#how-it-works) explains them and shows the
same handler written by hand. The [library README](libs/restate-pi) lists the full API.

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

### Written by hand

This is roughly what `runAgent` does for you: a `prompt` handler built directly from
the building blocks. You build pi's `Agent` yourself and give it a model function and
tools that post to a mailbox. You start pi's work as plain async code, then let
`servePi` serve its requests until pi reports that it is done:

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {Agent} from "@earendil-works/pi-agent-core";
import {Mailbox, durableStreamFn, lastAssistantText, runPi, servePi, serveRequest, toAgentTool} from "restate-pi";

function* prompt({message}: {message: string}): restate.Operation<string> {
  const mailbox = new Mailbox();

  // pi's side. A normal pi Agent, except its model calls and tool calls post to the mailbox.
  const agent = new Agent({
    initialState: {
      systemPrompt: "You ship releases.",
      model,
      tools: TOOLS.map((t) => toAgentTool(mailbox, t)),
    },
    streamFn: durableStreamFn(mailbox),
  });

  // Start pi's turn as plain async code. Its result is what servePi returns.
  runPi(mailbox, async () => {
    await agent.prompt(message);
    return lastAssistantText(agent.state.messages);
  });

  // Restate's side. Serve each request as a journaled step until pi is done.
  return yield* servePi<string>(mailbox, {
    serve: (request) => serveRequest(request, {mailbox, models, tools: TOOLS}),
    onSteer: (note) => agent.steer({role: "user", content: note, timestamp: Date.now()}),
  });
}
```

`serve` decides how each request is handled. `serveRequest` is the default: the model
call runs in one journaled step, the tool runs its generator, and a harness wait
becomes a Restate timer. Replace it to route model calls somewhere else, or to wrap
every tool call in your own step. Unlike `runAgent`, this version starts from an empty
conversation, and a steer that arrives after pi finished is dropped. Pass `onLateSteer`
to start a follow-up turn for it instead.

The same pieces host pi's other layers. For fuller examples, see
[`harness-object.ts`](examples/virtual-object/src/harness-object.ts), which drives pi's
`AgentHarness` with `driveToSettlement`, and
[`coding-object.ts`](examples/virtual-object/src/coding-object.ts), which runs the
coding agent with pi's own tools wrapped by `fromAgentTool`.

## Determinism

Restate recovers a handler by replaying it: the handler runs again from the top, and
every step already in the journal returns its recorded result instead of running.
restate-pi does not journal pi itself. On replay, pi's loop really runs again, and only
what pi asks for is served from the journal. So a replay works only if pi, given the
same answers, asks for the same things in the same order.

**What is journaled.** Each request pi makes, recorded as a small descriptor: a model
call, or a tool call with its name and call id. Also each answer: the settled model
message and the tool's result. Steering notes and the "pi has gone quiet" markers are
journaled too, as is the value pi returns at the end of a turn. State written from that
value therefore matches the first execution.

**What is not.** pi's internal state: message timestamps, event order, ids it makes up
for itself. Those can differ on replay, and that is fine because nothing that is
journaled depends on them. Tool call ids come from the model's reply, which is
journaled, so they come back the same.

**How divergence is caught.** When pi re-issues request *n* on replay, the mailbox
compares it with the descriptor in the journal: the same kind, the same tool and call
id, the same model mode. If they differ, the invocation fails with
`pi replay divergence at request n: the journal has …, pi asked for …`. It does not
carry on with answers that belong to another request.

**What restate-pi does to keep pi deterministic:**
- **Answers arrive in journal order.** Each one is delivered while the handler
  advances, in the order recorded in the journal.
- **Steering notes land at a fixed point.** A note reaches pi only while pi is waiting
  on a request, so a replay puts it at the same spot in the transcript.
- **Turns run one at a time** (`runPi`). A replay can reach the end of a turn in the
  journal before pi's re-run of that turn has actually finished. A follow-up turn waits
  for pi, not for the journal.
- **Going quiet is journaled, not re-timed.** Deciding that pi has gone quiet uses a
  short timer, but only on the first execution. Replay reads the decision from the
  journal.
- **The harness's operation ids** come from `restate.rand()`, so they match on replay.

**What your code must do:**
- **Keep effects inside tools.** Anything pi learns from the outside world has to
  arrive as a model reply or a tool result. A pi hook that reads the clock, a file or
  an API to decide what to ask next makes pi's requests differ on replay. Put that work
  in a tool.
- **Keep side effects inside `restate.run` in tool bodies.** Outside it, use
  `restate.date()` and `restate.rand()` instead of `Date.now()` and `Math.random()`.
  Anything that decides which steps a tool takes must come from the journal.
- **Use a model provider that any process can poll for deferred responses.** A real
  provider's deferred handle points to its own servers, so that works. `scriptedModel`
  carries the reply inside the handle. pi-ai's own fake provider keeps deferred replies
  in memory, which a replay in another process cannot poll.

**Testing it.** The e2e tests run every example twice, once on a server that
suspends at every await and replays the whole journal to continue. Two bugs found that
way are fixed in the library. One was a follow-up turn starting inside a turn pi was
still re-running. The other was deferred replies that only existed in one process's
memory. Run your own services the same way with
`RestateTestEnvironment.start({services, alwaysReplay: true})`.

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

## License

MIT
