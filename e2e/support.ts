// The e2e harness. `e2e(name, services, suite)` runs `suite` once per mode
// against a fresh Restate server in Docker, started by the SDK's testcontainers:
//
// - live: the server keeps an invocation's stream open while it makes progress;
// - always replaying: the server suspends at every await and replays the whole
//   journal to continue, so any non-determinism between an execution and its
//   replay (pi issuing different requests, a step taken in a different order)
//   fails the test.
//
// Retries are disabled, so such a failure surfaces at once instead of retrying.
// E2E_MODES=live or E2E_MODES=replay runs one mode only.

import {after, before, describe} from "node:test";
import {RestateTestEnvironment, type TestEnvironmentOptions} from "@restatedev/restate-sdk-testcontainers";

export interface Mode {
  label: string;
  alwaysReplay: boolean;
}

const MODES: Mode[] = [
  {label: "live", alwaysReplay: false},
  {label: "always replaying", alwaysReplay: true},
];

function modes(): Mode[] {
  const only = process.env.E2E_MODES;
  if (!only) return MODES;
  return MODES.filter((mode) => (mode.alwaysReplay ? "replay" : "live") === only);
}

type Named = {name: string};

/** What a suite uses to talk to the running server. */
export interface E2E {
  readonly mode: Mode;
  /** POST to a handler; no body when `body` is undefined. */
  call<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** Start a handler without waiting, returning the invocation id. */
  send(path: string, body: unknown): Promise<string>;
  /** Wait for an invocation's result. */
  attach<T = unknown>(invocationId: string): Promise<T>;
  getState<T>(object: Named, key: string, name: string): Promise<T | null>;
  setState(object: Named, key: string, name: string, value: unknown): Promise<void>;
  /** Run SQL against the server's introspection tables. */
  query<T>(sql: string): Promise<T[]>;
}

export function e2e(name: string, services: TestEnvironmentOptions["services"], suite: (t: E2E) => void): void {
  for (const mode of modes()) {
    describe(`${name} (${mode.label})`, () => {
      let env: RestateTestEnvironment | undefined;
      before(async () => {
        env = await RestateTestEnvironment.start({services, alwaysReplay: mode.alwaysReplay, disableRetries: true});
      });
      after(async () => env?.stop());
      suite(client(mode, () => {
        if (!env) throw new Error("the Restate server is not running");
        return env;
      }));
    });
  }
}

function client(mode: Mode, env: () => RestateTestEnvironment): E2E {
  const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${url}: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    mode,
    call: (path, body) =>
      request(`${env().baseUrl()}/${path}`, {
        method: "POST",
        headers: body === undefined ? {} : {"content-type": "application/json"},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      }),
    send: async (path, body) =>
      (
        await request<{invocationId: string}>(`${env().baseUrl()}/${path}/send`, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(body),
        })
      ).invocationId,
    attach: (id) => request(`${env().baseUrl()}/restate/invocation/${id}/attach`),
    getState: (object, key, name) => env().stateOf(object as never, key).get(name),
    setState: (object, key, name, value) => env().stateOf(object as never, key).set(name, value),
    query: async (sql) =>
      (
        await request<{rows: never[]}>(`${env().adminAPIBaseUrl()}/query`, {
          method: "POST",
          headers: {"content-type": "application/json", accept: "application/json"},
          body: JSON.stringify({query: sql}),
        })
      ).rows,
  };
}

// ---- waiting and logs --------------------------------------------------------

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns a value that is not null or false. */
export async function eventually<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Everything the services print, so a test can see how often an effect really ran. */
const lines: string[] = [];
const print = console.log;
console.log = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
  print(...args);
};

export const logs = {
  /** A cursor: pass it to `count` or `until` to look only at what came after. */
  mark: () => lines.length,
  count: (pattern: RegExp, since: number) => lines.slice(since).filter((line) => pattern.test(line)).length,
  until: (pattern: RegExp, since: number) => eventually(`a log line matching ${pattern}`, async () => lines.slice(since).some((line) => pattern.test(line))),
};
