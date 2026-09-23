// pi's durable AgentHarness, hosted by Restate. The harness spec says a
// serving layer may schedule `drive` through alarms or another host runtime.
// `driveToSettlement` is that serving layer: accept, then loop on `drive`,
// asking the fiber to sleep whenever the harness reports a durable wait. The
// session helpers move the conversation tree in and out of the process
// through the public Session API, so it can live in object state.

import {
  BACKGROUND_CONTEXT,
  insertEntry,
  type AgentLane,
  type Context,
  type Entry,
  type NewEntry,
  type OperationRequest,
  type OperationResultRecord,
  type AgentMessage,
  type Session,
} from "@earendil-works/pi-agent-core";
import type {Mailbox} from "./mailbox.js";

export interface DriveOptions {
  lane: AgentLane;
  /** The operation to accept. Supply `operationId` yourself when it must be stable across replay. */
  request: OperationRequest;
  mailbox: Mailbox;
  context?: Context;
}

/** Accept the request, then drive until it settles. Plain async: pi's side of the bridge. */
export async function driveToSettlement(opts: DriveOptions): Promise<OperationResultRecord> {
  const context = opts.context ?? BACKGROUND_CONTEXT;
  const accepted = await opts.lane.accept(opts.request, context);
  if (!accepted.ok) throw new Error(`pi refused the operation: ${JSON.stringify(accepted.error)}`);
  const operationId = accepted.value.operationId;

  let pollDeferred = false;
  for (;;) {
    const driven = await opts.lane.drive({operationId, waitForRetry: false, pollDeferred}, context);
    if (!driven.ok) throw new Error(`drive failed: ${JSON.stringify(driven.error)}`);
    const outcome = driven.value;
    if (outcome.kind === "settled") return outcome.outcome;
    if (outcome.reason === "retry") {
      await opts.mailbox.post({kind: "wait", reason: "retry", notBefore: outcome.notBefore});
    } else {
      await opts.mailbox.post({kind: "wait", reason: "deferred", pollAfterMs: outcome.deferred.pollAfterMs});
      pollDeferred = true;
    }
  }
}

/** What survives between turns: the conversation tree and one branch tip. */
export interface SessionSnapshot {
  entries: Entry[];
  tip: string | null;
}

/** Read the whole tree and a branch tip through the public Session API. */
export async function captureSession(session: Session, branch: string, context = BACKGROUND_CONTEXT): Promise<SessionSnapshot> {
  const entries = await session.findEntries({order: "asc"}, context);
  const b = await session.branch(branch, context);
  return {entries, tip: b ? await b.getTipId(context) : null};
}

/** Re-insert the tree with its original ids in one transaction, then point
 * the branch at the saved tip. A harness attaches the branch as its lane. */
export async function restoreSession(session: Session, snapshot: SessionSnapshot, branch: string, context = BACKGROUND_CONTEXT): Promise<void> {
  if (snapshot.entries.length > 0) {
    await session.mutate(async (mutator) => {
      await mutator.commit(
        snapshot.entries.map((entry) => {
          const {seq: _seq, timestamp: _timestamp, ...rest} = entry;
          return insertEntry(rest as NewEntry);
        }),
        context,
      );
    }, context);
  }
  await session.createBranch(branch, snapshot.tip, context);
}

/** The messages in a tree, in order. */
export function messagesOf(entries: readonly Entry[]): AgentMessage[] {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}
