// Shared by the three objects.
//
// Steering: the running turn records its invocation id in state; the shared
// `steer` handler reads it and hands the note to that turn with `steerTurn`,
// so a note is addressed by session key, not invocation id. If no turn is
// running, or the turn ends without taking the note, the note becomes the next
// turn: the handler sends a `prompt` to its own object.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {steerTurn} from "restate-pi";
import {z} from "zod";
import {log} from "./log.js";

type TurnState = {invocation: string};

/** Run `body` as the object's current turn, so `steer` can find it. The marker
 * is cleared however the turn ends; a retryable error keeps it, since the
 * invocation is still alive and will run again. */
export function* currentTurn<T>(body: restate.Operation<T>): restate.Operation<T> {
  const state = restate.state<TurnState>();
  state.set("invocation", restate.handlerRequest().id);
  try {
    const result = yield* body;
    state.clear("invocation");
    return result;
  } catch (error) {
    if (error instanceof TerminalError) state.clear("invocation");
    throw error;
  }
}

/** The shared `steer` handler for the object called `objectName`, which must have a `prompt({message})` handler. */
export function steerHandler(objectName: string) {
  // Declared as an interface, not a reference to the implementation: the object refers to this handler.
  const target = restate.iface.object(objectName, {prompt: restate.iface.json<{message: string}, string>()});
  return function* steer({note}: {note: string}): restate.Operation<string> {
    const invocation = yield* restate.sharedState<TurnState>().get("invocation");
    if (invocation && (yield* steerTurn(invocation, note))) return `steer delivered to ${invocation}`;
    const key = restate.handlerRequest().key ?? "default";
    const started = yield* restate.sendClient(target, key).prompt({message: note});
    return `no turn took the note; it starts a new turn ${started.id}`;
  };
}

export const steerSchema = {
  input: z.object({note: z.string().default("Please also run the linter.")}),
  output: z.string(),
};

export const promptSchema = (fallback: string) => ({
  input: z.object({message: z.string().default(fallback)}),
  output: z.string(),
});

export const RELEASE_PROMPT =
  "Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds.";

/** Demo knob: PI_FINISH_DELAY_MS holds pi's turn open after its last answer, so a
 * steer can be seen arriving late and starting a follow-up turn. */
export function finishDelay(): Promise<void> {
  const ms = Number(process.env.PI_FINISH_DELAY_MS ?? 0);
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** One line per pi lifecycle event. Accepts events from the Agent, the harness and the coding agent. */
export function logPiEvent(event: {type: string}): void {
  const e = event as {type: string} & Record<string, unknown>;
  switch (e.type) {
    case "tool_execution_start":
    case "tool_start":
      log("pi", `→ ${String(e.toolName)} ${JSON.stringify(e.args ?? {})}`);
      break;
    case "tool_execution_end":
    case "tool_end":
      log("pi", `← ${String(e.toolName)} ${e.isError ? "error" : "ok"}`);
      break;
    case "message_end": {
      const message = e.message as {role?: string; content?: unknown} | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) break;
      const text = (message.content as {type: string; text?: string}[])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!.replaceAll("\n", " "))
        .join(" ");
      if (text) log("pi", `assistant: ${text.slice(0, 200)}`);
      break;
    }
    case "run_suspend":
      log("pi", `run suspended on a deferred response (${String(e.reason)})`);
      break;
    case "retry_scheduled":
      log("pi", `retry in ${String(e.delayMs)}ms: ${String(e.errorMessage)}`);
      break;
    case "run_end":
    case "agent_end":
      log("pi", `${e.type}${e.status ? ` (${String(e.status)})` : ""}`);
      break;
  }
}
