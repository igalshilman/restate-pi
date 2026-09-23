// Which model pi talks to. With OPENAI_API_KEY set this is the real OpenAI
// provider through pi-ai. Without a key (or with PI_PROVIDER=faux) it is pi-ai's
// faux provider driven by a small script that decides the next reply from the
// transcript alone, so the demo is deterministic and replays cleanly.

import {
  createModels,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Api,
  type Context as AiContext,
  type Model,
  type Models,
  type Provider,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {openaiProvider} from "@earendil-works/pi-ai/providers/openai";
import {contentText as textOf, scriptedModel} from "restate-pi";

export const SYSTEM_PROMPT = `You are a release engineer working inside a sandbox. Use the tools to do what the user asks; you may request several at once.
When every requested action has a result, reply with a short plain-text summary.`;

export interface ModelSetup {
  /** The real runtime the fiber calls inside `run`. */
  models: Models;
  model: Model<Api>;
  /** The provider, so the coding agent's ModelRuntime can register it too. */
  provider: Provider;
  kind: "openai" | "faux";
}

export function createModelSetup(): ModelSetup {
  const wanted = process.env.PI_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai" : "faux");
  if (wanted === "openai") {
    const models = createModels();
    const provider = openaiProvider();
    models.setProvider(provider);
    const id = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
    const model = models.getModel("openai", id);
    if (!model) throw new Error(`unknown OpenAI model ${id}; set OPENAI_MODEL to one pi-ai knows`);
    return {models, model, provider, kind: "openai"};
  }
  return {...scriptedModel(script), kind: "faux"};
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

function script(context: AiContext) {
  const toolNames = new Set((context.tools ?? []).map((t) => t.name));
  const done = new Set<string>();
  const failed = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "toolResult") continue;
    done.add(message.toolName);
    if (message.isError) failed.set(message.toolName, textOf(message.content));
  }
  const users = context.messages.filter((m) => m.role === "user");
  const firstUser = textOf(users[0]?.content);
  const lastUser = textOf(users[users.length - 1]?.content);

  if (toolNames.has("deploy")) return releaseScript(done, firstUser, /lint/i.test(lastUser));
  if (toolNames.has("write") || toolNames.has("bash")) return codingScript(done, failed, firstUser);
  return fauxAssistantMessage("Nothing to do: no tools were offered.");
}

function releaseScript(done: Set<string>, firstUser: string, wantsLint: boolean) {
  if (!done.has("search")) {
    return fauxAssistantMessage(
      [fauxText("Let me find out how we deploy."), fauxToolCall("search", {query: "how do we deploy"})],
      {stopReason: "toolUse"},
    );
  }
  const calls: ToolCall[] = [];
  if (!done.has("deploy")) calls.push(fauxToolCall("deploy", {env: "staging"}));
  if (!done.has("test")) calls.push(fauxToolCall("test", {suite: "e2e"}));
  if (/delete|remove|rm /i.test(firstUser) && !done.has("rm_rf")) calls.push(fauxToolCall("rm_rf", {path: "/tmp/old-builds"}));
  if (wantsLint && !done.has("lint")) calls.push(fauxToolCall("lint", {}));
  if (calls.length > 0) return fauxAssistantMessage(calls, {stopReason: "toolUse"});

  const summary = ["Deployed to staging and the e2e suite passed"];
  if (done.has("lint")) summary.push("the linter is clean");
  if (done.has("rm_rf")) summary.push("the delete was blocked by the guardrail");
  return fauxAssistantMessage(`${summary.join("; ")}.`);
}

function codingScript(done: Set<string>, failed: Map<string, string>, firstUser: string) {
  if (!done.has("write")) {
    return fauxAssistantMessage(
      [
        fauxText("I'll create the file first."),
        fauxToolCall("write", {path: "hello.txt", content: `hello from pi inside a Restate virtual object\nrequest: ${firstUser}\n`}),
      ],
      {stopReason: "toolUse"},
    );
  }
  if (!done.has("bash")) {
    // Asking about a missing file shows a failing command coming back as an error result.
    const command = /missing/i.test(firstUser) ? "cat missing.txt" : "ls -la && cat hello.txt";
    return fauxAssistantMessage([fauxToolCall("bash", {command})], {stopReason: "toolUse"});
  }
  const error = failed.get("bash");
  if (error) return fauxAssistantMessage(`Created hello.txt, but the command failed: ${error.split("\n").at(-1)}`);
  return fauxAssistantMessage("Created hello.txt in the workspace and verified it with ls and cat.");
}
