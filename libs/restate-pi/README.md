# restate-pi

Run [pi](https://github.com/badlogic/pi-mono)'s agent loop inside Restate durable
execution, on the generator SDK. pi's loop stays untouched. Its model calls and tool
calls become journaled Restate steps.

The library has two layers. Most code only needs the high-level one:

- **High level.** `agentObject` gives you a ready-made virtual object for a pi
  session. `runAgent` runs one pi turn inside any handler.
- **Building blocks.** The mailbox, `servePi` and the adapters those two are built
  from. Use them when you host a different pi layer (the `AgentHarness`, the coding
  agent) or need control the high-level API doesn't give.

## Install

Releases are published on GitHub. Install one straight from its release:

```bash
npm install https://github.com/igalshilman/restate-pi/releases/download/v0.1.0/restate-pi-0.1.0.tgz \
  @restatedev/restate-sdk @restatedev/restate-sdk-gen \
  @earendil-works/pi-agent-core @earendil-works/pi-ai typebox
```

The same URL works with `pnpm add` and `yarn add`. The package is still named
`restate-pi`, so imports are `from "restate-pi"`.

Everything except `restate-pi` is a peer dependency, so your app controls those
versions. restate-pi needs Node.js 22.19 or newer.

## A pi session as a virtual object

```ts
import {agentObject, scriptedModel, tool, textResult} from "restate-pi";

export const releaseBot = agentObject({
  name: "releaseBot",
  systemPrompt: "You ship releases.",
  model: () => ({models, model}),      // called for every turn
  tools: [deploy, test],               // generator tools, see below
});
```

The object key is the session. The object has three handlers:

| Handler | What it does |
| --- | --- |
| `prompt({message})` | Runs one durable turn and returns pi's answer. The conversation is kept in object state, one entry per turn, so the next prompt continues it. |
| `steer({note})` | Shared. Hands the note to the running turn and waits for the turn to confirm it. A note that arrives after pi finished starts a follow-up turn. A note that no turn takes starts the next `prompt`. |
| `transcript()` | Shared. Returns the conversation. |

To add your own handlers, pass `handlers` and `handlerOptions`. They share the
object's state, which is how the approval example adds `pending`, `approve` and
`reject`.

`model` is a factory rather than a value because a model setup belongs to a single
invocation, so the object builds a new one for every turn. Other options:
- `defaultMessage` is used when `prompt` is called without a message;
- `onEvent` receives pi's lifecycle events;
- `onTurnEnd` runs at the end of each turn;
- `retry` sets the retry policy for model calls;
- `log` receives diagnostics from the loop.

## One pi turn in any handler

```ts
import {runAgent} from "restate-pi";

function* brief({goal}: {goal: string}): restate.Operation<string> {
  const {text} = yield* runAgent({
    systemPrompt: "You write short briefs.",
    model: {models, model},
    tools: [askResearcher],
    message: goal,
    history,                          // optional: earlier messages to continue from
  });
  return text;
}
```

`runAgent` returns the answer (`text`) and the messages the run added (`added`), so
you can store the conversation wherever you like. It works in services, objects and
workflows. It also listens for steers sent to the invocation with `steerTurn`.

## Tools

A tool is a generator function returning a Restate `Operation`. Its body can `run` a
side effect, `sleep`, `call` another service, `select` over futures, or wait on an
`awakeable`.

```ts
export const deploy = tool({
  name: "deploy",
  label: "Deploy build",
  description: "Deploy the current build to an environment.",
  parameters: Type.Object({env: Type.String()}),
  *execute({env}, call) {
    return textResult(yield* restate.run(() => deployTo(env), {name: `Deploy to ${env}`}));
  },
});
```

Pi's own tools become generator tools through `fromAgentTool`. Each call is one
journaled step, and a thrown error (a non-zero exit, a missing file) is recorded and
handed to pi as an error result instead of being retried.

## For tests and demos

`scriptedModel(script)` is pi-ai's fake provider, answered by `script(context)`
instead of a queue. The same transcript always gets the same reply, so runs are
deterministic, replay cleanly, and need no API key. It also supports deferred
responses: the reply travels inside the journaled handle, so a replay in another
process can still poll it.

## Building blocks

| Export | What it does |
| --- | --- |
| `Mailbox` | The seam between pi and Restate. pi posts request descriptors and awaits answers. The handler takes them with `next()` inside `run` and answers with `answer(seq, value)`; `complete` and `crash` end a turn. If pi, on replay, asks for something other than what the journal recorded, the invocation fails. |
| `servePi(mailbox, options)` | The handler's loop: a single `select` over pi's next request, the `steer` signal and every task in flight. A steer is delivered only while pi waits on a request, and `onLateSteer` turns late notes into a follow-up turn. Once pi is only waiting on answers and has gone quiet (`idleAfterMs`, default 50 ms), the loop stops listening to pi so long waits can suspend. Throws a `TerminalError` if pi reports a failure. |
| `serveRequest(request, options)` | The default way to serve a request: the model call, the matching tool, or a durable wait for the harness. |
| `runPi(mailbox, work)` | pi's side: runs the turn's async work and reports its outcome. Turns on one mailbox run one after another, so a follow-up turn never starts inside a turn that pi is still re-running on replay. |
| `steerTurn(invocationId, note)` | Sends a steer and waits for the turn to acknowledge it. Returns `true` once the note is in pi, and `false` if the turn dropped it or ended without taking it, so the caller can start a new turn. |
| `toAgentTool`, `toHarnessTool` | Adapt a generator tool to pi's classic `Agent` or to its `AgentHarness`. |
| `durableStreamFn(mailbox)`, `durableModels(mailbox, real)` | Route pi's model calls through the mailbox. `durableStreamFn` is a `streamFn` for `Agent`; `durableModels` wraps a `Models` or `ModelRuntime`. |
| `askModel(mailbox, real, seq, options?)` | The real provider call, as one journaled step with a retry policy. |
| `driveToSettlement`, `captureSession`, `restoreSession`, `messagesOf` | Host pi's `AgentHarness`: accept an operation, drive it with Restate timers for every wait, and move the session tree in and out of object state. |
| `currentTurn`, `steerHandler`, `loadHistory`, `appendHistory` | The session helpers `agentObject` is built from, for hand-written objects around another pi layer. |
| `lastAssistantText`, `contentText` | Read text out of pi messages. |

The examples, end-to-end tests and design notes live in the
[repository](https://github.com/igalshilman/restate-pi). MIT licensed.
