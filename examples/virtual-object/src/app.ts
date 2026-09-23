// One endpoint, three pi objects. PORT overrides the listen port.
//   pnpm dev
//   restate deployments register http://localhost:9080

import {serve} from "@restatedev/restate-sdk";
import {piAgent} from "./agent-object.js";
import {piHarness} from "./harness-object.js";
import {piCoding} from "./coding-object.js";

serve({services: [piAgent, piHarness, piCoding], port: Number(process.env.PORT ?? 9080)});
