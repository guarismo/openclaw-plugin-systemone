# systemone: OpenClaw decision provider for System One servers

Date: 2026-10-11
Status: approved design, pending spec review

## Goal

A published OpenClaw plugin (`openclaw-plugin-systemone`, plugin id `systemone`) that registers a
decision-model provider for any server speaking the System One API (`POST /v1/systemone`). That
includes Kev, llama.cpp `llama-server` in router mode, and others. With it, OpenClaw's
`decision_evaluate` tool, the Control UI **Decision** picker and Decision-assistance consumers can
use a self-hosted System One model.

The official `@openclaw/typesafe` plugin can't serve this use case:

- it accepts only loopback `baseUrl` origins;
- (corrected 2026-10-12) this spec originally said local requests always carry the label
  `kev-latest`. That was wrong: TypeSafe sends the selected model, so `typesafe/clef-flash` sends
  `clef-flash` (confirmed in openclaw/openclaw#169855). Only the other two limits apply;
- it has no API key for local servers.

### Success criteria

1. With `agents.defaults.decisionModel: "systemone/default"` and the plugin configured for
   `http://10.20.10.7:8080` with model `clef-flash`, an agent's `decision_evaluate` call
   returns clef-flash's typed answers for choice, score and boolean questions.
2. `clawhub package validate` passes for the current OpenClaw release.
3. Every failure mode maps to a contract `ProviderFailureReason`, and no secret or submitted
   state leaves the plugin in diagnostics.

### Audience

Published on GitHub (`guarismo/openclaw-plugin-systemone`) and ClawHub for other operators.
Hardening, docs and tests are scoped for unknown users.

### Non-goals

- Hosted TypeSafe Jev (use `@openclaw/typesafe`).
- Querying the server's model list for the picker. The picker reads static manifest metadata only.
- Retries, circuit breaking or caching. Those belong to the host and consumers.
- Changing OpenClaw core.

## Approach

A new plugin following the layout of `~/openclaw-plugins/multimodal-embeddings`: TypeScript built
with `tsc`, vitest, a local `sdk.d.ts` for SDK typings, an `npm run validate` script that runs
`clawhub package validate`, and the MIT license.

Request building and response validation are adapted from the MIT-licensed `@openclaw/typesafe`
source (`extensions/typesafe/src/{schema,client,local}.ts` in `openclaw/openclaw`), credited in
the README and LICENSE notice. Everything specific to hosted Jev is dropped.

Rejected alternatives:

- **A cut-down fork of the typesafe directory.** It inherits monorepo-only imports and build
  tooling, and upstream changes would mean merging diffs.
- **A wrapper over the installed typesafe.** The client isn't exported, so the URL check and the
  model label can't be overridden.

## Section 1: package, manifest, config

### Manifest (`openclaw.plugin.json`)

- `id: "systemone"`, `enabledByDefault: false`, `activation.onStartup: true`.
- `contracts.decisionProviders: ["systemone"]`.
- `decisionModels`: one entry:
  `{ "provider": "systemone", "id": "default", "name": "System One (configured model)",
  "capabilities": { "questionTypes": ["boolean","choice","score"], "confidence": "provider-specific" } }`.
- `configContracts.secretInputs.paths`: `[{ "path": "apiKey", "expected": "string", "ownerKind": "capability" }]`.
- `uiHints` for `baseUrl`, `apiKey` (sensitive), `model` and `timeoutMs` (advanced).
- `configSchema`, as JSON Schema, `additionalProperties: false`.

### Config (`plugins.entries.systemone.config`)

| Field | Type | Default | Rules |
|---|---|---|---|
| `baseUrl` | string | required | An `http:` or `https:` origin with any host and an optional port and trailing slash. Paths, userinfo, query strings and fragments are rejected. At most 256 characters. The plugin appends `/v1/systemone`. |
| `apiKey` | string or SecretRef `{source: env\|file\|exec\|store, provider, id}` | unset | Same shape as LLM provider `apiKey`. When set and non-empty after resolution, it's sent as `Authorization: Bearer <key>`. |
| `model` | string, 1 to 128 characters | unset | The wire label for `systemone/default`. When unset, no `model` field is sent. |
| `timeoutMs` | integer, 1,000 to 300,000 | 30,000 | Per-request cap. |

The runtime reads `apiKey` already resolved from the plugin's runtime config, because the host
materializes declared `secretInputs` at startup. The plugin never logs or echoes it.

### Model selection

- `systemone/default` sends `config.model`, or no `model` field when it's unset.
- `systemone/<name>` with any other id sends `<name>` as the wire label. This depends on the host
  accepting decision-model references that aren't in the manifest. **Implementation step 1
  verifies this.** If the host rejects such references, the README documents `default` only and
  pass-through stays as harmless dead code that the tests still cover.

Example:

```json5
plugins: { entries: { systemone: { enabled: true, config: {
  baseUrl: "http://10.20.10.7:8080", model: "clef-flash" } } } },
agents: { defaults: { decisionModel: "systemone/default" } }
```

## Section 2: components and data flow

| File | Responsibility | Depends on |
|---|---|---|
| `src/config.ts` | Parse and validate the runtime config into `{ baseUrl, apiKey?, model?, timeoutMs }`. Return `undefined` when `baseUrl` is missing or invalid. | none |
| `src/schema.ts` | System One request and response shapes. Validate the response against the exact question batch. | none |
| `src/transport.ts` | A single POST through `fetchWithSsrFGuard`, with headers, timeout, the size cap and HTTP-to-reason mapping. | `openclaw/plugin-sdk/ssrf-runtime` |
| `src/provider.ts` | The `DecisionProviderV1` implementation: choose the label, translate the batch, call the transport, translate the answers. | config, schema, transport |
| `src/index.ts` | `definePluginEntry` that registers the provider. | provider |
| `src/sdk.d.ts` | Local typings for the SDK subpaths used. | none |

Flow: a consumer (`decision_evaluate`) → the host validates the batch → `provider.evaluate(batch,
context)` → `transport` POSTs to `${baseUrl}/v1/systemone` → `schema` validates the response →
the provider translates the answers → the host validates the result.

### Details

- **SSRF:** the policy is `ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl)`. It trusts exactly the
  configured origin, including private and LAN addresses, and nothing else. Redirects off that
  origin fail.
- **Headers:** `Content-Type: application/json`, plus `Authorization: Bearer <key>` only when a
  key is present.
- **Body:** `{ state, questions, model? }`. Host `boolean` questions become `{ type: "noul", ... }`.
  Score criteria are normalized to strings, as typesafe's `localInput` does.
- **Timeout:** `min(timeoutMs, context.deadlineMonotonicMs - now)`, combined with `context.signal`.
  When no time remains, the result is `transport` without a request.
- **Response:** read at most 4 MiB. Must be JSON. Strip a numeric `latency_ms` if present.
  Validate:
  - `model` is a string;
  - `answers` has exactly the batch's ids and types;
  - every probability is finite and in [0, 1], and a distribution's mass is positive;
  - a choice is one of the offered labels;
  - score probabilities are keyed `"0".."N-1"`, `score` is in [0, N-1], and the `legend`
    matches the criteria;
  - `usage.input_tokens` and `usage.output_tokens` are non-negative integers.
- **Result:**
  - `noul` becomes `{ type: "boolean", probabilityTrue }`;
  - choices pass through;
  - scores become `{ type: "score", score, confidence, probabilities: criteria-aligned array }`;
  - plus `model` and `usage: { inputTokens, outputTokens }`.

## Section 3: error handling

Failures return `{ status: "unavailable", reason }` with these reasons:

| Condition | Reason |
|---|---|
| `baseUrl` missing or invalid | `isReady()` is false, and the host reports `not-configured` |
| A SecretRef `apiKey` that is configured but doesn't resolve | `credentials-unavailable` |
| HTTP 401 or 403 | `authentication` |
| HTTP 429 | `rate-limited`, with a bounded `retryAfterMs` from `retry-after-ms` or `retry-after` |
| HTTP 400, 413 or 422 | `unsupported-input` |
| Any other non-2xx, a network error, DNS failure, timeout, abort, blocked redirect or SSRF block | `transport` |
| Bad JSON, a response over the size cap, or a schema or batch mismatch | `invalid-response` |
| A plugin bug that is not an expected failure | thrown, so the host treats it as an adapter contract failure |

Diagnostics:

- One `api.logger.warn` line per failure, for example
  `systemone: HTTP 400 from http://10.20.10.7:8080 (model "kev-latest" not found)`.
- The server message is cut to 200 characters, control characters are stripped, and anything that
  looks like a bearer token is masked.
- The line never includes the API key, request state or question content. The origin is logged
  without credentials.

There are no retries in the plugin.

## How agents use it

The README gets a "How agents use it" section covering these three consumers. The plugin itself
adds no consumer.

1. **`decision_evaluate` tool.** Any agent with an effective `decisionModel` gets this core tool,
   subject to tool policy. The agent decides when to call it, and passes explicit `state` plus a
   `questions` map of choice, score or boolean questions. The tool reads no conversation on its
   own. Agents rarely reach for it unprompted, so the README shows an `AGENTS.md` or skill line
   that tells the agent when to use it. For example: "To triage a forwarded email, call
   `decision_evaluate` with a phishing/scam/spam/legitimate choice and a severity score."
2. **Decision assistance (experimental tool filtering).** This only runs when
   `agents.defaults.experimental.decisionAssistance: true`. Before an eligible user turn, the
   current request and up to about 6,000 UTF-16 code units of recent conversation go to the
   decision model, and optional tools may be dropped for conversational turns. The README warns
   that this sends chat content to the configured `baseUrl` on every eligible turn.
3. **Other plugins.** They call `api.runtime.decisions.evaluate(...)` without handling credentials.

Recommended rollout in the README:

- select the model for one agent first, with `agents.entries.<id>.decisionModel: "systemone/default"`;
- add the `AGENTS.md` guidance;
- leave Decision assistance off until the tool's behavior has been checked.

## Section 4: testing and release

Unit tests (vitest), one file per module:

- `config.test.ts`:
  - origin rules: accept http/https, LAN IPs, hostnames, ports and a trailing slash; reject
    paths, userinfo, query strings, fragments, other schemes and too-long values;
  - the `timeoutMs` bounds and default;
  - `apiKey` that is a string, empty or missing.
- `schema.test.ts`:
  - recorded clef-flash responses for choice, score with legend, and noul pass;
  - rejections: mismatched ids or types, extra or missing answers, out-of-range or zero-mass
    probabilities, a choice that wasn't offered, a mismatched legend, an out-of-range score,
    extra fields, bad usage.
- `transport.test.ts`, with a mocked guarded fetch:
  - the URL and headers, and that the Bearer header is sent only when a key is set;
  - every row of the error table;
  - the deadline and abort handling;
  - `retry-after` parsing;
  - the log line contains no secrets or state.
- `provider.test.ts`:
  - the label rules (`default` with a model, `default` without one, pass-through);
  - boolean to `noul` and back;
  - result model, usage and score array alignment.

Manual live checks on megatron, documented in the README:

1. Step 1: does the host accept `systemone/<name>` decision-model references that aren't in the
   manifest?
2. Install from the local path, configure `http://10.20.10.7:8080` with model `clef-flash`, select
   it for one test agent, and run `decision_evaluate` with choice, score and boolean questions.
   `plugins inspect` shows ready, last success and usage.
3. A wrong model label produces `unsupported-input` and the diagnostic line.

Release:

- `npm run validate` against the current OpenClaw release and the next beta;
- a README covering setup for Kev, the llama-server router and authenticated servers, plus a
  security section and the typesafe attribution;
- version 0.1.0 on GitHub and ClawHub, published only with the owner's explicit OK.

## Verification (2026-10-11)

Run on megatron with OpenClaw 2026.10.1, against a llama.cpp router at `http://10.20.10.7:8080`
serving `clef-flash`. The test agent was starscream (sandbox `mode: all`, chat model
gemma-4-12b-qat, deferred tools).

- **Package:** 79/79 unit tests pass. `clawhub package validate . --openclaw-version 2026.10.1`
  gives Plugin Inspector PASS with 0 breakages, 0 warnings and no findings.
- **Install:** `openclaw plugins install <path> --link --force` (a local source needs `--force`).
  The config change hot-reloads with no gateway restart. A changed `dist/` does need a restart.
- **Sandboxed agents:** `decision_evaluate` must be added to `tools.sandbox.tools.alsoAllow` (and
  `tools.alsoAllow`) for agents with sandbox `mode: all`, or tool search never returns it.
  `tools.invoke` over the gateway can't build the decision tool, so live checks need a real agent
  turn.
- **Found and fixed:** the llama.cpp router rejects questions without non-empty `instructions`
  (`400 questions.x: "instructions" must be provided`) for choice, score and noul. The plugin now
  sends neutral per-type defaults.
- **Success path:** a choice, score and boolean batch returned `status ok`, model `clef-flash`,
  `kind` phishing p 0.988, `danger` 2.30/3, `isPhish` 0.963, 333 input tokens, provenance
  provider `systemone`.
- **Error path:** with `model: kev-latest`, the result was `unavailable / unsupported-input`, and
  the gateway log had
  `systemone: unsupported-input: HTTP 400 from http://10.20.10.7:8080 (model 'kev-latest' not found)`.
- **Pass-through:** with `decisionModel: systemone/clef-flash` and config `model: no-such-model`,
  the result was `status ok`, model `clef-flash`.
- **Agent behavior note:** in one run, gemma-4-12b reported invented values after its
  `decision_evaluate` calls failed validation. The README advice to tell agents never to invent
  results matters for small models.
