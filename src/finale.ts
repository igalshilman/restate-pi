// finale — humanApproval — a person inside one tool call
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   ID=$(curl -s localhost:8080/finale/run/send --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}' | jq -r .invocationId)
//   # steer while the deploy waits for approval — there is no time limit
//   curl localhost:8080/finale/steer --json "{\"invocationId\": \"$ID\", \"note\": \"Please also run the linter.\"}"
//   # approve last; the log prints the waiting call's id
//   curl localhost:8080/finale/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"<call id from the log>\", \"decision\": \"approved\"}"
//   curl localhost:8080/restate/invocation/$ID/attach

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {steer, turn06} from "./step06.js";
import {evaluateGuard, notifyApprover, runTool, toolLabel} from "./tools.js";
import {invocationIdSchema} from "./schemas.js";
import type {ToolCall, ToolResult, SandboxRef} from "./types.js";

// ---------------------------------------------------------------------------
// Durable building blocks
// ---------------------------------------------------------------------------

/** A human-in-the-loop gate: a journaled notify step, then a
 * park on a signal named after the call id — so any number of approvals can
 * be pending at once and the approver resolves exactly the one they mean.
 * If the human takes three days, the turn suspends: nothing polls, nothing
 * times out, no process is pinned. */
function* humanApproval(call: ToolCall): restate.Operation<string> {
  const invocationId = restate.handlerRequest().id;
  yield* restate.run(async () => notifyApprover(call, invocationId), {
    name: `Request approval: ${toolLabel(call)}`,
  });
  return yield* restate.signal<string>(`approval-${call.id}`);
}

/** The same pipeline as step03..06, with `humanApproval` dropped in front of
 * the tool run. It plugs into the unchanged steering loop from step06. */
function* performCall(
  call: ToolCall,
  sandbox: SandboxRef,
): restate.Operation<ToolResult> {
  const allowed = yield* restate.run(async () => evaluateGuard(call), {
    name: `Check guardrail: ${toolLabel(call)}`,
  });
  if (!allowed) {
    return {id: call.id, result: "blocked by guardrail"};
  }

  // deploys need a person: park this one task until the decision lands
  if (call.toolName === "deploy") {
    const decision = yield* humanApproval(call);
    if (decision !== "approved") {
      return {id: call.id, result: `denied by human: ${decision}`};
    }
  }

  const result = yield* restate.run(async () => runTool(call, sandbox), {
    name: toolLabel(call),
  });
  return {id: call.id, result};
}

// ---------------------------------------------------------------------------
// Send side — from anywhere outside the turn, addressed by its invocation id
// ---------------------------------------------------------------------------

/** Approve or deny one pending tool call of a running turn. Same one-liner as
 * steering; the signal name carries the call id. */
function* approve({
  invocationId,
  callId,
  decision,
}: {
  invocationId: string;
  callId: string;
  decision: string;
}): restate.Operation<void> {
  restate
    .invocation(invocationId)
    .signal<string>(`approval-${callId}`)
    .resolve(decision);
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const finale = restate.service({
  name: "finale",
  handlers: {
    run: restate.schemas(
      {
        input: z.object({
          message: z.string().default(
            "Ship the new build: find out how we deploy, then request a staging deploy and the e2e test suite together. The deploy needs human approval; keep working on the tests while it waits. Incorporate any follow-up instructions and wait for every real result before summarizing.",
          ),
        }),
        output: z.string(),
      },
      ({message}) => turn06(message, performCall),
    ),
    steer: restate.schemas(
      {
        input: z.object({
          invocationId: invocationIdSchema.describe("The invocationId returned by /finale/run/send."),
          note: z.string().default("Please also run the linter."),
        }),
        output: z.void(),
      },
      steer,
    ),
    approve: restate.schemas(
      {
        input: z.object({
          invocationId: invocationIdSchema.describe("The invocationId returned by /finale/run/send."),
          callId: z.string().min(1).describe("The tool call id printed in the approval log."),
          decision: z.string().default("approved"),
        }),
        output: z.void(),
      },
      approve,
    ),
  },
});
