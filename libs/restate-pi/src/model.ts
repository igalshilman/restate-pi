// The model call. pi asks for a stream; the fiber makes the real request
// inside one journaled step and hands pi a two-event stream built from the
// settled message. On replay the message comes from the journal and no
// provider is contacted.

import * as restate from "@restatedev/restate-sdk-gen";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context as AiContext,
  type DeferredFetchOptions,
  type DeferredHandle,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {StreamFn} from "@earendil-works/pi-agent-core";
import type {Mailbox} from "./mailbox.js";

/** What stays in memory for a model request: the real call's arguments. */
export type ModelPayload =
  | {mode: "stream"; model: Model<Api>; context: AiContext; options: SimpleStreamOptions | undefined}
  | {mode: "deferred"; model: Model<Api>; handle: DeferredHandle; options: DeferredFetchOptions | undefined};

/** pi side: a `streamFn` for the classic `Agent`. */
export function durableStreamFn(mailbox: Mailbox): StreamFn {
  return (model, context, options) => request(mailbox, {mode: "stream", model, context, options});
}

/** pi side: a `Models` whose provider calls defer to the fiber. Everything
 * else (catalog, auth, lookups) is the real object. */
export function durableModels<M extends Models>(mailbox: Mailbox, real: M): M {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "streamSimple") {
        return (model: Model<Api>, context: AiContext, options?: SimpleStreamOptions) =>
          request(mailbox, {mode: "stream", model, context, options});
      }
      if (property === "streamDeferred") {
        return (model: Model<Api>, handle: DeferredHandle, options?: DeferredFetchOptions) =>
          request(mailbox, {mode: "deferred", model, handle, options});
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function request(mailbox: Mailbox, payload: ModelPayload): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  mailbox
    .post<AssistantMessage>(
      {kind: "model", model: `${payload.model.provider}/${payload.model.id}`, mode: payload.mode},
      payload,
    )
    .then(
      (message) => settle(stream, message),
      (error: unknown) => settle(stream, failure(payload.model, error)),
    );
  return stream;
}

/** Two events, start then done (or error), from an already-settled message. */
function settle(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  stream.push({type: "start", partial: {...message, content: [], stopReason: "pending"}});
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({type: "error", reason: message.stopReason, error: message});
  } else {
    stream.push({type: "done", reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred", message});
  }
  stream.end();
}

function failure(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export interface AskModelOptions {
  /** Retry policy for the journaled request. Defaults to three attempts. */
  retry?: restate.RetryOptions;
  /** Observe live stream events on first execution, e.g. to forward tokens. Never called on replay. */
  onEvent?(event: AssistantMessageEvent): void;
}

/** Fiber side: one journaled step per model call. Provider errors throw so
 * Restate retries; the settled message is what pi sees, first time and on
 * every replay. */
export function* askModel(
  mailbox: Mailbox,
  real: Models,
  seq: number,
  options: AskModelOptions = {},
): restate.Operation<AssistantMessage> {
  return yield* restate.run(
    async ({signal}) => {
      const payload = await mailbox.payload<ModelPayload>(seq);
      const stream =
        payload.mode === "stream"
          ? real.streamSimple(payload.model, payload.context, {...payload.options, signal})
          : real.streamDeferred(payload.model, payload.handle, {...payload.options, signal});
      for await (const event of stream) options.onEvent?.(event);
      const message = await stream.result();
      if (message.stopReason === "error") throw new Error(message.errorMessage ?? "provider error");
      return message;
    },
    {name: "Ask model", retry: options.retry ?? {maxAttempts: 3, initialInterval: 500}},
  );
}
