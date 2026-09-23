// releaseAgent against a real Restate server in Docker. The server suspends an
// invocation as soon as it waits (inactivity timeout 0), so these tests also
// show that a turn parked on a human decision holds no process.

import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {GenericContainer} from "testcontainers";

process.env.APPROVAL_TIMEOUT_MS = "4000";
const {releaseAgent} = await import("../src/release-agent.js");

let env: RestateTestEnvironment;

before(async () => {
  env = await RestateTestEnvironment.start({services: [releaseAgent]}, () =>
    new GenericContainer(process.env.RESTATE_IMAGE ?? "docker.restate.dev/restatedev/restate:latest").withEnvironment({
      RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT: "0s",
    }),
  );
});
after(async () => env?.stop());

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env.baseUrl()}/${path}`, {
    method: "POST",
    headers: body === undefined ? {} : {"content-type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function attach<T>(id: string): Promise<T> {
  const response = await fetch(`${env.baseUrl()}/restate/invocation/${id}/attach`);
  return JSON.parse(await response.text()) as T;
}

async function status(id: string): Promise<string> {
  const response = await fetch(`${env.adminAPIBaseUrl()}/query`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify({query: `SELECT status FROM sys_invocation WHERE id = '${id}'`}),
  });
  const {rows} = (await response.json()) as {rows: {status: string}[]};
  return rows[0]?.status ?? "unknown";
}

/** Start a release and wait until it is parked on the approval. */
async function releaseWaitingForApproval(key: string): Promise<string> {
  const {invocationId} = await post<{invocationId: string}>(`releaseAgent/${key}/prompt/send`, {message: "Ship v2.1 to production"});
  for (let i = 0; i < 200; i++) {
    if (await post(`releaseAgent/${key}/pending`)) return invocationId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the release never asked for approval");
}

async function suspended(id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await status(id)) === "suspended") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`invocation ${id} is ${await status(id)}, not suspended`);
}

test("staging needs no approval", async () => {
  assert.equal(await post("releaseAgent/staging/prompt", {message: "Ship v2.0 to staging"}), "Release v2.0: deployed v2.0 to staging.");
});

test("a production deploy suspends until someone approves it", async () => {
  const id = await releaseWaitingForApproval("approved");
  const waiting = await post<{env: string; version: string}>("releaseAgent/approved/pending");
  assert.deepEqual([waiting.env, waiting.version], ["production", "v2.1"]);
  await suspended(id);
  assert.equal(await post("releaseAgent/approved/approve", {by: "sam"}), "approved v2.1 for production");
  assert.equal(await attach(id), "Release v2.1: deployed v2.1 to staging; deployed v2.1 to production, approved by sam.");
  assert.equal(await post("releaseAgent/approved/pending"), null);
});

test("a rejection comes back to pi as the tool's result", async () => {
  const id = await releaseWaitingForApproval("rejected");
  await post("releaseAgent/rejected/reject", {by: "sam", reason: "change freeze"});
  assert.equal(await attach(id), "Release v2.1: deployed v2.1 to staging; not deployed: sam rejected v2.1 for production (change freeze).");
});

test("without a decision the deadline expires", async () => {
  const id = await releaseWaitingForApproval("expired");
  assert.equal(await attach(id), "Release v2.1: deployed v2.1 to staging; not deployed: nobody approved v2.1 for production in time.");
});

test("approving when nothing waits is a 404", async () => {
  await assert.rejects(post("releaseAgent/idle/approve", {by: "sam"}), /404/);
});
