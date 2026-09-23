// The fiber loop. One `select` races pi's next request, the `steer` signal
// and every task in flight, so their order is journaled and identical on
// replay. Each request becomes a spawned Operation; its result is delivered
// into pi synchronously.
//
//   pi (async)                        fiber (generator)
//   post ────────────────────────▶    run(() => mailbox.next())  → spawn(serve(request))
//        ◀──── answer(seq, value) ──  task settles
//
// While pi is parked on answers the fiber stops waiting on it (`next` came
// back idle) and waits on the tasks alone, so a long tool call, timer or
// awakeable leaves no `run` open and the invocation can suspend.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError, type InvocationId} from "@restatedev/restate-sdk";
import type {Models} from "@earendil-works/pi-ai";
import {describeRequest, type Idle, type Mailbox, type PiRequest} from "./mailbox.js";
import {askModel, type AskModelOptions} from "./model.js";
import type {GenTool} from "./tools.js";

/** A request the fiber has to serve; `done` ends the loop instead. */
export type ServedRequest = Exclude<PiRequest, {kind: "done"}>;

export interface ServeOptions extends AskModelOptions {
  mailbox: Mailbox;
  /** The real model runtime, used for the actual provider call inside `run`. */
  models: Models;
  tools: readonly GenTool[];
}

/** Serve one request as an Operation: a model call, a tool call, or a durable wait. */
export function* serveRequest(request: ServedRequest, opts: ServeOptions): restate.Operation<unknown> {
  switch (request.kind) {
    case "model":
      return yield* askModel(opts.mailbox, opts.models, request.seq, opts);
    case "tool": {
      const t = opts.tools.find((candidate) => candidate.name === request.name);
      if (!t) throw new Error(`unknown tool ${request.name}`);
      return yield* t.execute(request.params, {toolCallId: request.toolCallId, label: t.label});
    }
    case "wait": {
      // A harness wants time to pass. Journal the delay, then sleep durably.
      const ms = yield* restate.run(
        async () =>
          request.reason === "retry"
            ? Math.max(0, (request.notBefore ?? 0) - Date.now())
            : (request.pollAfterMs ?? 5_000),
        {name: request.reason === "retry" ? "Retry backoff" : "Poll delay"},
      );
      yield* restate.sleep(ms, request.reason === "retry" ? "Retry wait" : "Poll wait");
      return "again";
    }
  }
}

/**
 * What the steer signal carries. A bare string is fire-and-forget. With `ack`,
 * the turn resolves that awakeable with `true` once the note is in pi (or in a
 * follow-up turn) and with `false` if it drops the note, so the sender knows
 * whether it arrived. `steerTurn` sends this shape.
 */
export type SteerMessage = string | {note: string; ack?: string};

export interface PiLoopOptions {
  /** How to serve each request; usually `serveRequest` with your tools and models. */
  serve(request: ServedRequest): restate.Operation<unknown>;
  /** Deliver a steering note into pi. Called on the fiber's synchronous span. */
  onSteer?(note: string): void;
  /**
   * Steering notes that arrived after pi had already finished its turn. Start a
   * follow-up turn for them on the same mailbox (pi is idle at this point).
   * Omitted: such notes are dropped, with a log line.
   */
  onLateSteer?(notes: string[]): void;
  /** Name of the signal that carries steering notes. Default `"steer"`. */
  steerSignal?: string;
  /**
   * How long pi must stay quiet, while awaiting answers, before the fiber
   * stops waiting on it. Default 50 ms. Too short only delays a late request
   * until the next answer is delivered.
   */
  idleAfterMs?: number;
  /** Diagnostics: what pi asks for, steers held or delivered, failures. */
  log?(message: string): void;
}

/**
 * Drive pi to completion and return what it reported through
 * `mailbox.complete`. Throws a `TerminalError` if pi reported a failure.
 * With `onLateSteer`, notes that arrive after pi finished start a follow-up
 * turn and the result of the last turn is returned.
 *
 * A steering note is delivered only while pi is blocked on an outstanding
 * request; otherwise it is held until the next request arrives. That pins the
 * note's position in pi's transcript, so replay reproduces it. Notes sent with
 * `steerTurn` are acknowledged once delivered, handed to `onLateSteer`, or
 * dropped.
 */
