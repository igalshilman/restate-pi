// Fake side effects shared by every stage. The step files show how they are
// composed into durable operations; only the model calls are real.

import {log} from "./log.js";
import type {ToolCall, SandboxRef} from "./types.js";

/** Readable names shared by the Restate timeline and terminal logs. */
export function toolLabel(call: ToolCall): string {
  switch (call.toolName) {
    case "search": return "Search code and docs";
    case "rm_rf": return call.args.path ? `Delete ${call.args.path}` : "Delete files";
    case "deploy": return call.args.env ? `Deploy to ${call.args.env}` : "Deploy build";
    case "test": return call.args.suite ? `Run ${call.args.suite} tests` : "Run tests";
    case "lint": return "Run linter";
    default: return call.toolName.replaceAll("_", " ");
  }
}

/** Fake tools: deploy takes 300ms, test takes 500ms, everything else is instant.
 * `search` answers with a pointer to the other tools, so a real model knows
 * what to do next instead of searching again. */
export async function runTool(call: ToolCall, sandbox: SandboxRef): Promise<string> {
  const ms = call.toolName === "deploy" ? 300 : call.toolName === "test" ? 500 : 0;
  const label = toolLabel(call);
  log("tool", `${label} — ${call.id} running in ${sandbox.id}${ms ? ` (${ms}ms)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  log("tool", `${label} — ${call.id} done`);
  return call.toolName === "search"
    ? "found: deploy with the deploy tool (env: staging), run the e2e suite with the test tool, lint with the lint tool"
    : `${call.toolName} ok`;
}

/** The guardrail: anything rm-shaped is blocked. */
export async function evaluateGuard(call: ToolCall): Promise<boolean> {
  const allowed = !/^rm/.test(call.toolName);
  log("guard", `${toolLabel(call)} — ${call.id} → ${allowed ? "allowed" : "blocked"}`);
  return allowed;
}

/** "Notifies" the approver: prints the command that resolves this approval. */
export async function notifyApprover(call: ToolCall, invocationId: string): Promise<void> {
  log("approver", `${toolLabel(call)} — ${call.id} is waiting for a human. Steer while it waits (no time limit):`);
  log(
    "approver",
    `  curl localhost:8080/finale/steer --json '${JSON.stringify({invocationId, note: "Please also run the linter."})}'`,
  );
  log("approver", "When you are done steering, approve it with:");
  log(
    "approver",
    `  curl localhost:8080/finale/approve --json '${JSON.stringify({invocationId, callId: call.id, decision: "approved"})}'`,
  );
}
