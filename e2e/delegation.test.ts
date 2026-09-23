// examples/delegation: lead and researcher, two services each running one pi
// agent per call with `runAgent`. The lead's tool is a Restate call to a
// researcher, and pi runs the two calls in parallel.

import {test} from "node:test";
import assert from "node:assert/strict";
import {e2e} from "./support.js";

process.env.RESEARCH_DELAY_MS = "1500";
const {lead, researcher} = await import("../examples/delegation/src/agents.js");

type Invocation = {id: string; created_at: string; completed_at: string | null};

e2e("delegation", [lead, researcher], (t) => {
  test("the lead asks two researchers in parallel and writes a brief", async () => {
    assert.equal(
      await t.call("lead/brief", {goal: "Should we run pi on Restate?"}),
      "Brief: Restate journals every step, so a crashed invocation resumes where it left off. " +
        "pi is an open-source coding agent with a small, embeddable agent loop.",
    );

    // Each researcher sleeps 1.5 s on a durable timer. In parallel, the second
    // starts before the first completes.
    const calls = await t.query<Invocation>(
      "SELECT id, created_at, completed_at FROM sys_invocation WHERE target_service_name = 'researcher' ORDER BY created_at",
    );
    assert.equal(calls.length, 2);
    const [first, second] = calls as [Invocation, Invocation];
    assert.ok(first.completed_at && Date.parse(second.created_at) < Date.parse(first.completed_at), JSON.stringify(calls));
  });

  test("a researcher on its own", async () => {
    assert.equal(await t.call("researcher/research", {topic: "unicorns", question: "Do they exist?"}), "nothing is known about unicorns.");
  });
});
