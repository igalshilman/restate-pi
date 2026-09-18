import * as restate from "@restatedev/restate-sdk-gen";
import {log} from "./log.js";
import type {SandboxRef} from "./types.js";

/** Provisions a sandbox once per turn; replay returns the journaled ref. */
export function* connect(): restate.Operation<SandboxRef> {
  return yield* restate.run(async () => provisionSandbox(), {name: "Provision sandbox"});
}

/** Fake sandbox provisioning: returns a plain, journal-friendly reference. */
async function provisionSandbox(): Promise<SandboxRef> {
  const id = `sbx-${crypto.randomUUID().slice(0, 8)}`;
  log("sandbox", `provisioned ${id}`);
  return {id, url: `https://sandbox.example.com/${id}`};
}
