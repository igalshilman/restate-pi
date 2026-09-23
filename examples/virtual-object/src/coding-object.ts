// piCoding — the full pi coding agent (`createAgentSession`) inside a Restate
// virtual object, with pi's own read/bash/edit/write tools wrapped as
// generator tools so every file edit and shell command is a journaled step.
//
//   curl localhost:8080/piCoding/demo/prompt --json '{"message": "Create hello.txt and show me the directory."}'
//   curl localhost:8080/piCoding/demo/steer  --json '{"note": "Also add a second line."}'
//
// Each session gets its own workspace directory under PI_WORKSPACE_ROOT
// (default ./.pi-workspaces). The pi session entries are kept in object state,
// one entry per turn, and fed back through SessionManager.inMemory on the next
// prompt. The workspace itself is a local directory: tool results are
// journaled, the files are not, so a session belongs to the host that ran it.
//
// pi's tools run directly on this host, with no sandbox. With the faux model
// the script only writes hello.txt; a real model can run any command, so it
// needs PI_CODING_HOST_ACCESS=1.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {AgentMessage, AgentToolResult} from "@earendil-works/pi-agent-core";
import {createHash} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {join, resolve} from "node:path";
import {Mailbox, durableModels, fromAgentTool, lastAssistantText, runPi, servePi, serveRequest, type GenTool} from "restate-pi";
import {appendHistory, loadHistory} from "./history.js";
import {log} from "./log.js";
import {createModelSetup, type ModelSetup} from "./models.js";
import {currentTurn, finishDelay, logPiEvent, promptSchema, steerHandler, steerSchema} from "./turn.js";

/** pi-coding-agent does not export its entry type; take it from the API that consumes it. */
type FileEntries = NonNullable<Parameters<typeof SessionManager.inMemory>[2]>;
type FileEntry = FileEntries[number];

interface Turn {
  text: string;
  /** Entries this invocation added, the session header first on a fresh session. */
  added: FileEntry[];
}

const WORKSPACE_ROOT = resolve(process.env.PI_WORKSPACE_ROOT ?? ".pi-workspaces");
const CODING_PROMPT = "Create a file called hello.txt with a friendly greeting, then list the directory and show me the file.";

/** A directory name for an object key: readable, unique per key, never `.` or `..` or hidden. */
export function workspaceName(key: string): string {
  const slug = key.replaceAll(/[^\w-]/g, "_").slice(0, 40);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

/** Adapter to the coding agent's custom-tool shape: post to the mailbox, await the fiber. */
function toToolDefinition(mailbox: Mailbox, t: GenTool): ToolDefinition<any, any> {
  return {
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: (toolCallId: string, params: unknown) =>
      mailbox.post<AgentToolResult<unknown>>({kind: "tool", name: t.name, toolCallId, params}),
  };
}

function* prompt({message}: {message: string}): restate.Operation<string> {
  const setup = createModelSetup();
  if (setup.kind !== "faux" && process.env.PI_CODING_HOST_ACCESS !== "1") {
    throw new TerminalError("piCoding runs pi's bash, read, edit and write tools on this host without a sandbox; set PI_CODING_HOST_ACCESS=1 to allow that with a real model");
  }
  const saved = yield* loadHistory<FileEntry>(restate.state());
  const known = saved.length; // the session manager may extend `saved` in place
  const workspace = join(WORKSPACE_ROOT, workspaceName(restate.handlerRequest().key ?? "default"));
  const agentDir = join(WORKSPACE_ROOT, ".pi-agent");

  const mailbox = new Mailbox();
  const tools = createCodingTools(workspace).map(fromAgentTool);
  log("pi", `piCoding turn on ${setup.kind} model ${setup.model.id} in ${workspace}, ${saved.length} saved entries`);

  // pi's side, plain async. The session is opened once; each turn is one prompt.
  let session: AgentSession | undefined;
  const opened = openSession({mailbox, setup, tools, workspace, agentDir, saved}).then((s) => (session = s));
  const turn = (text: string) =>
    runPi<Turn>(mailbox, async () => {
      const s = await opened;
      await s.prompt(text);
      await finishDelay();
      const header = s.sessionManager.getHeader();
      const all = [...(header ? [header] : []), ...s.sessionManager.getEntries()] as FileEntries;
      return {text: lastAssistantText(s.messages), added: all.slice(known)};
    });
  turn(message);

  const result = yield* currentTurn(servePi<Turn>(mailbox, {
    serve: (req) => serveRequest(req, {mailbox, models: setup.models, tools}),
    onSteer: (note) => {
      session?.steer(note).catch((error: unknown) => log("steer", `failed: ${String(error)}`));
    },
    onLateSteer: (notes) => turn(notes.join("\n")),
    log: (line) => log("pi", line),
  }));
  void opened.then((s) => s.dispose()).catch(() => {});

  yield* appendHistory(result.added);
  return result.text;
}

function* transcript(): restate.Operation<AgentMessage[]> {
  const entries = yield* loadHistory<FileEntry>(restate.sharedState());
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message as AgentMessage] : []));
}

interface SessionOptions {
  mailbox: Mailbox;
  setup: ModelSetup;
  tools: GenTool[];
  workspace: string;
  agentDir: string;
  saved: FileEntries;
}

/** pi's side: the coding agent session with the durable model runtime and the wrapped tools. */
async function openSession(opts: SessionOptions): Promise<AgentSession> {
  // Every attempt, not a journaled step: a replay on a fresh host needs the directories too.
  await mkdir(opts.workspace, {recursive: true});
  await mkdir(opts.agentDir, {recursive: true});
  const runtime = await ModelRuntime.create({
    authPath: join(opts.agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(opts.agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (opts.setup.kind === "faux") runtime.registerNativeProvider(opts.setup.provider);
  const model = runtime.getModel(opts.setup.model.provider, opts.setup.model.id) ?? opts.setup.model;

  const settingsManager = SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}});
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.workspace,
    agentDir: opts.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
  });
  await resourceLoader.reload();

  const {session} = await createAgentSession({
    cwd: opts.workspace,
    agentDir: opts.agentDir,
    modelRuntime: durableModels(opts.mailbox, runtime),
    model,
    noTools: "builtin",
    customTools: opts.tools.map((t) => toToolDefinition(opts.mailbox, t)),
    tools: opts.tools.map((t) => t.name),
    resourceLoader,
    sessionManager: SessionManager.inMemory(opts.workspace, undefined, opts.saved.length ? opts.saved : undefined),
    settingsManager,
  });
  session.subscribe(logPiEvent);
  return session;
}

export const piCoding = restate.object({
  name: "piCoding",
  description: "The full pi coding agent in a virtual object: read/bash/edit/write as journaled steps in a per-session workspace.",
  handlers: {
    prompt: restate.schemas(promptSchema(CODING_PROMPT), prompt),
    steer: restate.schemas(steerSchema, steerHandler("piCoding")),
    transcript, // no input schema, so an empty body and `{}` both work
  },
  options: {handlers: {steer: {shared: true}, transcript: {shared: true}}},
});
