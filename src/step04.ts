// step04 — background tool calls
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   curl localhost:8080/step04/run --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}'

import * as restate from "@restatedev/restate-sdk-gen";
import {gen} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {llm} from "./llm-openai.js";
import {connect} from "./sandbox.js";
import {performCall} from "./step03.js";
import type {ToolResult, Message} from "./types.js";

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn04(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const acks: ToolResult[] = [];
    const tasks: restate.Task<ToolResult>[] = [];
    for (const call of action.calls) {
      if (!call.background) {
        tasks.push(restate.spawn(performCall(call, sandbox)));
        continue;
      }
      // Spawned but NOT awaited this step: the task keeps running while
      // the loop moves on, and appends its own result — possibly during
      // a later step — for the model's next look.
      restate.spawn(
        gen(function* () {
          const result = yield* performCall(call, sandbox);
          messages.push({role: "tool", results: [result]});
        }),
      );
      acks.push({id: call.id, result: "started in background"});
    }
    const results = yield* restate.all(tasks);
    messages.push({role: "tool", results: [...acks, ...results]});
  }
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step04 = restate.service({
  name: "step04",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then start a staging deploy and the e2e test suite with background: true on both calls. While they run, run the linter in the foreground. Wait for all real results before summarizing.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn04(message),
    ),
  },
});
