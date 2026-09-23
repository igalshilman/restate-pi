# restate-pi

Embed [pi](https://github.com/badlogic/pi-mono) in Restate durable execution on the
generator SDK. pi's loop stays untouched; its model calls and tool calls become
journaled steps served by a fiber.

```ts
import * as restate from "@restatedev/restate-sdk-gen";
import {Agent} from "@earendil-works/pi-agent-core";
import {Mailbox, durableStreamFn, runPi, servePi, serveRequest, toAgentTool, lastAssistantText} from "restate-pi";

function* prompt({message}: {message: string}): restate.Operation<string> {
  const mailbox = new Mailbox();
  const agent = new Agent({
    initialState: {systemPrompt, model, tools: TOOLS.map((t) => toAgentTool(mailbox, t))},
    streamFn: durableStreamFn(mailbox),
  });

  runPi(mailbox, async () => {                       // pi's side: plain async
    await agent.prompt(message);
    return lastAssistantText(agent.state.messages);
  });

  return yield* servePi<string>(mailbox, {            // the fiber: serves what pi asks for
    serve: (request) => serveRequest(request, {mailbox, models, tools: TOOLS}),
    onSteer: (note) => agent.steer({role: "user", content: note, timestamp: Date.now()}),
  });
}
```

## API

| | |
| --- | --- |
| `Mailbox` | the seam. pi posts request descriptors and awaits answers; the fiber takes them with `next()` inside `run`, answers with `answer(seq, value)`. `complete`/`crash` end a turn. A request pi issues differently than the journal recorded fails the invocation. |
| `tool(definition)`, `GenTool` | a pi tool whose `execute(params, call)` is a generator returning a Restate `Operation`. `textResult(text)` builds a plain result. |
| `toAgentTool`, `toHarnessTool` | adapt one `GenTool` to pi's classic `Agent` or to its durable `AgentHarness` (`replay: "safe"`). |
| `fromAgentTool(tool)` | one of pi's own tools (the coding agent's read/bash/edit/write) as a `GenTool`: one journaled step per call, and a thrown error (a non-zero exit, a missing file) is journaled and reported to pi as an error result instead of being retried. |
| `durableStreamFn(mailbox)` | a `streamFn` for `Agent`: each model call is a request to the fiber, answered with a settled message replayed as a two-event stream. |
| `durableModels(mailbox, real)` | a `Models` (or `ModelRuntime`) whose `streamSimple` and `streamDeferred` defer to the fiber; everything else is the real object. |
| `askModel(mailbox, real, seq, options?)` | fiber side: the real provider call inside one journaled `run`, with a retry policy and an optional live-event hook. |
| `servePi(mailbox, options)` | the fiber loop: one `select` over pi's next request, the `steer` signal and every task in flight. Delivers steers only while pi is blocked on a request; with `onLateSteer`, notes that arrive after pi finished start a follow-up turn. While pi is parked on answers it stops waiting on pi (`idleAfterMs`, default 50 ms), so long waits suspend. Throws a `TerminalError` if pi reported a failure. |
| `steerTurn(invocationId, note)` | the sender's side of steering: signal the turn with an acknowledgement awakeable and wait. `true` once the note is in pi; `false` if the turn dropped it or ended without taking it, so the caller can start a new turn with it. |
| `serveRequest(request, options)` | default serving: `askModel` for model calls, the matching `GenTool` for tool calls, a journaled delay plus `sleep` for harness waits. |
| `runPi(mailbox, work)` | pi side: run the turn's async work and report its outcome to the fiber. |
| `driveToSettlement({lane, request, mailbox})` | host pi's `AgentHarness`: `accept`, then loop on `drive`, turning each reported wait into a fiber request (a Restate timer). |
| `captureSession`, `restoreSession`, `messagesOf` | move a harness session's conversation tree in and out of the process through the public `Session` API, so it can live in object state. |
| `lastAssistantText(messages)`, `contentText(content)` | the last assistant text in a pi transcript; the text of one message's content. |
| `scriptedModel(script)` | pi-ai's faux provider answered by `script(context)`: a deterministic, replay-safe model for demos and tests. |

Peer dependencies: `@restatedev/restate-sdk`, `@restatedev/restate-sdk-gen`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `typebox`.
