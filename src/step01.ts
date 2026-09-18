// step01 — the durable loop
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   curl localhost:8080/step01/run --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}'

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {llm} from "./llm-openai.js";
import {connect} from "./sandbox.js";
import {runTool, toolLabel} from "./tools.js";
import type {Message} from "./types.js";

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn01(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const futures = action.calls.map((call) =>
      restate.run(
        async () => ({id: call.id, result: await runTool(call, sandbox)}),
        {name: toolLabel(call)},
      ),
    );
    const results = yield* restate.all(futures);
    messages.push({role: "tool", results});
  }
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step01 = restate.service({
  name: "step01",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then deploy it to staging and run the e2e test suite concurrently. Wait for both results before summarizing.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn01(message),
    ),
  },
});
