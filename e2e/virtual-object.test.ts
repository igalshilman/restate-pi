// examples/virtual-object: piAgent (on `agentObject`), piHarness and piCoding,
// on the scripted model so every run is deterministic.

import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {currentTurn} from "restate-pi";
import {e2e, eventually, logs, type E2E} from "./support.js";

// Read at module load by the example, so set before importing it.
process.env.PI_PROVIDER = "faux";
process.env.PI_TOOL_DELAY_MS = "1500";
process.env.PI_WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), "restate-pi-e2e-"));

const {piAgent} = await import("../examples/virtual-object/src/agent-object.js");
const {piHarness} = await import("../examples/virtual-object/src/harness-object.js");
const {piCoding, workspaceName} = await import("../examples/virtual-object/src/coding-object.js");

const RELEASE_ANSWER = "Deployed to staging and the e2e suite passed; the delete was blocked by the guardrail.";
const LINT_ANSWER = "Deployed to staging and the e2e suite passed; the linter is clean; the delete was blocked by the guardrail.";
const CODING_ANSWER = "Created hello.txt in the workspace and verified it with ls and cat.";
const LINT = "Please also run the linter.";

/** `currentTurn` on its own: a turn that fails terminally, and a way to read its marker. */
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

type Message = {role: string; content: unknown};
const userNotes = (messages: Message[]) =>
  messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

/** Wait until the object's running turn has recorded itself. */
const runningTurn = (t: E2E, object: {name: string}, key: string) =>
  eventually(`a running turn on ${object.name}/${key}`, () => t.getState<string>(object, key, "invocation"));

