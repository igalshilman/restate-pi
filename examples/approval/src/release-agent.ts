// releaseAgent — a pi agent whose production deploys need a human to sign off.
//
// The `deploy` tool is a generator. For production it creates an awakeable,
// records it in object state and waits for `approve` or `reject`, or for the
// deadline. While it waits the invocation is suspended: no process holds it and
// no `run` is open, so the wait can last hours and survive restarts.
//
//   ID=$(curl -s localhost:8080/releaseAgent/r1/prompt/send --json '{"message": "Ship v2.1 to production"}' | jq -r .invocationId)
//   curl -X POST localhost:8080/releaseAgent/r1/pending
//   curl localhost:8080/releaseAgent/r1/approve --json '{"by": "sam"}'
//   curl localhost:8080/restate/invocation/$ID/attach

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {Agent} from "@earendil-works/pi-agent-core";
import {fauxAssistantMessage, fauxText, fauxToolCall, type Context as AiContext} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {
  Mailbox,
  contentText,
  durableStreamFn,
  lastAssistantText,
  runPi,
  scriptedModel,
  servePi,
  serveRequest,
  textResult,
  toAgentTool,
  tool,
} from "restate-pi";

/** How long a production deploy waits for a decision. APPROVAL_TIMEOUT_MS overrides it. */
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 24 * 60 * 60 * 1000);

export interface Pending {
  awakeable: string;
  env: string;
  version: string;
}

export interface Decision {
  approved: boolean;
  by: string;
  reason?: string;
}

type State = {pending: Pending};

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)} [release] ${message}`);

const deploy = tool({
  name: "deploy",
  label: "Deploy",
  description: "Deploy a version to an environment. Production deploys wait for a human to approve them.",
  parameters: Type.Object({
    env: Type.String({description: "staging or production"}),
    version: Type.String({description: "The version to ship, e.g. v2.1"}),
  }),
  *execute({env, version}) {
    let approvedBy = "";
    if (env === "production") {
      const state = restate.state<State>();
      const {id, promise: decision} = restate.awakeable<Decision>();
      state.set("pending", {awakeable: id, env, version});
      log(`${version} to production is waiting for approval (${id})`);
      const won = yield* restate.select({decision, deadline: restate.sleep(APPROVAL_TIMEOUT_MS, "Approval deadline")});
      state.clear("pending");
      if (won.tag === "deadline") return textResult(`not deployed: nobody approved ${version} for production in time`);
      const {approved, by, reason} = yield* decision;
      if (!approved) return textResult(`not deployed: ${by} rejected ${version} for production${reason ? ` (${reason})` : ""}`);
      approvedBy = `, approved by ${by}`;
    }
    yield* restate.run(async () => log(`deploying ${version} to ${env}`), {name: `Deploy ${version} to ${env}`});
    return textResult(`deployed ${version} to ${env}${approvedBy}`);
  },
});

const TOOLS = [deploy];

function* prompt({message}: {message: string}): restate.Operation<string> {
  const mailbox = new Mailbox();
  const {models, model} = scriptedModel(releaseScript);
  const agent = new Agent({
    initialState: {
      systemPrompt: "You ship releases: staging first, then production.",
      model,
      tools: TOOLS.map((t) => toAgentTool(mailbox, t)),
    },
    streamFn: durableStreamFn(mailbox),
  });

  runPi(mailbox, async () => {
    await agent.prompt(message);
    return lastAssistantText(agent.state.messages);
  });
  return yield* servePi<string>(mailbox, {
    serve: (request) => serveRequest(request, {mailbox, models, tools: TOOLS}),
    log,
  });
}

function* pending(): restate.Operation<Pending | null> {
  return yield* restate.sharedState<State>().get("pending");
}

function decide(approved: boolean) {
  return function* ({by, reason}: {by: string; reason?: string}): restate.Operation<string> {
    const waiting = yield* restate.sharedState<State>().get("pending");
    if (!waiting) throw new TerminalError("nothing is waiting for approval", {errorCode: 404});
    restate.resolveAwakeable<Decision>(waiting.awakeable, {approved, by, ...(reason ? {reason} : {})});
    return `${approved ? "approved" : "rejected"} ${waiting.version} for ${waiting.env}`;
  };
}

export const releaseAgent = restate.object({
  name: "releaseAgent",
  description: "A pi agent that ships a release; production waits, suspended, for a human decision.",
  handlers: {prompt, pending, approve: decide(true), reject: decide(false)},
  options: {handlers: {pending: {shared: true}, approve: {shared: true}, reject: {shared: true}}},
});

// ---- the scripted model ------------------------------------------------------

/** Staging, then production, then a summary of what the tools reported. */
function releaseScript(context: AiContext) {
  const user = contentText(context.messages.find((m) => m.role === "user")?.content);
  const version = /v\d+(\.\d+)*/.exec(user)?.[0] ?? "the new build";
  const results = context.messages.flatMap((m) => (m.role === "toolResult" ? [contentText(m.content)] : []));
  if (results.length === 0) {
    return fauxAssistantMessage([fauxText(`Staging first.`), fauxToolCall("deploy", {env: "staging", version})], {stopReason: "toolUse"});
  }
  if (results.length === 1 && /production/i.test(user)) {
    return fauxAssistantMessage([fauxText("Staging is good; production next."), fauxToolCall("deploy", {env: "production", version})], {stopReason: "toolUse"});
  }
  return fauxAssistantMessage(`Release ${version}: ${results.join("; ")}.`);
}
