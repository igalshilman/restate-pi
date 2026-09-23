// The release tools pi can call, written as generator functions returning a
// Restate Operation. Each call is a guard step, an optional durable timer and
// then the effect, every one a journaled `run`. Only the model is real: the
// effects below log what they would do and take a little time.

import * as restate from "@restatedev/restate-sdk-gen";
import {Type} from "typebox";
import {textResult, tool, type GenTool, type ToolCallInfo} from "restate-pi";
import {log} from "./log.js";

/** Simulated slow work for deploy/test, as a durable timer (PI_TOOL_DELAY_MS). */
const SLOW_MS = Number(process.env.PI_TOOL_DELAY_MS ?? 0);

type Call = {id: string; name: string; args: Record<string, unknown>};

/** Readable names shared by the Restate timeline and terminal logs. */
function label(call: Call): string {
  switch (call.name) {
    case "search": return "Search code and docs";
    case "rm_rf": return call.args.path ? `Delete ${call.args.path}` : "Delete files";
    case "deploy": return call.args.env ? `Deploy to ${call.args.env}` : "Deploy build";
    case "test": return call.args.suite ? `Run ${call.args.suite} tests` : "Run tests";
    case "lint": return "Run linter";
    default: return call.name.replaceAll("_", " ");
  }
}

/** The guardrail: anything rm-shaped is blocked. */
async function evaluateGuard(call: Call): Promise<boolean> {
  const allowed = !/^rm/.test(call.name);
  log("guard", `${label(call)} — ${call.id} → ${allowed ? "allowed" : "blocked"}`);
  return allowed;
}

/** Fake effects: deploy takes 300ms, test takes 500ms, everything else is instant.
 * `search` answers with a pointer to the other tools, so a real model knows
 * what to do next instead of searching again. */
async function runEffect(call: Call): Promise<string> {
  const ms = call.name === "deploy" ? 300 : call.name === "test" ? 500 : 0;
  log("tool", `${label(call)} — ${call.id} running${ms ? ` (${ms}ms)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  log("tool", `${label(call)} — ${call.id} done`);
  return call.name === "search"
    ? "found: deploy with the deploy tool (env: staging), run the e2e suite with the test tool, lint with the lint tool"
    : `${call.name} ok`;
}

/** Guard → (durable timer) → effect: the body every release tool shares. */
function* performCall(name: string, call: ToolCallInfo, args: object) {
  const c: Call = {id: call.toolCallId, name, args: args as Record<string, unknown>};
  const title = label(c);
  const allowed = yield* restate.run(async () => evaluateGuard(c), {name: `Check guardrail: ${title}`});
  if (!allowed) return textResult("blocked by guardrail");

  if (SLOW_MS > 0 && (name === "deploy" || name === "test")) {
    log("tool", `${title} — ${c.id} sleeping ${SLOW_MS}ms on a durable timer`);
    yield* restate.sleep(SLOW_MS, `${title}: slow work`);
  }

  return textResult(yield* restate.run(async () => runEffect(c), {name: title}));
}

export const search = tool({
  name: "search",
  label: "Search code and docs",
  description: "Search the codebase and docs.",
  parameters: Type.Object({query: Type.String({description: "What to look for"})}),
  *execute(params, call) {
    return yield* performCall("search", call, params);
  },
});

export const rmRf = tool({
  name: "rm_rf",
  label: "Delete files",
  description: "Recursively delete a path.",
  parameters: Type.Object({path: Type.String()}),
  *execute(params, call) {
    return yield* performCall("rm_rf", call, params);
  },
});

export const deploy = tool({
  name: "deploy",
  label: "Deploy build",
  description: "Deploy the current build to an environment. Slow.",
  parameters: Type.Object({env: Type.String({description: "Target environment, e.g. staging"})}),
  *execute(params, call) {
    return yield* performCall("deploy", call, params);
  },
});

export const test = tool({
  name: "test",
  label: "Run tests",
  description: "Run a test suite. Slow.",
  parameters: Type.Object({suite: Type.String({description: "Suite name, e.g. e2e"})}),
  *execute(params, call) {
    return yield* performCall("test", call, params);
  },
});

export const lint = tool({
  name: "lint",
  label: "Run linter",
  description: "Run the linter.",
  parameters: Type.Object({}),
  *execute(params, call) {
    return yield* performCall("lint", call, params);
  },
});

export const RELEASE_TOOLS: readonly GenTool[] = [search, rmRf, deploy, test, lint];
