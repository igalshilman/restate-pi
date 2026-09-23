// A pi session as a Restate virtual object: the object key is the session.
// These helpers are what `agentObject` is built from, for objects written by
// hand around another pi layer (the harness, the coding agent).
//
// State layout: `invocation` marks the running turn; `history` counts turns
// and `history/<n>` holds what turn n added, so a turn writes only its own part.
//
// Steering: the running turn records its invocation id; the shared `steer`
// handler reads it and hands the note over with `steerTurn`. If no turn is
// running, or the turn ends without taking the note, the note becomes the next
// turn: the handler sends a `prompt` to its own object.

import * as restate from "@restatedev/restate-sdk-gen";
import {TerminalError} from "@restatedev/restate-sdk";
import {steerTurn} from "./loop.js";

type TurnState = {invocation: string};

const TURNS = "history";
const chunk = (turn: number) => `history/${turn}`;

/** Run `body` as the object's current turn, so `steer` can find it. The marker
 * is cleared however the turn ends; a retryable error keeps it, since the
 * invocation is still alive and will run again. */
export function* currentTurn<T>(body: restate.Operation<T>): restate.Operation<T> {
  const state = restate.state<TurnState>();
  state.set("invocation", restate.handlerRequest().id);
  try {
    const result = yield* body;
    state.clear("invocation");
    return result;
  } catch (error) {
    if (error instanceof TerminalError) state.clear("invocation");
    throw error;
  }
}

/** A shared `steer({note})` handler for the object called `objectName`, which must have a `prompt({message})` handler. */
export function steerHandler(objectName: string) {
  // An interface, not the object itself: the object refers to this handler.
  const target = restate.iface.object(objectName, {prompt: restate.iface.json<{message: string}, string>()});
  return function* steer(input: {note?: string} | undefined): restate.Operation<string> {
    const note = input?.note;
    if (!note) throw new TerminalError("steer needs a note", {errorCode: 400});
    const invocation = yield* restate.sharedState<TurnState>().get("invocation");
    if (invocation && (yield* steerTurn(invocation, note))) return `steer delivered to ${invocation}`;
    const key = restate.handlerRequest().key ?? "default";
    const started = yield* restate.sendClient(target, key).prompt({message: note});
    return `no turn took the note; it starts a new turn ${started.id}`;
  };
}

/** Everything the session has logged, in order. Works from shared and exclusive handlers. */
export function* loadHistory<T>(state: restate.SharedState): restate.Operation<T[]> {
  const turns = (yield* state.get<number>(TURNS)) ?? 0;
  const chunks = yield* restate.all(Array.from({length: turns}, (_, turn) => state.get<T[]>(chunk(turn))));
  return chunks.flatMap((items) => items ?? []);
}

/** Log what this turn added. */
export function* appendHistory<T>(added: readonly T[]): restate.Operation<void> {
  if (added.length === 0) return;
  const state = restate.state();
  const turns = (yield* state.get<number>(TURNS)) ?? 0;
  state.set(chunk(turns), added);
  state.set(TURNS, turns + 1);
}
