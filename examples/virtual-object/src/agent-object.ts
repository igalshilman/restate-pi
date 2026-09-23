// piAgent — pi-agent-core's classic `Agent`, embedded in a Restate virtual object.
//
//   curl localhost:8080/piAgent/demo/prompt --json '{}'
//   curl localhost:8080/piAgent/demo/steer  --json '{"note": "Please also run the linter."}'
//   curl -X POST localhost:8080/piAgent/demo/transcript
//
// The object key is the pi session. Each `prompt` is one durable turn: pi's
// loop runs unmodified as plain async code, and every model call and tool call
// it makes becomes a journaled Restate step through the mailbox. The
// transcript is kept in object state, one entry per turn, so the next prompt
// continues the conversation. `steer` signals the running turn; a note that
// arrives after pi finished starts a follow-up turn instead.

import * as restate from "@restatedev/restate-sdk-gen";
import {Agent, type AgentMessage} from "@earendil-works/pi-agent-core";
import {Mailbox, durableStreamFn, lastAssistantText, runPi, servePi, serveRequest, toAgentTool} from "restate-pi";
import {appendHistory, loadHistory} from "./history.js";
import {log} from "./log.js";
import {SYSTEM_PROMPT, createModelSetup} from "./models.js";
import {RELEASE_TOOLS} from "./tools.js";
import {RELEASE_PROMPT, currentTurn, finishDelay, logPiEvent, promptSchema, steerHandler, steerSchema} from "./turn.js";

interface Turn {
  text: string;
  /** Messages this invocation added to the transcript. */
  added: AgentMessage[];
}

function* prompt({message}: {message: string}): restate.Operation<string> {
  const history = yield* loadHistory<AgentMessage>(restate.state());
  const known = history.length; // the Agent may extend `history` in place

  const mailbox = new Mailbox();
  const {models, model, kind} = createModelSetup();
  log("pi", `piAgent turn on ${kind} model ${model.id}, ${history.length} messages of history`);

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: RELEASE_TOOLS.map((t) => toAgentTool(mailbox, t)),
      messages: history,
    },
    streamFn: durableStreamFn(mailbox),
  });
  agent.subscribe(logPiEvent);

  // pi's side, plain async: one turn on the same agent per call.
  const turn = (text: string) =>
    runPi<Turn>(mailbox, async () => {
      await agent.prompt(text);
      await finishDelay();
      return {text: lastAssistantText(agent.state.messages), added: agent.state.messages.slice(known)};
    });
  turn(message);

  const result = yield* currentTurn(
    servePi<Turn>(mailbox, {
      serve: (request) => serveRequest(request, {mailbox, models, tools: RELEASE_TOOLS}),
      onSteer: (note) => agent.steer({role: "user", content: note, timestamp: Date.now()}),
      onLateSteer: (notes) => turn(notes.join("\n")),
      log: (line) => log("pi", line),
    }),
  );

  yield* appendHistory(result.added);
  return result.text;
}

function* transcript(): restate.Operation<AgentMessage[]> {
  return yield* loadHistory<AgentMessage>(restate.sharedState());
}

export const piAgent = restate.object({
  name: "piAgent",
  description: "pi-agent-core's Agent loop, one durable turn per prompt, transcript in object state.",
  handlers: {
    prompt: restate.schemas(promptSchema(RELEASE_PROMPT), prompt),
    steer: restate.schemas(steerSchema, steerHandler("piAgent")),
    transcript, // no input schema, so an empty body and `{}` both work
  },
  options: {handlers: {steer: {shared: true}, transcript: {shared: true}}},
});
