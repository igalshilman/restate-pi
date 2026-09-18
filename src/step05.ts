// step05 — the fully task-based loop
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   curl localhost:8080/step05/run --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}'

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {llm} from "./llm-openai.js";
import {connect} from "./sandbox.js";
import {performCall} from "./step03.js";
import type {ToolResult, Message} from "./types.js";

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn05(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  /** Everything in flight, keyed by call id. */
  const tasks = new Map<string, restate.Future<ToolResult>>();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    // every requested call becomes a tracked task, acked immediately —
    // the model may also request nothing and just wait on its tasks.
    for (const call of action.calls) {
      tasks.set(call.id, restate.spawn(performCall(call, sandbox)));
    }
    messages.push({
      role: "tool",
      results: action.calls.map(({id}) => ({id, result: "task created"})),
    });

    // re-activate the model as soon as the next task completes: the
    // winning tag is the call id, its future holds the result.
    const next = yield* restate.select(Object.fromEntries(tasks));
    tasks.delete(next.tag);
    messages.push({role: "tool", results: [yield* next.future]});
  }
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step05 = restate.service({
  name: "step05",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then start a staging deploy and the e2e test suite together. As soon as either finishes, run the linter without waiting for the other. Wait for every real result before summarizing.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn05(message),
    ),
  },
});
