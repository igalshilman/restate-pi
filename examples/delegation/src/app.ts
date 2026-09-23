// The delegation example. PORT overrides the listen port.
//   pnpm dev
//   restate deployments register http://localhost:9080

import {serve} from "@restatedev/restate-sdk";
import {lead, researcher} from "./agents.js";

serve({services: [lead, researcher], port: Number(process.env.PORT ?? 9080)});
