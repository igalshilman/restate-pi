// The mailbox is the seam between pi's promise-shaped world and the Restate
// generator runtime.
//
// pi's hooks (`streamFn`, `tool.execute`, a harness driver) never touch
// Restate. They `post` a small request descriptor and await the answer. The
// fiber takes requests with `run(() => mailbox.next())`, which journals the
// descriptor, serves each one as a spawned Operation, and answers
// synchronously. Payloads that are large or not serializable (the model
// context, abort signals) stay in memory and are looked up by sequence number.
//
// Idle: `next` also resolves with `{kind: "idle"}` once pi is parked on
// answers it has not received yet and has gone quiet. The fiber then stops
// waiting on pi until one of those answers is delivered, so no `run` is left
// open across a long wait and Restate can suspend the invocation.
//
// Replay: the fiber races ahead through the journal and parks answers here by
// sequence number while pi's loop re-runs for real and consumes them. Either
// side may arrive first, so every slot is created on demand. A request that
// pi issues differently than the journal recorded is a divergence, and it
// fails the invocation instead of silently continuing.

import {TerminalError} from "@restatedev/restate-sdk";

/** Journaled request descriptors. Small and JSON-friendly by design. */
export type PiRequest =
  | {seq: number; kind: "model"; model: string; mode: "stream" | "deferred"}
  | {seq: number; kind: "tool"; name: string; toolCallId: string; params: unknown}
  | {seq: number; kind: "wait"; reason: "retry" | "deferred"; notBefore?: number; pollAfterMs?: number}
  | {seq: number; kind: "done"; outcome: {ok: true; result: unknown} | {ok: false; error: string}};

/** `Omit` that distributes over a union. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PiRequestInput = Without<PiRequest, "seq">;

/** `next` found pi parked on outstanding answers with nothing more to ask. */
export type Idle = {kind: "idle"};

type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // an answer nobody awaits must not become an unhandled rejection
  return {promise, resolve, reject};
}

interface Slot {
  payload?: unknown;
  payloadWaiters: ((payload: unknown) => void)[];
  answer: Deferred<unknown>;
  settled: boolean;
}

export class Mailbox {
  private nextSeq = 0;
  /** Highest sequence number the fiber has taken, from the journal or live. */
  private served = -1;
  private readonly queue: PiRequest[] = [];
  private waiter: Deferred<PiRequest | Idle> | undefined;
  /** Requests pi posted and is still awaiting an answer for. */
  private readonly unanswered = new Set<number>();
  private readonly slots = new Map<number, Slot>();
  /** Descriptors the fiber took, checked against pi's live posts on replay. */
  private readonly taken = new Map<number, PiRequest>();
  private divergence: TerminalError | undefined;

  // ---- pi side ------------------------------------------------------------

  /** Post a request and await the fiber's answer. */
  post<T>(request: PiRequestInput, payload?: unknown): Promise<T> {
    const seq = this.nextSeq++;
    const full = {...request, seq} as PiRequest;
    const journaled = this.taken.get(seq);
    if (journaled && !sameRequest(journaled, full)) {
      this.divergence = new TerminalError(
        `pi replay divergence at request ${seq}: the journal has ${describeRequest(journaled)}, pi asked for ${describeRequest(full)}`,
      );
      this.waiter?.reject(this.divergence);
      this.waiter = undefined;
      return Promise.reject(this.divergence);
    }
    const slot = this.slot(seq);
    slot.payload = payload;
    if (full.kind !== "done" && !slot.settled) this.unanswered.add(seq);
    for (const wake of slot.payloadWaiters.splice(0)) wake(payload);
    if (this.waiter && seq > this.served) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(full);
    } else {
      this.queue.push(full);
    }
    return slot.answer.promise as Promise<T>;
  }

  /** pi's work for this turn finished with `result`. */
  complete(result: unknown): void {
    void this.post({kind: "done", outcome: {ok: true, result}});
  }

  /** pi's work for this turn failed. */
  crash(error: unknown): void {
    void this.post({kind: "done", outcome: {ok: false, error: error instanceof Error ? error.message : String(error)}});
  }

  // ---- fiber side ---------------------------------------------------------

  /**
   * Inside `run`: the next request pi has not been served yet. With
   * `idleAfterMs`, resolves with `{kind: "idle"}` instead once pi is awaiting
   * answers and has posted nothing for that long.
   */
  next(idleAfterMs?: number): Promise<PiRequest | Idle> {
    if (this.divergence) return Promise.reject(this.divergence);
    while (this.queue.length > 0) {
      const request = this.queue.shift()!;
      if (request.seq > this.served) return Promise.resolve(request);
    }
    const waiter = (this.waiter = deferred<PiRequest | Idle>());
    if (idleAfterMs !== undefined) this.watchIdle(waiter, idleAfterMs);
    return waiter.promise;
  }

  private watchIdle(waiter: Deferred<PiRequest | Idle>, ms: number): void {
    let seen = this.nextSeq;
    const timer = setInterval(() => {
      if (this.waiter !== waiter) {
        clearInterval(timer);
      } else if (this.nextSeq === seen && this.unanswered.size > 0) {
        clearInterval(timer);
        this.waiter = undefined;
        waiter.resolve({kind: "idle"});
      }
      seen = this.nextSeq;
    }, ms);
  }

  /** The request came back from `run`, journaled or live. */
  markServed(request: PiRequest): void {
    this.served = Math.max(this.served, request.seq);
    this.taken.set(request.seq, request);
  }

  /** Inside `run`: the in-memory payload of a request, once pi has posted it. */
  payload<P>(seq: number): Promise<P> {
    const slot = this.slot(seq);
    if (slot.payload !== undefined) return Promise.resolve(slot.payload as P);
    return new Promise((resolve) => slot.payloadWaiters.push((payload) => resolve(payload as P)));
  }

  /** Deliver an answer into pi. Safe before pi has even asked. */
  answer(seq: number, value: unknown): void {
    this.settle(seq).answer.resolve(value);
  }

  /** Deliver a failure into pi; a tool failure becomes an error tool result. */
  fail(seq: number, error: unknown): void {
    this.settle(seq).answer.reject(error);
  }

  private settle(seq: number): Slot {
    const slot = this.slot(seq);
    slot.settled = true;
    this.unanswered.delete(seq);
    return slot;
  }

  private slot(seq: number): Slot {
    let slot = this.slots.get(seq);
    if (!slot) {
      slot = {payloadWaiters: [], answer: deferred<unknown>(), settled: false};
      this.slots.set(seq, slot);
    }
    return slot;
  }
}

function sameRequest(a: PiRequest, b: PiRequest): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tool" && b.kind === "tool") return a.name === b.name && a.toolCallId === b.toolCallId;
  if (a.kind === "model" && b.kind === "model") return a.mode === b.mode;
  return true;
}

export function describeRequest(request: PiRequest): string {
  switch (request.kind) {
    case "model": return `${request.mode === "deferred" ? "deferred poll" : "model call"} (${request.model})`;
    case "tool": return `tool ${request.name} (${request.toolCallId})`;
    case "wait": return `${request.reason} wait`;
    case "done": return request.outcome.ok ? "done" : `failed: ${request.outcome.error}`;
  }
}
