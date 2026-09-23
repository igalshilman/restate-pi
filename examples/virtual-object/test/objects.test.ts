// The three objects against a real Restate server in Docker, with the faux
// model so every run is deterministic. One suite runs normally and covers
// steering; the other suspends and replays after every journal entry
// (inactivity timeout 0), so pi's loop re-runs against the journal on every step.
//
//   pnpm test                                   (needs Docker)
//   RESTATE_IMAGE=docker.restate.dev/restatedev/restate:main pnpm test

import {after, before, describe, test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {GenericContainer} from "testcontainers";

// Read at module load by the example, so set before importing it.
process.env.PI_PROVIDER = "faux";
process.env.PI_TOOL_DELAY_MS = "1500";
process.env.PI_WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), "restate-pi-test-"));

const {piAgent} = await import("../src/agent-object.js");
const {piHarness} = await import("../src/harness-object.js");
const {piCoding, workspaceName} = await import("../src/coding-object.js");
const {currentTurn} = await import("../src/turn.js");

const RELEASE_ANSWER = "Deployed to staging and the e2e suite passed; the delete was blocked by the guardrail.";
const LINT_ANSWER = "Deployed to staging and the e2e suite passed; the linter is clean; the delete was blocked by the guardrail.";

/** `currentTurn` on its own: a turn that fails terminally, and a way to read the marker. */
const probe = restate.object({
  name: "probe",
  handlers: {
    *fail(): restate.Operation<void> {
      yield* currentTurn(
        restate.gen(function* () {
          yield* restate.sleep(10);
          throw new TerminalError("the turn failed");
        }),
      );
    },
    *marker(): restate.Operation<string | null> {
      return yield* restate.sharedState().get<string>("invocation");
    },
  },
  options: {handlers: {marker: {shared: true}}},
});

const services = [piAgent, piHarness, piCoding, probe];

function restateContainer(replayEveryStep: boolean) {
  const container = new GenericContainer(process.env.RESTATE_IMAGE ?? "docker.restate.dev/restatedev/restate:latest");
  return replayEveryStep ? container.withEnvironment({RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT: "0s"}) : container;
}

// ---- ingress helpers --------------------------------------------------------

class Ingress {
  private readonly env: RestateTestEnvironment;

  constructor(env: RestateTestEnvironment) {
    this.env = env;
  }

