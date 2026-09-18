// One endpoint, every step: `npm run dev`, then
// `restate deployments register http://localhost:9080` once.

import {serve} from "@restatedev/restate-sdk";
import {step01} from "./step01.js";
import {step02} from "./step02.js";
import {step03} from "./step03.js";
import {step04} from "./step04.js";
import {step05} from "./step05.js";
import {step06} from "./step06.js";
import {finale} from "./finale.js";

serve({services: [step01, step02, step03, step04, step05, step06, finale], port: 9080});
