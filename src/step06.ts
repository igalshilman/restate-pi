// step06 — steering, raced in the same select
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   ID=$(curl -s localhost:8080/step06/run/send --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}' | jq -r .invocationId)
//   curl localhost:8080/step06/steer --json "{\"invocationId\": \"$ID\", \"note\": \"please also run the linter\"}"
//   curl localhost:8080/restate/invocation/$ID/attach

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {llm} from "./llm-openai.js";
import {connect} from "./sandbox.js";
import {performCall as performGuardedCall} from "./step03.js";
import {invocationIdSchema} from "./schemas.js";
import type {ToolResult, Message} from "./types.js";

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

/** The steering loop is reused by the finale with its approval-aware pipeline. */
export function* turn06(
  userMessage: string,
  performCall: typeof performGuardedCall = performGuardedCall,
): restate.Operation<string> {
  const sandbox = yield* connect();

  /** Everything in flight, keyed by call id. */
  const tasks = new Map<string, restate.Future<ToolResult>>();
  /** The next steering note; re-armed after each delivery. */
  let steer = restate.signal<string>("steer");

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    for (const call of action.calls) {
      tasks.set(call.id, restate.spawn(performCall(call, sandbox)));
    }
    messages.push({
      role: "tool",
      results: action.calls.map(({id}) => ({id, result: "task created"})),
    });

    // the steer races the tasks in ONE select — notes and completions
    // land in a single deterministic order, and either wakes the model.
    const next = yield* restate.select({...Object.fromEntries(tasks), steer});
    if (next.tag === "steer") {
      messages.push({role: "user", content: yield* steer});
      steer = restate.signal<string>("steer"); // arm the next note
    } else {
      // a task completed — its tag is the call id
      const result = yield* tasks.get(next.tag)!;
      tasks.delete(next.tag);
      messages.push({role: "tool", results: [result]});
    }
  }
}

// ---------------------------------------------------------------------------
// Send side — from anywhere outside the turn, addressed by its invocation id
// ---------------------------------------------------------------------------

/** Steer a running turn. The id is the turn's invocation id (constant across
 * retries and suspensions), so it's a stable address for a running turn. */
export function* steer({
  invocationId,
  note,
}: {
  invocationId: string;
  note: string;
}): restate.Operation<void> {
  restate.invocation(invocationId).signal<string>("steer").resolve(note);
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step06 = restate.service({
  name: "step06",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then start a staging deploy and the e2e test suite together. Incorporate any follow-up instructions that arrive while they run. Wait for every real result before summarizing.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn06(message),
    ),
    steer: restate.schemas(
      {
        input: z.object({
          invocationId: invocationIdSchema.describe("The invocationId returned by /step06/run/send."),
          note: z.string().default("Please also run the linter."),
        }),
        output: z.void(),
      },
      steer,
    ),
  },
});
