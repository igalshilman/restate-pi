// piAgent — pi-agent-core's classic `Agent` as a Restate virtual object, in one
// call to `agentObject`.
//
//   curl localhost:8080/piAgent/demo/prompt --json '{}'
//   curl localhost:8080/piAgent/demo/steer  --json '{"note": "Please also run the linter."}'
//   curl localhost:8080/piAgent/demo/transcript --json '{}'
//
// The object key is the pi session. Each `prompt` is one durable turn: pi's
// loop runs unmodified, and every model call and tool call it makes becomes a
// journaled Restate step. The transcript is kept in object state, one entry per
// turn, so the next prompt continues the conversation. `steer` hands a note to
// the running turn; a note no turn takes starts the next one.

import {agentObject} from "restate-pi";
import {log} from "./log.js";
import {SYSTEM_PROMPT, createModelSetup} from "./models.js";
import {RELEASE_TOOLS} from "./tools.js";
import {RELEASE_PROMPT, finishDelay, logPiEvent} from "./turn.js";

export const piAgent = agentObject({
  name: "piAgent",
  description: "pi-agent-core's Agent loop, one durable turn per prompt, transcript in object state.",
  systemPrompt: SYSTEM_PROMPT,
  model: () => {
    const setup = createModelSetup();
    log("pi", `piAgent turn on ${setup.kind} model ${setup.model.id}`);
    return setup;
  },
  tools: RELEASE_TOOLS,
  defaultMessage: RELEASE_PROMPT,
  onEvent: logPiEvent,
  onTurnEnd: finishDelay,
  log: (line) => log("pi", line),
});
