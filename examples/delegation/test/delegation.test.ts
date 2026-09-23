// lead and researcher against a real Restate server in Docker.

import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {GenericContainer} from "testcontainers";

process.env.RESEARCH_DELAY_MS = "1500";
const {lead, researcher} = await import("../src/agents.js");

let env: RestateTestEnvironment;

before(async () => {
  env = await RestateTestEnvironment.start({services: [lead, researcher]}, () =>
    new GenericContainer(process.env.RESTATE_IMAGE ?? "docker.restate.dev/restatedev/restate:latest"),
  );
});
after(async () => env?.stop());

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${env.baseUrl()}/${path}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

async function query<T>(sql: string): Promise<T[]> {
  const response = await fetch(`${env.adminAPIBaseUrl()}/query`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify({query: sql}),
  });
  return ((await response.json()) as {rows: T[]}).rows;
}

test("the lead asks two researchers in parallel and writes a brief", async () => {
  const started = Date.now();
  const brief = await post<string>("lead/brief", {goal: "Should we run pi on Restate?"});
  const elapsed = Date.now() - started;

  assert.equal(
    brief,
    "Brief: Restate journals every step, so a crashed invocation resumes where it left off. " +
      "pi is an open-source coding agent with a small, embeddable agent loop.",
  );
  // Each researcher sleeps 1.5 s on a durable timer; one after the other would take at least 3 s.
  assert.ok(elapsed < 2900, `took ${elapsed} ms, the researchers did not run in parallel`);

  const calls = await query<{target: string}>("SELECT target FROM sys_invocation WHERE target_service_name = 'researcher'");
  assert.equal(calls.length, 2);
});

test("a researcher on its own", async () => {
  assert.equal(
    await post("researcher/research", {topic: "unicorns", question: "Do they exist?"}),
    "nothing is known about unicorns.",
  );
});
