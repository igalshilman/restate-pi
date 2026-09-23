// piHarness — pi's durable AgentHarness, hosted by a Restate virtual object.
//
//   curl localhost:8080/piHarness/demo/prompt --json '{}'
//   curl localhost:8080/piHarness/demo/steer  --json '{"note": "Please also run the linter."}'
//
// The object is the "serving layer" the harness spec describes: it accepts the
// prompt, loops on `drive`, and every durable wait the harness reports becomes
// a Restate timer. The harness's provider and tool calls flow through the same
// mailbox as piAgent, so each is a journaled step. The conversation tree is
// captured through the public Session API and kept in object state, one entry
// per turn. Retries are the harness's own: a failed provider call goes back to
// pi at once, and the backoff it schedules becomes a Restate timer.
// PI_DEFERRED=1 asks the provider for deferred responses, which exercises the
// suspend, durable sleep and poll path.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type AgentHarness as Harness,
  type AgentLane,
  type AgentMessage,
  type Entry,
  type OperationResultRecord,
  type Session,
} from "@earendil-works/pi-agent-core";
import {
  Mailbox,
  appendHistory,
  captureSession,
  currentTurn,
  driveToSettlement,
  durableModels,
  lastAssistantText,
  messagesOf,
  restoreSession,
  runPi,
  loadHistory,
  servePi,
  serveRequest,
  steerHandler,
  toHarnessTool,
  type SessionSnapshot,
} from "restate-pi";
import {log} from "./log.js";
import {SYSTEM_PROMPT, createModelSetup, type ModelSetup} from "./models.js";
import {RELEASE_TOOLS} from "./tools.js";
import {RELEASE_PROMPT, finishDelay, logPiEvent, promptSchema, steerSchema} from "./turn.js";

type State = {tip: string};

interface Turn {
  text: string;
  /** Entries this invocation added to the tree, and the branch tip after it. */
  added: Entry[];
  tip: string | null;
  outcome: OperationResultRecord;
}

interface Opened {
  repo: MemorySessionRepo;
  session: Session;
  harness: Harness<undefined>;
  lane: AgentLane;
}

const LANE = "main";
const ctx = BACKGROUND_CONTEXT;

function* prompt({message}: {message: string}): restate.Operation<string> {
  const state = restate.state<State>();
  const key = restate.handlerRequest().key ?? "default";
  const saved: SessionSnapshot = {entries: yield* loadHistory<Entry>(state), tip: yield* state.get("tip")};

  const mailbox = new Mailbox();
  const setup = createModelSetup();
  log("pi", `piHarness turn on ${setup.kind} model ${setup.model.id}, ${saved.entries.length} saved entries for ${key}`);

  // pi's side, plain async. The harness is opened once; each turn is one operation.
  let lane: AgentLane | undefined;
  const opened = open(mailbox, setup, key, saved).then((o) => (lane = o.lane, o));
  const turn = (operationId: string, text: string) =>
    runPi<Turn>(mailbox, async () => {
      const o = await opened;
      const outcome = await driveToSettlement({lane: o.lane, request: {kind: "prompt", operationId, prompt: text}, mailbox, context: ctx});
      await finishDelay();
      const now = await captureSession(o.session, LANE, ctx);
      return {text: lastAssistantText(messagesOf(now.entries)), added: addedSince(saved.entries, now.entries), tip: now.tip, outcome};
    });
  // Operation ids come from Restate's deterministic random, so replay agrees with the journal.
  turn(restate.rand().uuidv4(), message);

  const result = yield* currentTurn(servePi<Turn>(mailbox, {
    // One retry layer: a failed call returns to the harness, which backs off on a Restate timer.
    serve: (req) => serveRequest(req, {mailbox, models: setup.models, tools: RELEASE_TOOLS, retry: {maxAttempts: 1}}),
    onSteer: (note) => {
      lane?.steer(note, undefined, ctx).then(
        (queued) => log("steer", queued.ok ? `queued in pi's inbox as ${queued.value.entryId}` : `rejected: ${JSON.stringify(queued.error)}`),
        (error: unknown) => log("steer", `failed: ${String(error)}`),
      );
    },
    onLateSteer: (notes) => turn(restate.rand().uuidv4(), notes.join("\n")),
    log: (line) => log("pi", line),
  }));
  // Process-local cleanup; durable state is already in the journal and object state.
  void opened.then((o) => o.harness.close(ctx).then(() => o.repo.close(ctx))).catch(() => {});

  yield* appendHistory(result.added);
  if (result.tip) state.set("tip", result.tip);
  if (result.outcome.status !== "completed") {
    throw new TerminalError(`pi run ${result.outcome.status}: ${result.outcome.error?.message ?? ""}`);
  }
  return result.text;
}

/** The entries a turn appended. The tree is append-only, so the saved entries are a prefix. */
function addedSince(saved: readonly Entry[], now: readonly Entry[]): Entry[] {
  const prefix = saved.every((entry, i) => now[i]?.id === entry.id);
  if (!prefix) throw new TerminalError("pi rewrote saved session entries; append-only history cannot record that");
  return now.slice(saved.length);
}

function* transcript(): restate.Operation<AgentMessage[]> {
  return messagesOf(yield* loadHistory<Entry>(restate.sharedState()));
}

async function open(mailbox: Mailbox, setup: ModelSetup, key: string, saved: SessionSnapshot): Promise<Opened> {
  const repo = new MemorySessionRepo();
  const session = await repo.create({id: key}, ctx);
  if (saved.entries.length > 0) await restoreSession(session, saved, LANE, ctx);
  const {harness} = await AgentHarness.create(
    {
      session,
      models: durableModels(mailbox, setup.models),
      model: setup.model,
      tools: RELEASE_TOOLS.map((t) => toHarnessTool(mailbox, t)),
      systemPrompt: SYSTEM_PROMPT,
      retry: {enabled: true, maxRetries: 2, baseDelayMs: 2_000},
      ...(process.env.PI_DEFERRED ? {streamOptions: {deferred: true}} : {}),
    },
    ctx,
  );
  for (const type of ["tool_start", "tool_end", "message_end", "run_suspend", "retry_scheduled", "run_end"] as const) {
    harness.events.on(type, logPiEvent);
  }
  const lane = await harness.lane(LANE, ctx);
  return {repo, session, harness, lane};
}

export const piHarness = restate.object({
  name: "piHarness",
  description: "pi's durable AgentHarness driven by Restate: accept, drive, and durable timers for its waits.",
  handlers: {
    prompt: restate.schemas(promptSchema(RELEASE_PROMPT), prompt),
    steer: restate.schemas(steerSchema, steerHandler("piHarness")),
    transcript, // no input schema, so an empty body and `{}` both work
  },
  options: {handlers: {steer: {shared: true}, transcript: {shared: true}}},
});
