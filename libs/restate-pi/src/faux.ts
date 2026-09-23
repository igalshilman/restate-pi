// A deterministic model for demos and tests: pi-ai's faux provider, but every
// request is answered by a function of the transcript instead of a queue. A
// replayed or retried call gets the same reply as the original, and no API
// key or network is needed.

import {
  createModels,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Context as AiContext,
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
  const arm = () => faux.setResponses([(context) => script(context)]);
  const provider: Provider = {
    ...faux.provider,
    stream(model, context, options) {
      arm();
      return faux.provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      arm();
      return faux.provider.streamSimple(model, context, options);
    },
  };
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel(provider.id, "faux-1");
  if (!model) throw new Error("faux model missing");
  return {models, model, provider};
}