  async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.env.baseUrl()}/${path}`, {
      method: "POST",
      headers: body === undefined ? {} : {"content-type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  async send(path: string, body: unknown): Promise<string> {
    return (await this.call<{invocationId: string}>(`${path}/send`, body)).invocationId;
  }

  async attach<T>(invocationId: string): Promise<T> {
    const response = await fetch(`${this.env.baseUrl()}/restate/invocation/${invocationId}/attach`);
    const text = await response.text();
    if (!response.ok) throw new Error(`attach ${invocationId}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }

  /** Wait until the object's running turn has recorded itself. */
  async runningTurn(object: {name: string}, key: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const invocation = await this.env.stateOf(object as never, key).get<string>("invocation");
      if (invocation) return invocation;
      await sleep(50);
    }
    throw new Error(`no turn started on ${object.name}/${key}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Log lines printed by the example, to observe how often an effect really ran. */
const lines: string[] = [];
const print = console.log;
console.log = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
  print(...args);
};
const count = (pattern: RegExp, since: number) => lines.slice(since).filter((line) => pattern.test(line)).length;

async function until(pattern: RegExp, since: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (count(pattern, since) > 0) return;
    await sleep(25);
  }
  throw new Error(`never logged ${pattern}`);
}

type Message = {role: string; content: unknown};
const userNotes = (messages: Message[]) =>
  messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

// ---- suites -----------------------------------------------------------------

describe("pi objects", () => {
  let env: RestateTestEnvironment;
  let ingress: Ingress;

  before(async () => {
    env = await RestateTestEnvironment.start({services}, () => restateContainer(false));
    ingress = new Ingress(env);
  });
  after(async () => env?.stop());

  test("piAgent answers a turn and continues the conversation on the next", async () => {
    assert.equal(await ingress.call("piAgent/turns/prompt", {}), RELEASE_ANSWER);
    const first = await ingress.call<Message[]>("piAgent/turns/transcript");
    assert.equal(await ingress.call("piAgent/turns/prompt", {message: "Please also run the linter."}), LINT_ANSWER);
    const second = await ingress.call<Message[]>("piAgent/turns/transcript", {});
    assert.ok(second.length > first.length);
    assert.deepEqual(second.slice(0, first.length), first, "a turn only appends");
  });

  test("a steer mid-turn is delivered into the running turn", async () => {
    const id = await ingress.send("piAgent/steered/prompt", {});
    await ingress.runningTurn(piAgent, "steered");
    const reply = await ingress.call<string>("piAgent/steered/steer", {note: "Please also run the linter."});
    assert.equal(reply, `steer delivered to ${id}`);
    assert.equal(await ingress.attach(id), LINT_ANSWER);
  });

  test("two steers into the same turn both arrive", async () => {
    const id = await ingress.send("piAgent/twice/prompt", {});
    await ingress.runningTurn(piAgent, "twice");
    const replies = await Promise.all([
      ingress.call<string>("piAgent/twice/steer", {note: "Please also run the linter."}),
      ingress.call<string>("piAgent/twice/steer", {note: "And lint the docs too."}),
    ]);
    assert.deepEqual(replies, [`steer delivered to ${id}`, `steer delivered to ${id}`]);
    await ingress.attach(id);
    const notes = userNotes(await ingress.call<Message[]>("piAgent/twice/transcript"));
    assert.ok(notes.includes("Please also run the linter.") && notes.includes("And lint the docs too."), notes.join(" | "));
  });

  test("a steer after pi's last answer starts a follow-up turn in the same invocation", async () => {
    process.env.PI_FINISH_DELAY_MS = "2000";
    try {
      const since = lines.length;
      const id = await ingress.send("piAgent/late/prompt", {});
      await until(/assistant: Deployed to staging/, since);
      const reply = await ingress.call<string>("piAgent/late/steer", {note: "Please also run the linter."});
      assert.equal(reply, `steer delivered to ${id}`);
      assert.match(await ingress.attach<string>(id), /the linter is clean/);
      assert.equal(count(/starting a follow-up turn/, since), 1);
    } finally {
      delete process.env.PI_FINISH_DELAY_MS;
    }
  });

  test("a steer on an idle session becomes the next turn", async () => {
    await ingress.call("piAgent/idle/prompt", {});
    const reply = await ingress.call<string>("piAgent/idle/steer", {note: "Please also run the linter."});
    const id = /starts a new turn (\S+)$/.exec(reply)?.[1];
    assert.ok(id, reply);
    assert.match(await ingress.attach<string>(id), /the linter is clean/);
  });

  test("a stale turn marker does not swallow a steer", async () => {
    const finished = await ingress.send("piAgent/stale/prompt", {});
    await ingress.attach(finished);
    // What a turn that died without cleaning up would leave behind.
    await env.stateOf(piAgent as never, "stale").set("invocation", finished);
    const reply = await ingress.call<string>("piAgent/stale/steer", {note: "Please also run the linter."});
    assert.match(reply, /^no turn took the note; it starts a new turn /);
  });

  test("a turn that fails terminally clears its marker", async () => {
    await assert.rejects(ingress.call("probe/p/fail"), /the turn failed/);
    assert.equal(await ingress.call("probe/p/marker"), null);
  });

  test("piHarness runs a turn, restores its tree and continues", async () => {
    assert.equal(await ingress.call("piHarness/turns/prompt", {}), RELEASE_ANSWER);
    assert.equal(await ingress.call("piHarness/turns/prompt", {message: "Please also run the linter."}), LINT_ANSWER);
    const notes = userNotes(await ingress.call<Message[]>("piHarness/turns/transcript"));
    assert.equal(notes.length, 2);
  });

  test("piHarness steered mid-turn", async () => {
    const id = await ingress.send("piHarness/steered/prompt", {});
    await ingress.runningTurn(piHarness, "steered");
    assert.equal(await ingress.call("piHarness/steered/steer", {note: "Please also run the linter."}), `steer delivered to ${id}`);
    assert.match(await ingress.attach<string>(id), /the linter is clean/);
  });

  test("piHarness with deferred responses suspends, sleeps durably and polls", async () => {
    process.env.PI_DEFERRED = "1";
    try {
      const since = lines.length;
      assert.equal(await ingress.call("piHarness/deferred/prompt", {}), RELEASE_ANSWER);
      assert.ok(count(/run suspended on a deferred response/, since) > 0);
      assert.ok(count(/pi asks for deferred poll/, since) > 0);
    } finally {
      delete process.env.PI_DEFERRED;
    }
  });

  test("piCoding writes and reads a file in its own workspace", async () => {
    assert.equal(await ingress.call("piCoding/files/prompt", {}), "Created hello.txt in the workspace and verified it with ls and cat.");
    const files = await readdir(join(process.env.PI_WORKSPACE_ROOT!, workspaceName("files")));
    assert.deepEqual(files, ["hello.txt"]);
    const transcript = await ingress.call<Message[]>("piCoding/files/transcript");
    assert.ok(transcript.some((m) => m.role === "toolResult"));
  });

  test("piCoding reports a failing command to pi instead of retrying it", async () => {
    const since = lines.length;
    const answer = await ingress.call<string>("piCoding/failing/prompt", {message: "Show me the missing file."});
    assert.equal(answer, "Created hello.txt, but the command failed: Command exited with code 1");
    assert.equal(count(/Error executing run|Retrying/i, since), 0);
  });

  test("workspace names stay inside the root and are unique per key", () => {
    for (const key of ["..", ".", ".pi-agent", "a/b", "../../etc"]) {
      assert.match(workspaceName(key), /^[\w-]+-[0-9a-f]{12}$/);
      assert.ok(!workspaceName(key).startsWith("."));
    }
    assert.notEqual(workspaceName("a/b"), workspaceName("a_b"));
  });
});

describe("replay after every journal entry", () => {
  let env: RestateTestEnvironment;
  let ingress: Ingress;

  before(async () => {
    env = await RestateTestEnvironment.start({services}, () => restateContainer(true));
    ingress = new Ingress(env);
  });
  after(async () => env?.stop());

  // Each tool effect logs "running" when it really executes; a replay must not run it again.
  test("piAgent", async () => {
    const since = lines.length;
    assert.equal(await ingress.call("piAgent/replay/prompt", {}), RELEASE_ANSWER);
    assert.equal(count(/Deploy to staging — \S+ running/, since), 1);
    assert.equal(count(/Run e2e tests — \S+ running/, since), 1);
  });

  test("piAgent steered while replaying", async () => {
    const id = await ingress.send("piAgent/replay-steer/prompt", {});
    await ingress.runningTurn(piAgent, "replay-steer");
    assert.equal(await ingress.call("piAgent/replay-steer/steer", {note: "Please also run the linter."}), `steer delivered to ${id}`);
    assert.equal(await ingress.attach(id), LINT_ANSWER);
  });

  test("piHarness", async () => {
    const since = lines.length;
    assert.equal(await ingress.call("piHarness/replay/prompt", {}), RELEASE_ANSWER);
    assert.equal(await ingress.call("piHarness/replay/prompt", {message: "Please also run the linter."}), LINT_ANSWER);
    assert.equal(count(/Deploy to staging — \S+ running/, since), 1);
  });

  test("piCoding", async () => {
    assert.equal(await ingress.call("piCoding/replay/prompt", {}), "Created hello.txt in the workspace and verified it with ls and cat.");
  });
});
