// A deterministic model for demos and tests: pi-ai's faux provider, but every
// request is answered by a function of the transcript instead of a queue. A
// replayed or retried call gets the same reply as the original, and no API
// key or network is needed.
//
// Deferred responses carry their reply inside the handle (`handle.data`), the
// way a real provider keeps it server side. The faux provider keeps them in
// process memory instead, which a replay in another process cannot poll.

import {
  createAssistantMessageEventStream,
  createModels,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context as AiContext,
  type DeferredHandle,
  type JsonValue,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";

export interface ScriptedModel {
  /** A runtime with only the scripted provider registered. */
  models: Models;
  model: Model<Api>;
  /** The provider, for runtimes that register providers themselves (the coding agent's `ModelRuntime`). */
  provider: Provider;
}

/** Build a model whose next reply is `script(context)`. Use `fauxAssistantMessage`, `fauxText` and `fauxToolCall` from pi-ai to write replies. */
export function scriptedModel(script: (context: AiContext) => AssistantMessage): ScriptedModel {
  const faux = fauxProvider();
  const answer = (reply: (context: AiContext) => AssistantMessage) => faux.setResponses([(context) => reply(context)]);
  const provider: Provider = {
    ...faux.provider,
    stream(model, context, options) {
      if ((options as {deferred?: unknown} | undefined)?.deferred) return deferred(model, script(context));
      answer(script);
      return faux.provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      if (options?.deferred) return deferred(model, script(context));
      answer(script);
      return faux.provider.streamSimple(model, context, options);
    },
    fetchDeferred(model, handle, options) {
      const reply = handle.data as unknown as AssistantMessage;
      answer(() => reply);
      return faux.provider.streamSimple(model, {messages: []}, options?.signal ? {signal: options.signal} : undefined);
    },
  };
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel(provider.id, "faux-1");
  if (!model) throw new Error("faux model missing");
  return {models, model, provider};
}

/** A deferred response whose handle carries the reply. */
function deferred(model: Model<Api>, reply: AssistantMessage): AssistantMessageEventStream {
  const handle: DeferredHandle = {
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    id: `scripted-${Date.now()}`,
    pollAfterMs: 1_000,
    data: reply as unknown as JsonValue,
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: "deferred",
    deferred: handle,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({type: "start", partial: message});
    stream.push({type: "done", reason: "deferred", message});
    stream.end(message);
  });
  return stream;
}
