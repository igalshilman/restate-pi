# restate-pi

[pi](https://github.com/badlogic/pi-mono), the open-source coding agent, embedded in
[Restate](https://restate.dev) durable execution on the generator SDK
([`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen)).

pi's loop runs unmodified as plain async code. Every model call and tool call it makes
becomes a journaled Restate step. Kill the process mid-turn and the turn resumes where
it was, with the same tool call ids and the same answer.

| Package | |
| --- | --- |
| [`libs/restate-pi`](libs/restate-pi) | the library: the mailbox bridge, tools as Restate Operations, the durable model call, acknowledged steering, a driver for pi's `AgentHarness` |
| [`examples/virtual-object`](examples/virtual-object) | three virtual objects built on it: `piAgent`, `piHarness`, `piCoding` |
| [`examples/approval`](examples/approval) | a tool that waits, suspended, for a human to approve a production deploy |
| [`examples/delegation`](examples/delegation) | a lead agent whose tool calls researcher agents through Restate, in parallel |

## How it works

pi's hooks are async functions and the generator SDK's free functions only work on an
advancing fiber, so the bridge runs one way: pi posts requests to a mailbox and the
fiber serves them.

```text
pi (plain async)                     fiber (generator)
streamFn / tool.execute ──post──▶    run(() => mailbox.next())   journals a small descriptor
                                     spawn(serve(request))        model call, tool Operation, or sleep
                        ◀─answer──   task settles → mailbox.answer(seq, value)
```

`servePi` is one `select` over pi's next request, the `steer` signal and every task in
flight, so their order is journaled and replays identically. A steer is delivered only
while pi is blocked on an outstanding request, which pins the note's position in pi's
transcript. On replay the fiber races through the journal and parks answers by sequence
number while pi's loop re-runs for real and picks them up.

While pi is parked on answers it has not received yet, the fiber stops waiting on it:
`mailbox.next` comes back with a journaled idle marker once pi has been quiet for a
moment, and the fiber waits on its tasks alone until one settles. No `run` stays open
across a long tool call, timer or awakeable, so Restate can suspend the invocation.

Tools are generator functions returning an `Operation`. A tool body can `run`, `spawn`,
`sleep`, `call` another service or park on an `awakeable`. One definition adapts to pi's
classic `Agent`, to its durable `AgentHarness` (`replay: "safe"`, Restate makes any
replay safe) and to the coding agent's `ToolDefinition`.

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

## The example

The object key is the pi session. Each `prompt` is one durable turn. `steer` is a
shared handler that hands the note to the running turn and waits until the turn
confirms it took it. A note is never lost: one that arrives after pi finished starts a
follow-up turn inside the invocation, and one that no turn takes (the session is idle,
or the turn ended first) becomes the next `prompt`. The conversation lives in object
state as one entry per turn, so a turn only writes what it added.

| Object | pi layer | What is durable |
| --- | --- | --- |
| `piAgent` | `Agent` from `pi-agent-core` | every model call and tool call is a journaled step; the transcript lives in object state |
| `piHarness` | `AgentHarness`, pi's own durable runtime | Restate is the "serving layer" its spec describes: `accept`, loop on `drive`, and every wait the harness reports (retry backoff, deferred response) becomes a Restate timer; the conversation tree lives in object state |
| `piCoding` | `createAgentSession` from `pi-coding-agent` | pi's real `read`/`bash`/`edit`/`write` tools run as journaled steps in a per-session workspace under `.pi-workspaces/`; a failing command comes back to pi as an error result; session entries live in object state |

`piCoding` runs pi's tools directly on the host, with no sandbox, so with a real model
it refuses to start unless `PI_CODING_HOST_ACCESS=1`. Tool results are journaled but
the workspace files are not, so a session belongs to the host that ran it.

### Run

Prerequisites: Node.js 22.19+, pnpm, a Restate server. An OpenAI API key is optional.

```bash
pnpm install

# a Restate server, in a second terminal (pick one)
npx @restatedev/restate-server
# docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:latest

# Model: OPENAI_API_KEY → OpenAI through pi-ai (OPENAI_MODEL, default gpt-5.6-luna).
# No key, or PI_PROVIDER=faux → pi-ai's faux provider driven by a transcript-based
# script: deterministic, replay-safe, no network.
export OPENAI_API_KEY=sk-...
PI_TOOL_DELAY_MS=6000 pnpm dev            # serves the example from the library's sources; deploy/test park on a 6s durable timer

# register once (with the Docker server, register http://host.docker.internal:9080 instead)
npx @restatedev/restate deployments register http://localhost:9080
```

Every `prompt` takes `{"message": "..."}`; `{}` uses the object's default prompt.

```bash
curl localhost:8080/piAgent/demo/prompt --json '{}'
curl localhost:8080/piAgent/demo/prompt --json '{"message":"Please also run the linter."}'
curl localhost:8080/piAgent/demo/transcript --json '{}'   # or: curl -X POST … with no body

# steer a running turn: send, steer while the slow tools sleep, attach for the answer
ID=$(curl -s localhost:8080/piAgent/s1/prompt/send --json '{}' | jq -r .invocationId)
curl localhost:8080/piAgent/s1/steer --json '{"note":"Please also run the linter."}'
curl localhost:8080/restate/invocation/$ID/attach

curl localhost:8080/piHarness/demo/prompt --json '{}'
curl localhost:8080/piCoding/demo/prompt --json '{"message":"Create hello.txt with a greeting, then list the directory."}'
```

Kill the service mid-turn and restart it: the log shows `Replaying invocation`, pi's
loop re-runs, journaled steps return without re-executing, elapsed timers fire at once,
and the turn completes with the same tool call ids and the same answer.

Environment: `PORT` (default 9080), `PI_PROVIDER` (`openai` | `faux`), `OPENAI_MODEL`,
`PI_WORKSPACE_ROOT` (default `./.pi-workspaces`), `PI_CODING_HOST_ACCESS=1` (let
`piCoding` run pi's tools on this host with a real model). Demo knobs: `PI_TOOL_DELAY_MS` parks
deploy/test on a durable timer, `PI_FINISH_DELAY_MS` holds a turn open after pi's last
answer so a late steer can be observed, `PI_DEFERRED=1` makes `piHarness` ask the
provider for deferred responses, which suspends the run, sleeps durably and polls.

## The other examples

Both run on pi-ai's faux model through `scriptedModel`, so they need no API key.

**Approval** (`examples/approval`). `releaseAgent`'s `deploy` tool, for production,
creates an awakeable, records it in object state and waits for `approve`, `reject` or a
deadline. The wait holds no process: the invocation is suspended until someone decides.

```bash
pnpm --filter @restate-pi/example-approval dev
ID=$(curl -s localhost:8080/releaseAgent/r1/prompt/send --json '{"message": "Ship v2.1 to production"}' | jq -r .invocationId)
curl localhost:8080/releaseAgent/r1/pending --json '{}'
curl localhost:8080/releaseAgent/r1/approve --json '{"by": "sam"}'
curl localhost:8080/restate/invocation/$ID/attach
```

**Delegation** (`examples/delegation`). `lead` and `researcher` are services, each
call one pi agent. The lead's `ask_researcher` tool is a Restate call to `researcher`,
and pi runs the model's tool calls in parallel, so one reply fans out to two durable
sub-agents.

```bash
pnpm --filter @restate-pi/example-delegation dev
curl localhost:8080/lead/brief --json '{"goal": "Should we run pi on Restate?"}'
```

## Tests

`pnpm test` runs the library's unit tests (the mailbox's ordering, replay, divergence
and idle rules) and each example's integration tests against a Restate server in
Docker, started by `@restatedev/restate-sdk-testcontainers`. The virtual-object suite
covers turns, steering (mid-turn, twice, late, idle, stale), the deferred path and
failing commands, and runs the three objects again on a server that suspends and
replays after every journal entry. `RESTATE_IMAGE` picks the server image.

## Scripts

| Command | |
| --- | --- |
| `pnpm build` | `tsc -b`: the library, then the examples |
| `pnpm typecheck` | build, then check the tests |
| `pnpm test` | unit tests, then the Docker integration tests |
| `pnpm dev` | serve the virtual-object example from the library's sources, with a file watcher |
| `pnpm start` | build, then serve the virtual-object example |
