// The approval example. PORT overrides the listen port.
//   pnpm dev
//   restate deployments register http://localhost:9080

import {serve} from "@restatedev/restate-sdk";
import {releaseAgent} from "./release-agent.js";

serve({services: [releaseAgent], port: Number(process.env.PORT ?? 9080)});