e2e("virtual-object", [piAgent, piHarness, piCoding, probe], (t) => {
  // Keys are per mode: each mode gets a fresh server, but the coding workspaces share a directory.
  const k = (key: string) => `${key}-${t.mode.alwaysReplay ? "replay" : "live"}`;

  test("piAgent answers, and the next prompt continues the conversation", async () => {
    const since = logs.mark();
    assert.equal(await t.call(`piAgent/${k("turns")}/prompt`, {}), RELEASE_ANSWER);
    // Each effect logs "running" when it really executes; a replay must not run it again.
    assert.equal(logs.count(/Deploy to staging — \S+ running/, since), 1);
    assert.equal(logs.count(/Run e2e tests — \S+ running/, since), 1);

    const first = await t.call<Message[]>(`piAgent/${k("turns")}/transcript`);
    assert.equal(await t.call(`piAgent/${k("turns")}/prompt`, {message: LINT}), LINT_ANSWER);
    const second = await t.call<Message[]>(`piAgent/${k("turns")}/transcript`, {});
    assert.ok(second.length > first.length);
    assert.deepEqual(second.slice(0, first.length), first, "a turn only appends");
  });

  test("agentObject validates its inputs", async () => {
    await assert.rejects(t.call(`piAgent/${k("bad")}/steer`, {}), /400.*steer needs a note/);
  });

  test("a steer mid-turn is delivered into the running turn", async () => {
    const id = await t.send(`piAgent/${k("steered")}/prompt`, {});
    await runningTurn(t, piAgent, k("steered"));
    assert.equal(await t.call(`piAgent/${k("steered")}/steer`, {note: LINT}), `steer delivered to ${id}`);
    assert.equal(await t.attach(id), LINT_ANSWER);
  });

  test("two steers into the same turn both arrive", async () => {
    const id = await t.send(`piAgent/${k("twice")}/prompt`, {});
    await runningTurn(t, piAgent, k("twice"));
    const replies = await Promise.all([
      t.call(`piAgent/${k("twice")}/steer`, {note: LINT}),
      t.call(`piAgent/${k("twice")}/steer`, {note: "And lint the docs too."}),
    ]);
    assert.deepEqual(replies, [`steer delivered to ${id}`, `steer delivered to ${id}`]);
    await t.attach(id);
    const notes = userNotes(await t.call<Message[]>(`piAgent/${k("twice")}/transcript`));
    assert.ok(notes.includes(LINT) && notes.includes("And lint the docs too."), notes.join(" | "));
  });

  test("a steer after pi's last answer starts a follow-up turn in the same invocation", async () => {
    process.env.PI_FINISH_DELAY_MS = "2000";
    try {
      const since = logs.mark();
      const id = await t.send(`piAgent/${k("late")}/prompt`, {});
      await logs.until(/assistant: Deployed to staging/, since);
      assert.equal(await t.call(`piAgent/${k("late")}/steer`, {note: LINT}), `steer delivered to ${id}`);
      assert.match(await t.attach<string>(id), /the linter is clean/);
      assert.ok(logs.count(/starting a follow-up turn/, since) >= 1);
    } finally {
      delete process.env.PI_FINISH_DELAY_MS;
    }
  });

  test("a steer on an idle session becomes the next turn", async () => {
    await t.call(`piAgent/${k("idle")}/prompt`, {});
    const reply = await t.call<string>(`piAgent/${k("idle")}/steer`, {note: LINT});
    const id = /starts a new turn (\S+)$/.exec(reply)?.[1];
    assert.ok(id, reply);
    assert.match(await t.attach<string>(id), /the linter is clean/);
  });

  test("a stale turn marker does not swallow a steer", async () => {
    const finished = await t.send(`piAgent/${k("stale")}/prompt`, {});
    await t.attach(finished);
    // What a turn that died without cleaning up would leave behind.
    await t.setState(piAgent, k("stale"), "invocation", finished);
    assert.match(await t.call<string>(`piAgent/${k("stale")}/steer`, {note: LINT}), /^no turn took the note; it starts a new turn /);
  });

  test("a turn that fails terminally clears its marker", async () => {
    await assert.rejects(t.call(`probe/${k("p")}/fail`), /the turn failed/);
    assert.equal(await t.call(`probe/${k("p")}/marker`), null);
  });

  test("piHarness runs a turn, restores its tree and continues", async () => {
    const since = logs.mark();
    assert.equal(await t.call(`piHarness/${k("turns")}/prompt`, {}), RELEASE_ANSWER);
    assert.equal(await t.call(`piHarness/${k("turns")}/prompt`, {message: LINT}), LINT_ANSWER);
    assert.equal(logs.count(/Deploy to staging — \S+ running/, since), 1);
    assert.equal(userNotes(await t.call<Message[]>(`piHarness/${k("turns")}/transcript`)).length, 2);
  });

  test("piHarness steered mid-turn", async () => {
    const id = await t.send(`piHarness/${k("steered")}/prompt`, {});
    await runningTurn(t, piHarness, k("steered"));
    assert.equal(await t.call(`piHarness/${k("steered")}/steer`, {note: LINT}), `steer delivered to ${id}`);
    assert.match(await t.attach<string>(id), /the linter is clean/);
  });

  test("piHarness with deferred responses suspends, sleeps durably and polls", async () => {
    process.env.PI_DEFERRED = "1";
    try {
      const since = logs.mark();
      assert.equal(await t.call(`piHarness/${k("deferred")}/prompt`, {}), RELEASE_ANSWER);
      assert.ok(logs.count(/run suspended on a deferred response/, since) > 0);
      assert.ok(logs.count(/pi asks for deferred poll/, since) > 0);
    } finally {
      delete process.env.PI_DEFERRED;
    }
  });

  test("piCoding writes and reads a file in its own workspace", async () => {
    assert.equal(await t.call(`piCoding/${k("files")}/prompt`, {}), CODING_ANSWER);
    assert.deepEqual(await readdir(join(process.env.PI_WORKSPACE_ROOT!, workspaceName(k("files")))), ["hello.txt"]);
    const transcript = await t.call<Message[]>(`piCoding/${k("files")}/transcript`);
    assert.ok(transcript.some((m) => m.role === "toolResult"));
  });

  test("piCoding reports a failing command to pi instead of retrying it", async () => {
    assert.equal(
      await t.call(`piCoding/${k("failing")}/prompt`, {message: "Show me the missing file."}),
      "Created hello.txt, but the command failed: Command exited with code 1",
    );
  });

  test("workspace names stay inside the root and are unique per key", () => {
    for (const key of ["..", ".", ".pi-agent", "a/b", "../../etc"]) {
      assert.match(workspaceName(key), /^[\w-]+-[0-9a-f]{12}$/);
    }
    assert.notEqual(workspaceName("a/b"), workspaceName("a_b"));
  });
});
