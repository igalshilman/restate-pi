// The high-level flavor: pi's classic `Agent` without the plumbing.
//
// `runAgent` is one pi turn as an Operation, for any handler. `agentObject` is a
// ready virtual object for a pi session: prompt, steer and transcript, with the
// conversation in object state. Both are built from the mailbox, `servePi` and
// the session helpers, which stay available for anything these do not cover.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {Agent, type AgentEvent, type AgentMessage} from "@earendil-works/pi-agent-core";
import type {Api, Model, Models} from "@earendil-works/pi-ai";
import {Mailbox} from "./mailbox.js";
import {durableStreamFn, type AskModelOptions} from "./model.js";
import {runPi, servePi, serveRequest} from "./loop.js";
import {appendHistory, currentTurn, loadHistory, steerHandler} from "./session.js";
import {toAgentTool, type GenTool} from "./tools.js";
import {lastAssistantText} from "./transcript.js";

/** A model and the runtime that serves it. `scriptedModel` returns one. */
export interface AgentModel {
  models: Models;
  model: Model<Api>;
}

export interface AgentOptions {
  systemPrompt: string;
  tools?: readonly GenTool[];
  /** Retry policy for each model call. Defaults to three attempts. */
  retry?: AskModelOptions["retry"];
  /** pi's lifecycle events: tool starts and ends, messages, the end of a run. */
  onEvent?(event: AgentEvent): void;
  /** Awaited after each pi turn, before it is reported. A demo can hold a turn open here. */
  onTurnEnd?(): Promise<void>;
  /** Diagnostics from the loop: requests, steers, failures. */
  log?(line: string): void;
}

export interface RunAgentOptions extends AgentOptions {
  model: AgentModel;
  message: string;
  /** Earlier messages the conversation continues from. */
  history?: readonly AgentMessage[];
}

export interface AgentRun {
  /** The last assistant text. */
  text: string;
  /** The messages this run added, steers and follow-up turns included. */
  added: AgentMessage[];
}

/**
 * One pi turn in this invocation: `message` in, pi's answer out. Every model
 * call and tool call is a journaled step. Steers sent to this invocation (see
 * `steerTurn`) reach pi while it works; one that arrives after pi finished
 * starts a follow-up turn, and the last turn's answer is returned.
 */
export function* runAgent(opts: RunAgentOptions): restate.Operation<AgentRun> {
  const mailbox = new Mailbox();
  const tools = opts.tools ?? [];
  const history = [...(opts.history ?? [])];
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model.model,
      tools: tools.map((t) => toAgentTool(mailbox, t)),
      messages: history,
    },
    streamFn: durableStreamFn(mailbox),
  });
  if (opts.onEvent) agent.subscribe(opts.onEvent);

  const turn = (text: string) =>
    runPi<AgentRun>(mailbox, async () => {
      await agent.prompt(text);
      await opts.onTurnEnd?.();
      return {text: lastAssistantText(agent.state.messages), added: agent.state.messages.slice(history.length)};
    });
  turn(opts.message);

  return yield* servePi<AgentRun>(mailbox, {
    serve: (request) => serveRequest(request, {mailbox, models: opts.model.models, tools, ...(opts.retry ? {retry: opts.retry} : {})}),
    onSteer: (note) => agent.steer({role: "user", content: note, timestamp: Date.now()}),
    onLateSteer: (notes) => turn(notes.join("\n")),
    ...(opts.log ? {log: opts.log} : {}),
  });
}

export interface AgentObjectOptions<H> extends AgentOptions {
  name: string;
  description?: string;
  /** The model for one turn. Called on every turn: a model setup belongs to one invocation. */
  model(): AgentModel;
  /** Used when `prompt` gets no message. Without it, a message is required. */
  defaultMessage?: string;
  /** More handlers on the same object. They share its state and can use `currentTurn` and friends. */
  handlers?: H;
  /** Handler options by name, e.g. `{approve: {shared: true}}`. */
  handlerOptions?: Partial<Record<keyof H, restate.GenObjectHandlerOpts>>;
}

/**
 * A virtual object for pi sessions, keyed by session:
 * - `prompt({message})` runs one durable turn and returns pi's answer;
 * - `steer({note})` (shared) hands a note to the running turn, or starts the next turn with it;
 * - `transcript()` (shared) returns the conversation.
 */
export function agentObject<const H extends Record<string, restate.HandlerOrHandlerDescriptor> = {}>(opts: AgentObjectOptions<H>) {
  function* prompt(input: {message?: string} | undefined): restate.Operation<string> {
    const message = input?.message ?? opts.defaultMessage;
    if (!message) throw new TerminalError("prompt needs a message", {errorCode: 400});
    const history = yield* loadHistory<AgentMessage>(restate.state());
    const run = yield* currentTurn(runAgent({...opts, model: opts.model(), message, history}));
    yield* appendHistory(run.added);
    return run.text;
  }

  function* transcript(): restate.Operation<AgentMessage[]> {
    return yield* loadHistory<AgentMessage>(restate.sharedState());
  }

  const handlers = {prompt, steer: steerHandler(opts.name), transcript, ...(opts.handlers ?? ({} as H))};
  const handlerOptions = {steer: {shared: true}, transcript: {shared: true}, ...opts.handlerOptions};
  return restate.object({
    name: opts.name,
    ...(opts.description ? {description: opts.description} : {}),
    handlers,
    options: {handlers: handlerOptions as Partial<Record<keyof typeof handlers, restate.GenObjectHandlerOpts>>},
  });
}
