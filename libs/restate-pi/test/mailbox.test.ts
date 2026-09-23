// The mailbox without Restate: the ordering, replay and divergence rules
// `servePi` relies on, driven by hand from both sides.

import {test} from "node:test";
import assert from "node:assert/strict";
import {TerminalError} from "@restatedev/restate-sdk";
import {Mailbox, type Idle, type PiRequest} from "../src/mailbox.js";

/** A request, not an idle marker. */
async function request(next: Promise<PiRequest | Idle>): Promise<PiRequest> {
  const got = await next;
  assert.notEqual(got.kind, "idle");
  return got as PiRequest;
}

const tool = (seq: number, name = "deploy", toolCallId = `call-${seq}`): PiRequest => ({seq, kind: "tool", name, toolCallId, params: {}});

test("a live request: pi posts, the fiber takes it and answers", async () => {
  const mailbox = new Mailbox();
  const answer = mailbox.post<string>({kind: "tool", name: "deploy", toolCallId: "call-0", params: {env: "staging"}});
  const req = await request(mailbox.next());
  assert.deepEqual(req, {seq: 0, kind: "tool", name: "deploy", toolCallId: "call-0", params: {env: "staging"}});
  mailbox.markServed(req);
  mailbox.answer(req.seq, "deployed");
  assert.equal(await answer, "deployed");
});

test("the fiber can wait before pi asks", async () => {
  const mailbox = new Mailbox();
  const next = mailbox.next();
  void mailbox.post({kind: "tool", name: "test", toolCallId: "call-0", params: {}});
  assert.equal((await request(next)).seq, 0);
});

test("requests arrive in order and carry increasing sequence numbers", async () => {
  const mailbox = new Mailbox();
  void mailbox.post({kind: "tool", name: "deploy", toolCallId: "a", params: {}});
  void mailbox.post({kind: "tool", name: "test", toolCallId: "b", params: {}});
  const first = await request(mailbox.next());
  mailbox.markServed(first);
  const second = await request(mailbox.next());
  assert.deepEqual([first.seq, second.seq], [0, 1]);
});

test("replay: the journal serves a request and its answer before pi re-issues it", async () => {
  const mailbox = new Mailbox();
  // The fiber races ahead: `run(() => mailbox.next())` returned seq 0 from the journal,
  // and the spawned task's journaled result is delivered at once.
  mailbox.markServed(tool(0));
  mailbox.answer(0, "from the journal");
  // pi's loop re-runs for real and asks the same thing.
  assert.equal(await mailbox.post({kind: "tool", name: "deploy", toolCallId: "call-0", params: {}}), "from the journal");
  // Seq 0 is served, so the next live `next()` waits for seq 1 instead of returning it again.
  const next = mailbox.next();
  void mailbox.post({kind: "tool", name: "test", toolCallId: "call-1", params: {}});
  assert.equal((await request(next)).seq, 1);
});

test("replay divergence fails both sides with a TerminalError", async () => {
  const mailbox = new Mailbox();
  mailbox.markServed(tool(0, "deploy"));
  await assert.rejects(mailbox.post({kind: "tool", name: "rm_rf", toolCallId: "call-0", params: {}}), (error: unknown) => {
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /divergence at request 0.*tool deploy.*tool rm_rf/);
    return true;
  });
  await assert.rejects(mailbox.next(), TerminalError);
});

test("divergence also rejects a fiber already waiting for the next request", async () => {
  const mailbox = new Mailbox();
  mailbox.markServed(tool(0, "deploy"));
  const waiting = mailbox.next();
  void mailbox.post({kind: "model", model: "faux/faux-1", mode: "stream"}).catch(() => {});
  await assert.rejects(waiting, TerminalError);
});

test("a failure is delivered into pi", async () => {
  const mailbox = new Mailbox();
  const answer = mailbox.post({kind: "tool", name: "deploy", toolCallId: "call-0", params: {}});
  mailbox.markServed(await request(mailbox.next()));
  mailbox.fail(0, new Error("boom"));
  await assert.rejects(answer, /boom/);
});

test("the payload stays in memory and can be awaited before pi posts it", async () => {
  const mailbox = new Mailbox();
  const payload = mailbox.payload<{context: string}>(0);
  void mailbox.post({kind: "model", model: "faux/faux-1", mode: "stream"}, {context: "big"});
  assert.deepEqual(await payload, {context: "big"});
  assert.deepEqual(await mailbox.payload(0), {context: "big"});
});

test("complete and crash end the turn with a done request", async () => {
  const ok = new Mailbox();
  ok.complete({text: "hi"});
  assert.deepEqual((await ok.next()), {seq: 0, kind: "done", outcome: {ok: true, result: {text: "hi"}}});

  const failed = new Mailbox();
  failed.crash(new Error("pi broke"));
  assert.deepEqual((await failed.next()), {seq: 0, kind: "done", outcome: {ok: false, error: "pi broke"}});
});

test("an answer nobody awaits does not become an unhandled rejection", async () => {
  const mailbox = new Mailbox();
  mailbox.fail(7, new Error("ignored"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("idle: pi parked on an answer and quiet lets the fiber stop waiting", async () => {
  const mailbox = new Mailbox();
  void mailbox.post({kind: "tool", name: "deploy", toolCallId: "call-0", params: {}});
  mailbox.markServed(await request(mailbox.next(5)));
  assert.deepEqual(await mailbox.next(5), {kind: "idle"});
});

test("idle: never while pi has nothing outstanding, it is still working", async () => {
  const mailbox = new Mailbox();
  const next = mailbox.next(5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  void mailbox.post({kind: "tool", name: "test", toolCallId: "call-0", params: {}});
  assert.equal(((await next) as PiRequest).seq, 0);
});

test("idle: a post during the quiet window wins", async () => {
  const mailbox = new Mailbox();
  void mailbox.post({kind: "tool", name: "deploy", toolCallId: "a", params: {}});
  mailbox.markServed(await request(mailbox.next(20)));
  const next = mailbox.next(20);
  setTimeout(() => void mailbox.post({kind: "tool", name: "test", toolCallId: "b", params: {}}), 5);
  assert.equal(((await next) as PiRequest).seq, 1);
});

test("idle: an answer delivered in the window keeps the fiber listening", async () => {
  const mailbox = new Mailbox();
  void mailbox.post({kind: "tool", name: "deploy", toolCallId: "a", params: {}});
  mailbox.markServed(await request(mailbox.next(10)));
  const next = mailbox.next(10);
  mailbox.answer(0, "ok"); // pi now has nothing outstanding, so it is working again
  await new Promise((resolve) => setTimeout(resolve, 40));
  mailbox.complete("finished");
  assert.equal((await next).kind, "done");
});
