// A conversation log in object state, one key per turn. A turn writes only
// what it added, so no single state value, and no journal entry, carries the
// whole conversation.

import * as restate from "@restatedev/restate-sdk-gen";

const TURNS = "history";
const chunk = (turn: number) => `history/${turn}`;

/** Everything logged so far, in order. Works from shared and exclusive handlers. */
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
