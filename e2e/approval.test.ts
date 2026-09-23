// examples/approval: releaseAgent, an `agentObject` with approval handlers.
// A production deploy waits on an awakeable; the tests check it is suspended
// while it waits, and that approve, reject and the deadline each reach pi.

import {test} from "node:test";
import assert from "node:assert/strict";
import {e2e, eventually, type E2E} from "./support.js";

process.env.APPROVAL_TIMEOUT_MS = "4000";
const {releaseAgent} = await import("../examples/approval/src/release-agent.js");

/** Start a release and wait until it is parked on the approval. */
async function waitingForApproval(t: E2E, key: string, message = "Ship v2.1 to production"): Promise<string> {
  const id = await t.send(`releaseAgent/${key}/prompt`, {message});
  await eventually("the approval request", () => t.call(`releaseAgent/${key}/pending`));
  return id;
}

const status = async (t: E2E, id: string) =>
  (await t.query<{status: string}>(`SELECT status FROM sys_invocation WHERE id = '${id}'`))[0]?.status;

e2e("approval", [releaseAgent], (t) => {
  test("staging needs no approval", async () => {
    assert.equal(await t.call("releaseAgent/staging/prompt", {message: "Ship v2.0 to staging"}), "Release v2.0: deployed v2.0 to staging.");
  });

  test("a production deploy suspends until someone approves it", async () => {
    const id = await waitingForApproval(t, "approved");
    const waiting = await t.call<{env: string; version: string}>("releaseAgent/approved/pending");
    assert.deepEqual([waiting.env, waiting.version], ["production", "v2.1"]);
    if (t.mode.alwaysReplay) {
      // The server suspends at once in this mode; a live server would only after its inactivity timeout.
      await eventually("the invocation to suspend", async () => (await status(t, id)) === "suspended");
    } else {
      assert.notEqual(await status(t, id), "completed");
    }

    assert.equal(await t.call("releaseAgent/approved/approve", {by: "sam"}), "approved v2.1 for production");
    assert.equal(await t.attach(id), "Release v2.1: deployed v2.1 to staging; deployed v2.1 to production, approved by sam.");
    assert.equal(await t.call("releaseAgent/approved/pending"), null);
  });

  test("a rejection comes back to pi as the tool's result", async () => {
    const id = await waitingForApproval(t, "rejected");
    await t.call("releaseAgent/rejected/reject", {by: "sam", reason: "change freeze"});
    assert.equal(await t.attach(id), "Release v2.1: deployed v2.1 to staging; not deployed: sam rejected v2.1 for production (change freeze).");
  });

  test("without a decision the deadline expires", async () => {
    const id = await waitingForApproval(t, "expired");
    assert.equal(await t.attach(id), "Release v2.1: deployed v2.1 to staging; not deployed: nobody approved v2.1 for production in time.");
  });

  test("the session remembers earlier releases", async () => {
    assert.equal(await t.call("releaseAgent/twice/prompt", {message: "Ship v3.0 to staging"}), "Release v3.0: deployed v3.0 to staging.");
    assert.equal(await t.call("releaseAgent/twice/prompt", {message: "Ship v3.1 to staging"}), "Release v3.1: deployed v3.1 to staging.");
    const transcript = await t.call<{role: string}[]>("releaseAgent/twice/transcript");
    assert.equal(transcript.filter((m) => m.role === "user").length, 2);
  });

  test("approving when nothing waits is a 404", async () => {
    await assert.rejects(t.call("releaseAgent/idle/approve", {by: "sam"}), /404/);
  });

  test("a prompt without a message is a 400", async () => {
    await assert.rejects(t.call("releaseAgent/empty/prompt", {}), /400.*prompt needs a message/);
  });
});
