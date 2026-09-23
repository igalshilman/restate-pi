// Tools are generator functions returning a Restate Operation. One definition
// adapts to pi's classic `Agent` and to the durable `AgentHarness`; the coding
// agent's `ToolDefinition` shape is the same two lines in an application.
// `fromAgentTool` goes the other way, for tools pi already ships.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import type {AgentHarnessTool, AgentTool, AgentToolResult} from "@earendil-works/pi-agent-core";
import type {Static, TSchema} from "typebox";
import type {Mailbox} from "./mailbox.js";

export interface ToolCallInfo {
  /** The model's call id, unique within its batch. */
  toolCallId: string;
  /** The tool's human-readable label, handy for journal entry names. */
  label: string;
}

/** A pi tool whose body is a Restate Operation: `run`, `spawn`, `sleep`, `awakeable`, … */
export interface GenTool<P extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  execute(params: Static<P>, call: ToolCallInfo): restate.Operation<AgentToolResult<unknown>>;
}

/** Identity with inference: `tool({parameters: Type.Object({...}), *execute(params) {...}})`. */
export function tool<P extends TSchema>(definition: GenTool<P>): GenTool<P> {
  return definition;
}

/** A plain text tool result. */
export function textResult(text: string): AgentToolResult<unknown> {
  return {content: [{type: "text", text}], details: {}};
}

/**
 * One of pi's own tools (the coding agent's read/bash/edit/write, say) as a
 * GenTool: one journaled step per call. pi tools report failure by throwing (a
 * non-zero exit, a missing file). That outcome is journaled and rethrown
 * outside the step, so pi records an error tool result instead of Restate
 * retrying a command that fails the same way every time.
 */
export function fromAgentTool(t: AgentTool<any>): GenTool {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    *execute(params, call) {
      const outcome = yield* restate.run(
        async ({signal}) => {
          try {
            return {ok: true as const, result: await t.execute(call.toolCallId, params, signal)};
          } catch (error) {
            if (signal.aborted) throw error; // cancellation is Restate's, not the tool's
            return {ok: false as const, error: error instanceof Error ? error.message : String(error)};
          }
        },
        {name: t.label},
      );
      if (!outcome.ok) throw new TerminalError(outcome.error);
      return outcome.result;
    },
  };
}

/** Adapter for pi-agent-core's classic `Agent`. */
export function toAgentTool(mailbox: Mailbox, t: GenTool): AgentTool<any> {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: (toolCallId, params) =>
      mailbox.post<AgentToolResult<unknown>>({kind: "tool", name: t.name, toolCallId, params}),
  };
}

/** Adapter for the durable `AgentHarness`. Restate makes any replay safe. */
export function toHarnessTool(mailbox: Mailbox, t: GenTool): AgentHarnessTool<undefined> {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    replay: "safe",
    execute: (toolCallId, params) =>
      mailbox.post<AgentToolResult<unknown>>({kind: "tool", name: t.name, toolCallId, params}),
  };
}
