// step02 — a guardrail, and why `spawn` exists
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   curl localhost:8080/step02/run --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}'

import * as restate from "@restatedev/restate-sdk-gen";
import {gen} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {llm} from "./llm-openai.js";
import {connect} from "./sandbox.js";
import {evaluateGuard, runTool, toolLabel} from "./tools.js";
import type {Message} from "./types.js";

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn02(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const tasks = action.calls.map((call) =>
      restate.spawn(
        gen(function* () {
          //
          // first evaluate the guardrail, then run the tool if allowed
          //
          const allowed = yield* restate.run(async () => evaluateGuard(call), {
            name: `Check guardrail: ${toolLabel(call)}`,
          });
          if (!allowed) {
            return {id: call.id, result: "blocked by guardrail"};
          }
          //
          // run the tool if allowed
          //
          const result = yield* restate.run(
            async () => runTool(call, sandbox),
            {name: toolLabel(call)},
          );
          //
          // return a structured result
          //
          return {id: call.id, result};
        }),
      ),
    );

    const results = yield* restate.all(tasks);
    messages.push({role: "tool", results});
  }
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step02 = restate.service({
  name: "step02",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then request a staging deploy, the e2e test suite, and deletion of /tmp/old-builds with rm_rf together. If a tool is blocked, report it and continue with the others.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn02(message),
    ),
  },
});
