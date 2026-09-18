# A durable agent loop in six snippets

Companion code for the blog post: an agent loop is just a `while (true)` around a
model call, and by expressing each side effect as a journaled durable step, the same
plain loop picks up concurrency, background work, event-driven wake-ups, live steering
and week-long human approvals without ever changing shape.

Built on Restate's generator SDK, [`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen).

## The ladder

One file per stage, focused on the control flow it introduces. The durable model
call lives in `src/llm-openai.ts`, sandbox setup in `src/sandbox.ts`, fake tools and
guardrails in `src/tools.ts`, and timestamped logging in `src/log.ts`. Shared types
live in `src/types.ts`, and `src/app.ts` serves every stage as its own Restate service.

Step03 defines the reusable `performCall` pipeline imported by steps04–06. The
finale reuses step06's steering loop and send handler, supplying its own tool
pipeline with human approval.

| File | Service | Stage | What changes |
| --- | --- | --- | --- |
| `src/step01.ts` | `step01` | the durable loop | model → tools → repeat; every side effect is a journaled `run`, the batch is concurrent via `all` |
| `src/step02.ts` | `step02` | a guardrail, and why `spawn` exists | guard → tool is a two-step pipeline per call; `spawn` keeps calls parallel and steps sequenced |
| `src/step03.ts` | `step03` | name the pipeline | the spawned body becomes `performCall`; no `gen()` wrapper needed |
| `src/step04.ts` | `step04` | background tool calls | a `background` call is spawned, acked, and appends its own result later |
| `src/step05.ts` | `step05` | the fully task-based loop | every call is a task in a map; `select` wakes the model on the next completion |
| `src/step06.ts` | `step06` | steering, raced in the same select | a durable `steer` signal joins the one `select`, so notes and completions are ordered |
| `src/finale.ts` | `finale` | a person inside a tool call | `humanApproval` drops into `performCall`; the step06 loop is unchanged |

## Run

Prerequisites: Node.js 22+, a Restate server, and an OpenAI API key.

```bash
npm install
export OPENAI_API_KEY=sk-...        # OPENAI_MODEL overrides the default (gpt-5.6-luna)

# a Restate server, in a second terminal (pick one)
npx @restatedev/restate-server
# docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:latest

# every step, one endpoint on :9080
npm run dev

# register once (with the Docker server, register http://host.docker.internal:9080 instead)
npx @restatedev/restate deployments register http://localhost:9080

# invoke a step
curl localhost:8080/step01/run --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}'
```

Every service has a `run` handler that takes a JSON object with a `message` field.
Watch the terminal running `npm run dev`: every model decision, guard verdict and
tool run is logged with a timestamp, so the interleavings are visible.
The Restate timeline and terminal use readable tool labels such as "Deploy to
staging" and "Run e2e tests". Guardrail and approval entries include the same label.

Every handler declares its input and output with Zod via `restate.schemas`.
Each `run` input's `message` field has a default prompt tailored to its stage:
concurrent tools, guardrail rejection, background work, completion-driven follow-ups,
steering, or human approval. These defaults are included in the advertised JSON schemas for
the Restate UI. Send `{"message": "Your instructions here"}` to provide your own
prompt, or `{}` to use the stage's default:

```bash
curl localhost:8080/step04/run --json '{}'
```

After changing handler schemas, rediscover the deployment in Restate to refresh
the playground's input fields and defaults. The dev watcher only reloads code.

The `steer` input defaults `note` to "Please also run the linter."; the `approve`
input defaults `decision` to "approved". Invocation and call IDs are required and
must come from the running demo.

## Steering a running turn (step06, finale)

The turn is addressed by its invocation id, which `/send` returns. The `steer` handler
on the same service is the send side.

```bash
ID=$(curl -s localhost:8080/step06/run/send --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}' | jq -r .invocationId)
curl localhost:8080/step06/steer --json "{\"invocationId\": \"$ID\", \"note\": \"please also run the linter\"}"

# wait for and print the final answer
curl localhost:8080/restate/invocation/$ID/attach
```

## Approving a tool call (finale)

In `finale` every deploy waits for a person. The log prints ready-to-run steer and
approve commands with the invocation and tool call IDs filled in. This approval pause
is also your steering window: send notes before approving, with no time limit.
Other tools finish quickly, and the turn can finish soon after approval.

```bash
ID=$(curl -s localhost:8080/finale/run/send --json '{"message":"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."}' | jq -r .invocationId)
# while the deploy waits, steer it (in the UI, invoke finale/steer with this ID)
curl localhost:8080/finale/steer --json "{\"invocationId\": \"$ID\", \"note\": \"Please also run the linter.\"}"

# take your time; approve only after you are done steering
curl localhost:8080/finale/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"<call id from the log>\", \"decision\": \"approved\"}"
curl localhost:8080/restate/invocation/$ID/attach
```

Any other decision string denies the call, and the model reads the denial as a plain
tool result.

## The model

`src/llm-openai.ts` is `llm` on the OpenAI chat completions API: the transcript in, a
`StepResult` out, still one journaled `run`. The loops import its shared `llm`
generator; the finale reuses step06's loop.

The default `gpt-5.6-luna` uses `reasoning_effort: "none"`, `verbosity: "low"`, and
`service_tier: "fast"` for fast, concise turns. These settings also apply to its
dated snapshots; other `OPENAI_MODEL` overrides use their API defaults.
[Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) uses premium
per-token pricing.

Tool calls are function calls; a `background: true` argument marks a call the loop
should not await within the step (step04). A plain-text reply is the final answer. The
single word `WAIT` means "nothing new to ask, keep waiting" (step05+); a `WAIT` when
nothing is pending is answered with a nudge to finish, because the task-based loops
would otherwise park for good. A plain-text reply while tools are still pending is
treated as `WAIT`, keeping approvals and steering active. Results that land later
than the call they answer (background tasks, select wake-ups) are reported to the
model as user messages, since the API only accepts a tool message directly after
its tool call.

## The fake tools

| Tool | Timeline / log label | Duration | Notes |
| --- | --- | --- | --- |
| `search` | Search code and docs | instant | answers with a pointer to the other tools |
| `rm_rf` | Delete /tmp/old-builds | instant | blocked by the guardrail from step02 onwards |
| `deploy` | Deploy to staging | 300ms | needs approval in the finale |
| `test` | Run e2e tests | 500ms | |
| `lint` | Run linter | instant | |

Labels include the requested path, environment, or test suite when provided.

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | serve every step on port 9080, restarting on file changes |
| `npm start` | same, without the file watcher |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
