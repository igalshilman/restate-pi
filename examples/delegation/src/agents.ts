// Delegation: pi agents calling pi agents through Restate.
//
// `researcher` is a service: each call is one pi agent with a `lookup` tool.
// `lead` is a service whose pi agent has an `ask_researcher` tool, and that
// tool's body is a Restate call to `researcher`. pi runs the model's tool calls
// in parallel, so one reply that asks two researchers starts two durable
// invocations at once; the lead's journal records each call and its answer.
//
//   curl localhost:8080/lead/brief --json '{"goal": "Should we run pi on Restate?"}'

import * as restate from "@restatedev/restate-sdk-gen";
import {fauxAssistantMessage, fauxText, fauxToolCall, type Context as AiContext} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {contentText, runAgent, scriptedModel, textResult, tool} from "restate-pi";

const log = (scope: string, message: string) => console.log(`${new Date().toISOString().slice(11, 23)} [${scope}] ${message}`);

// ---- researcher ----------------------------------------------------------------

/** A tiny knowledge base standing in for search. RESEARCH_DELAY_MS makes lookups slow. */
const FACTS: Record<string, string> = {
  restate: "Restate journals every step, so a crashed invocation resumes where it left off",
  pi: "pi is an open-source coding agent with a small, embeddable agent loop",
};

const lookup = tool({
  name: "lookup",
  label: "Look up",
  description: "Look a topic up in the knowledge base.",
  parameters: Type.Object({topic: Type.String()}),
  *execute({topic}) {
    const delay = Number(process.env.RESEARCH_DELAY_MS ?? 0);
    if (delay > 0) yield* restate.sleep(delay, `Research ${topic}`);
    const fact = yield* restate.run(async () => FACTS[topic.toLowerCase()] ?? `nothing is known about ${topic}`, {name: `Look up ${topic}`});
    return textResult(fact);
  },
});

function researcherScript(context: AiContext) {
  const question = contentText(context.messages.find((m) => m.role === "user")?.content);
  const result = context.messages.find((m) => m.role === "toolResult");
  if (!result) {
    const topic = /topic: (\w+)/i.exec(question)?.[1] ?? question;
    return fauxAssistantMessage([fauxToolCall("lookup", {topic})], {stopReason: "toolUse"});
  }
  return fauxAssistantMessage(`${contentText(result.content)}.`);
}

function* research({topic, question}: {topic: string; question: string}): restate.Operation<string> {
  const {text} = yield* runAgent({
    systemPrompt: "You research one topic and answer in one sentence.",
    model: scriptedModel(researcherScript),
    tools: [lookup],
    message: `Topic: ${topic}. ${question}`,
    log: (line) => log(`researcher:${topic}`, line),
  });
  return text;
}

export const researcher = restate.service({
  name: "researcher",
  description: "One pi agent per call, answering a question about one topic.",
  handlers: {research},
});

// ---- lead ------------------------------------------------------------------------

/** The delegation tool: a Restate call to another pi agent, journaled like any step. */
const askResearcher = tool({
  name: "ask_researcher",
  label: "Ask a researcher",
  description: "Ask a researcher agent about one topic.",
  parameters: Type.Object({topic: Type.String(), question: Type.String()}),
  *execute({topic, question}) {
    return textResult(yield* restate.client(researcher).research({topic, question}));
  },
});

function leadScript(context: AiContext) {
  const findings = context.messages.flatMap((m) => (m.role === "toolResult" ? [contentText(m.content)] : []));
  if (findings.length === 0) {
    return fauxAssistantMessage(
      [
        fauxText("I'll ask two researchers at once."),
        fauxToolCall("ask_researcher", {topic: "restate", question: "What does it guarantee?"}),
        fauxToolCall("ask_researcher", {topic: "pi", question: "What is it?"}),
      ],
      {stopReason: "toolUse"},
    );
  }
  return fauxAssistantMessage(`Brief: ${findings.join(" ")}`);
}

function* brief({goal}: {goal: string}): restate.Operation<string> {
  const {text} = yield* runAgent({
    systemPrompt: "You plan a short brief and delegate research to researcher agents, in parallel where you can.",
    model: scriptedModel(leadScript),
    tools: [askResearcher],
    message: goal,
    log: (line) => log("lead", line),
  });
  return text;
}

export const lead = restate.service({
  name: "lead",
  description: "A pi agent that delegates to researcher agents and writes a brief.",
  handlers: {brief},
});