export function* servePi<R>(mailbox: Mailbox, opts: PiLoopOptions): restate.Operation<R> {
  const log = opts.log ?? (() => {});
  const steerName = opts.steerSignal ?? "steer";
  const tasks = new Map<string, restate.Task<unknown>>();
  const held: Steer[] = [];
  const idleAfterMs = opts.idleAfterMs ?? 50;
  const awaitPi = () => restate.run(() => mailbox.next(idleAfterMs), {name: "Await pi"});
  let next: restate.Future<PiRequest | Idle> | undefined = awaitPi();
  let steer = restate.signal<SteerMessage>(steerName);
  const deliver = (s: Steer) => {
    opts.onSteer?.(s.note);
    acknowledge(s, true);
  };

  while (true) {
    // With nothing in flight pi is working, not parked: its next request is coming.
    if (!next && tasks.size === 0) next = awaitPi();
    const branches: Record<string, restate.Future<unknown>> = {steer, ...Object.fromEntries(tasks)};
    if (next) branches.next = next;
    const won = yield* restate.select(branches);

    if (won.tag === "next") {
      const request = yield* next!;
      if (request.kind === "idle") {
        next = undefined; // wake pi's side again once an answer is delivered
        continue;
      }
      mailbox.markServed(request);
      if (request.kind === "done") {
        if (!request.outcome.ok) throw new TerminalError(`pi failed: ${request.outcome.error}`);
        if (held.length > 0 && opts.onLateSteer) {
          // pi finished before these notes could be delivered: make them the next turn.
          const notes = held.splice(0);
          log(`${notes.length} steering note(s) arrived after pi finished; starting a follow-up turn`);
          opts.onLateSteer(notes.map((s) => s.note));
          for (const s of notes) acknowledge(s, true);
          next = awaitPi();
          continue;
        }
        if (held.length) log(`${held.length} steering note(s) arrived after pi finished and were dropped`);
        for (const s of held.splice(0)) acknowledge(s, false);
        return request.outcome.result as R;
      }
      log(`pi asks for ${describeRequest(request)}`);
      tasks.set(String(request.seq), restate.spawn(opts.serve(request)));
      next = awaitPi();
      // pi is now parked on this request: a held note lands at a fixed point.
      for (const s of held.splice(0)) deliver(s);
      continue;
    }

    if (won.tag === "steer") {
      const message = yield* steer;
      steer = restate.signal<SteerMessage>(steerName);
      const s: Steer = typeof message === "string" ? {note: message} : message;
      if (tasks.size > 0) {
        log(`steer delivered: ${s.note}`);
        deliver(s);
      } else {
        log(`steer held until pi's next request: ${s.note}`);
        held.push(s);
      }
      continue;
    }

    const seq = Number(won.tag);
    const task = tasks.get(won.tag)!;
    tasks.delete(won.tag);
    try {
      mailbox.answer(seq, yield* task);
    } catch (error) {
      log(`request ${seq} failed: ${error instanceof Error ? error.message : String(error)}`);
      mailbox.fail(seq, error);
    }
    // pi reacts to the answer; listen for what it asks next.
    next ??= awaitPi();
  }
}

type Steer = {note: string; ack?: string};

function acknowledge(s: Steer, delivered: boolean): void {
  if (s.ack) restate.resolveAwakeable(s.ack, delivered);
}

/**
 * Sender side: steer the turn running as `invocationId` and wait until it
 * confirms. Returns `true` once the note is in pi, `false` if the turn dropped
 * it or ended without taking it (the signal came too late, or the turn failed).
 * On `false` the caller still owns the note, e.g. to start a new turn with it.
 */
export function* steerTurn(invocationId: string, note: string, steerSignal = "steer"): restate.Operation<boolean> {
  const {id, promise: ack} = restate.awakeable<boolean>();
  restate.invocation(invocationId).signal<SteerMessage>(steerSignal).resolve({note, ack: id});
  // A turn resolves the ack before it ends, and both completions reach this
  // invocation in that order, so `ack` wins whenever the turn took the note.
  const won = yield* restate.select({ack, ended: restate.attach(invocationId as InvocationId)});
  return won.tag === "ack" ? yield* ack : false;
}

/** pi side: run pi's work for this turn and report its outcome to the fiber. */
export function runPi<R>(mailbox: Mailbox, work: () => Promise<R>): void {
  work().then(
    (result) => mailbox.complete(result),
    (error: unknown) => mailbox.crash(error),
  );
}
