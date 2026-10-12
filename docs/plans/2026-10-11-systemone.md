# systemone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `openclaw-plugin-systemone`, an OpenClaw decision-model provider for any System One server (Kev, llama.cpp router, others), with a configurable `baseUrl`, model label and optional API key.

**Architecture:** Five small TypeScript modules: `config` (settings), `schema` (wire request and response translation plus strict validation), `transport` (one SSRF-guarded POST with error mapping), `provider` (the `DecisionProviderV1` implementation) and `index` (plugin entry). Dependencies are injected so every module is unit-testable without a server. Live checks against clef-flash on megatron come last.

**Tech Stack:** TypeScript 5.9 (NodeNext ESM), vitest 3, OpenClaw plugin SDK 2026.10.1 (`plugin-entry`, `decisions`, `ssrf-runtime`, `secret-input-runtime`), ClawHub CLI for validation.

**Spec:** `docs/specs/2026-10-11-systemone-design.md`. Read it before starting any task.

## Global Constraints

- Plugin id `systemone`; npm package `openclaw-plugin-systemone`; MIT license; repo `guarismo/openclaw-plugin-systemone`.
- Endpoint: `${baseUrl}/v1/systemone`, POST, JSON.
- `baseUrl`: an `http:` or `https:` origin with any host, an optional port and an optional trailing slash. No path, userinfo, query or fragment. At most 256 characters.
- `apiKey`: a string or a SecretRef `{source: env|file|exec|store, provider, id}`; sent only as `Authorization: Bearer <key>`.
- `model`: a string of 1 to 128 characters; when unset, no `model` field is sent for `systemone/default`.
- `timeoutMs`: an integer from 1,000 to 300,000; default 30,000.
- Response read cap: 4 MiB (4,194,304 bytes).
- Logged server detail: at most 200 characters, control characters stripped, bearer tokens and the API key masked. Never log the API key, request state or question content.
- Failure reasons are only: `credentials-unavailable`, `authentication`, `rate-limited`, `transport`, `unsupported-input`, `invalid-response`.
- No retries, caching or circuit breaking in the plugin.
- Typesafe-derived code is credited in the README and in a LICENSE notice (MIT, Copyright (c) 2026 OpenClaw Foundation).
- Git commits use author `Igor Guarisma <igor.guarisma@gmail.com>`; nothing is pushed or published without the owner's explicit OK.
- Live OpenClaw config changes and gateway restarts on megatron need the owner's explicit OK at the time.

## Review Focus

- A `baseUrl` with a trailing slash or an upper-case scheme or host must produce exactly `http://host:port/v1/systemone`, with no `//v1` (Task 2 test `normalizes origin`).
- Rounded probabilities that sum slightly above or below 1 must be accepted, not rejected (Task 3 test `accepts rounded distributions`).
- Score criteria that are objects, arrays or `null` must be sent as strings, and the legend must be compared against those same strings (Task 3 test `normalizes non-string score criteria`).
- When the host deadline has already passed, no request may be sent; when it is closer than `timeoutMs`, the request timeout must shrink to it (Task 5 tests `deadline passed` and `deadline shrinks timeout`).
- An error body that echoes the bearer token or is a long HTML page must log a masked, 200-character, single-line detail (Task 4 test `sanitizes logged detail`).

---

### Task 1: Scaffold, manifest and host check for pass-through model ids

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `openclaw.plugin.json`, `LICENSE`
- Modify: `docs/specs/2026-10-11-systemone-design.md` (only if Step 6 finds pass-through unsupported)

**Interfaces:**
- Produces: a buildable project; `npm test` and `npm run build` work with no sources yet.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "openclaw-plugin-systemone",
  "version": "0.1.0",
  "description": "OpenClaw decision-model provider for System One servers (Kev, llama.cpp router and others), with a configurable base URL, model label and API key.",
  "repository": { "type": "git", "url": "git+https://github.com/guarismo/openclaw-plugin-systemone.git" },
  "homepage": "https://github.com/guarismo/openclaw-plugin-systemone#readme",
  "bugs": { "url": "https://github.com/guarismo/openclaw-plugin-systemone/issues" },
  "keywords": ["openclaw", "openclaw-plugin", "decision-model", "systemone", "kev", "llama.cpp", "classification"],
  "license": "MIT",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --config ./vitest.config.ts",
    "validate": "npm run build && clawhub package validate . --out .clawhub-validation"
  },
  "files": ["dist", "openclaw.plugin.json", "README.md", "LICENSE"],
  "peerDependencies": { "openclaw": ">=2026.10.1" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "devDependencies": {
    "openclaw": "2026.10.1",
    "typescript": "5.9.3",
    "vitest": "^3.2.0",
    "@types/node": "^24.0.0"
  },
  "openclaw": {
    "extensions": ["./dist/index.js"],
    "compat": { "pluginApi": ">=2026.10.1" },
    "build": { "openclawVersion": "2026.10.1" },
    "install": {
      "clawhubSpec": "clawhub:openclaw-plugin-systemone",
      "defaultChoice": "clawhub",
      "minHostVersion": ">=2026.10.1"
    },
    "release": { "publishToClawHub": true }
  },
  "pluginInspector": {
    "version": 1,
    "plugin": {
      "id": "systemone",
      "priority": "high",
      "seams": ["plugin-runtime"],
      "sourceRoot": ".",
      "expect": { "registrations": ["registerDecisionProvider"] }
    }
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`, `vitest.config.ts` and `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": false,
    "rootDir": "src",
    "outDir": "dist",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
.clawhub-validation/
*.tgz
```

- [ ] **Step 3: Write `openclaw.plugin.json`**

```json
{
  "id": "systemone",
  "name": "System One",
  "description": "Typed decision provider for any System One server (Kev, llama.cpp router and others) with a configurable base URL, model label and API key.",
  "version": "0.1.0",
  "categories": ["developer-tools"],
  "enabledByDefault": false,
  "activation": { "onStartup": true },
  "contracts": { "decisionProviders": ["systemone"] },
  "decisionModels": [
    {
      "provider": "systemone",
      "id": "default",
      "name": "System One (configured model)",
      "capabilities": {
        "questionTypes": ["boolean", "choice", "score"],
        "confidence": "provider-specific"
      }
    }
  ],
  "configContracts": {
    "secretInputs": {
      "paths": [{ "path": "apiKey", "expected": "string", "ownerKind": "capability" }]
    }
  },
  "uiHints": {
    "baseUrl": {
      "label": "System One server",
      "help": "Origin of the server, such as http://127.0.0.1:8009 or http://10.0.0.5:8080. The plugin appends /v1/systemone. No path, query or credentials."
    },
    "apiKey": {
      "label": "API key",
      "help": "Optional. Sent as Authorization: Bearer. Prefer a SecretRef in Settings → Secrets. Use https when the server is not on this machine.",
      "sensitive": true
    },
    "model": {
      "label": "Model label",
      "help": "Sent as the System One model for systemone/default, for example clef-flash on a llama.cpp router. Leave empty for single-model servers such as Kev."
    },
    "timeoutMs": { "label": "Request timeout (ms)", "advanced": true }
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["baseUrl"],
    "properties": {
      "baseUrl": { "type": "string", "maxLength": 256, "pattern": "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#@\\s]+/?$" },
      "apiKey": {
        "anyOf": [
          { "type": "string", "maxLength": 4096 },
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["source", "provider", "id"],
            "properties": {
              "source": { "enum": ["env", "file", "exec", "store"] },
              "provider": { "type": "string", "minLength": 1, "maxLength": 128 },
              "id": { "type": "string", "minLength": 1, "maxLength": 1024 }
            }
          }
        ]
      },
      "model": { "type": "string", "minLength": 1, "maxLength": 128 },
      "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 300000, "default": 30000 }
    }
  }
}
```

- [ ] **Step 4: Write `LICENSE`**

```
MIT License

Copyright (c) 2026 Igor Guarisma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

Portions of src/schema.ts and src/transport.ts are adapted from the
@openclaw/typesafe plugin (extensions/typesafe in github.com/openclaw/openclaw):

Copyright (c) 2026 OpenClaw Foundation

Licensed under the MIT License, with the same terms as above.
```

- [ ] **Step 5: Install and confirm the toolchain runs**

Run: `cd ~/openclaw-plugins/systemone && npm install && npx tsc --version && npx vitest run --passWithNoTests`
Expected: install succeeds; `Version 5.9.3`; vitest reports no test files and exits 0.

- [ ] **Step 6: Check whether the host accepts decision-model ids that aren't in the manifest**

Run:
```bash
cd ~/openclaw-plugins/systemone/node_modules/openclaw/dist
grep -rln "decisionModel" *.js | head -20
grep -rn "decisionModels" *.js | grep -iE "includes|find|has\(|unknown|not found|unavailable" | head -20
```
Read the function that resolves `agents.defaults.decisionModel` into a provider plus model, and record in the commit message one of:
- **accepted:** the provider is looked up by the `provider/` prefix only, and any model id is passed to `evaluate` as `context.model`;
- **rejected:** the id must match a manifest `decisionModels` entry.

If the result is **rejected**, edit the spec's "Model selection" bullet for `systemone/<name>` to read: "Not supported by the host (verified in Task 1); use `systemone/default` with `model`." Task 5 keeps the pass-through code and tests either way.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore openclaw.plugin.json LICENSE docs/specs
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Scaffold systemone plugin: manifest, config schema, toolchain" -m "$HOST_CHECK"
```

Before running it, set `HOST_CHECK` to the Step 6 finding in one line, for example
`HOST_CHECK="Host check: decision-model ids not in the manifest are accepted (dist/decision-runtime-*.js resolveDecisionSelection)"`.

---

### Task 2: Settings parsing (`src/config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  - `type SecretRef = { source: "env" | "file" | "exec" | "store"; provider: string; id: string }`
  - `type Settings = { baseUrl: string; apiKey?: string | SecretRef; model?: string; timeoutMs: number }`
  - `const DEFAULT_TIMEOUT_MS = 30_000`
  - `function parseBaseUrl(value: unknown): string | undefined`, which returns a normalized origin with no trailing slash
  - `function parseSettings(raw: unknown): Settings | undefined`, which returns `undefined` when `baseUrl` is missing or invalid

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, parseBaseUrl, parseSettings } from "./config.js";

describe("parseBaseUrl", () => {
  it.each([
    ["http://127.0.0.1:8009", "http://127.0.0.1:8009"],
    ["http://10.20.10.7:8080/", "http://10.20.10.7:8080"],
    ["https://decide.example.com", "https://decide.example.com"],
    ["http://localhost", "http://localhost"],
    ["http://[::1]:8009", "http://[::1]:8009"],
  ])("accepts %s", (input, expected) => {
    expect(parseBaseUrl(input)).toBe(expected);
  });

  it("normalizes origin", () => {
    expect(parseBaseUrl("HTTP://Decide.Example.COM:8080/")).toBe("http://decide.example.com:8080");
  });

  it.each([
    "http://host:8080/v1",
    "http://host/path",
    "http://user:pass@host",
    "http://host?x=1",
    "http://host#frag",
    "ftp://host",
    "host:8080",
    "",
    `http://${"a".repeat(260)}.com`,
    42,
    undefined,
  ])("rejects %s", (input) => {
    expect(parseBaseUrl(input)).toBeUndefined();
  });
});

describe("parseSettings", () => {
  it("applies defaults", () => {
    expect(parseSettings({ baseUrl: "http://10.20.10.7:8080" })).toEqual({
      baseUrl: "http://10.20.10.7:8080",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it("keeps model, string key and timeout", () => {
    expect(parseSettings({ baseUrl: "http://h:1", model: "clef-flash", apiKey: "k", timeoutMs: 120000 })).toEqual({
      baseUrl: "http://h:1",
      model: "clef-flash",
      apiKey: "k",
      timeoutMs: 120000,
    });
  });

  it("keeps a SecretRef key as a reference", () => {
    const ref = { source: "env", provider: "default", id: "SYSTEMONE_KEY" };
    expect(parseSettings({ baseUrl: "http://h:1", apiKey: ref })?.apiKey).toEqual(ref);
  });

  it("drops empty or whitespace keys and models", () => {
    const s = parseSettings({ baseUrl: "http://h:1", apiKey: "  ", model: "" });
    expect(s?.apiKey).toBeUndefined();
    expect(s?.model).toBeUndefined();
  });

  it("clamps out-of-range timeouts to the default", () => {
    expect(parseSettings({ baseUrl: "http://h:1", timeoutMs: 10 })?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseSettings({ baseUrl: "http://h:1", timeoutMs: 999999 })?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("returns undefined without a valid baseUrl", () => {
    expect(parseSettings({})).toBeUndefined();
    expect(parseSettings({ baseUrl: "http://h/v1" })).toBeUndefined();
    expect(parseSettings(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL, `Cannot find module './config.js'`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
export type SecretRef = { source: "env" | "file" | "exec" | "store"; provider: string; id: string };
export type Settings = { baseUrl: string; apiKey?: string | SecretRef; model?: string; timeoutMs: number };

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BASE_URL_LENGTH = 256;
const MAX_MODEL_LENGTH = 128;

/** An http(s) origin, normalized and without a trailing slash; anything else is undefined. */
export function parseBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) return undefined;
  if (!/^https?:\/\/[^/?#@\s]+\/?$/i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
  return url.origin;
}

function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    ["env", "file", "exec", "store"].includes(v.source as string) &&
    typeof v.provider === "string" && v.provider.length > 0 &&
    typeof v.id === "string" && v.id.length > 0
  );
}

export function parseSettings(raw: unknown): Settings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const baseUrl = parseBaseUrl(r.baseUrl);
  if (!baseUrl) return undefined;
  const settings: Settings = { baseUrl, timeoutMs: DEFAULT_TIMEOUT_MS };
  if (typeof r.apiKey === "string" && r.apiKey.trim()) settings.apiKey = r.apiKey.trim();
  else if (isSecretRef(r.apiKey)) settings.apiKey = r.apiKey;
  if (typeof r.model === "string" && r.model.trim() && r.model.length <= MAX_MODEL_LENGTH) settings.model = r.model.trim();
  if (Number.isInteger(r.timeoutMs) && (r.timeoutMs as number) >= MIN_TIMEOUT_MS && (r.timeoutMs as number) <= MAX_TIMEOUT_MS) {
    settings.timeoutMs = r.timeoutMs as number;
  }
  return settings;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/config.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Add settings parsing for baseUrl, apiKey, model and timeout"
```

---

### Task 3: Wire translation and response validation (`src/schema.ts`)

**Files:**
- Create: `src/schema.ts`
- Test: `src/schema.test.ts`

**Interfaces:**
- Consumes: SDK types `DecisionBatch`, `DecisionBatchResult`, `DecisionEntry`, `DecisionAnswer` from `openclaw/plugin-sdk/decisions`.
- Produces:
  - `type WireQuestion`, `type WireRequest = { state: DecisionEntry; questions: Record<string, WireQuestion>; model?: string }`
  - `function toWireRequest(batch: DecisionBatch, model: string | undefined): WireRequest`
  - `class InvalidResponseError extends Error`
  - `function parseWireResponse(value: unknown, request: WireRequest): DecisionBatchResult`, which throws `InvalidResponseError`

- [ ] **Step 1: Write the failing tests**

The fixtures are real clef-flash responses recorded on 2026-10-11.

```ts
import { describe, expect, it } from "vitest";
import { InvalidResponseError, parseWireResponse, toWireRequest } from "./schema.js";
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";

const batch: DecisionBatch = {
  state: { subject: "Your account is locked, verify now" },
  questions: {
    category: { type: "choice", instructions: "What kind of email is this?", criteria: { phishing: "fake login page", legitimate: "real mail" } },
    sev: { type: "score", instructions: "How dangerous is this email?", criteria: ["harmless", "low", "moderate", "high", "critical"] },
    ph: { type: "boolean", instructions: "Is this phishing?" },
  },
};

const recorded = {
  model: "clef-flash",
  answers: {
    category: { type: "choice", choice: "phishing", probabilities: { legitimate: 0.018834372310997827, phishing: 0.9811656276890021 }, confidence: 0.9623312553780041 },
    sev: {
      type: "score",
      score: 3.335606808018457,
      legend: { "0": "harmless", "1": "low", "2": "moderate", "3": "high", "4": "critical" },
      probabilities: { "0": 0.01938342314672596, "1": 0.016414813796696622, "2": 0.027428087948065893, "3": 0.48275888210841805, "4": 0.45401479300009356 },
      confidence: 0.5229810183485579,
    },
    ph: { type: "noul", noul: 0.9597280497047349 },
  },
  usage: { input_tokens: 266, output_tokens: 0 },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("toWireRequest", () => {
  it("maps boolean to noul, fills null instructions and sets the model", () => {
    const w = toWireRequest(batch, "clef-flash");
    expect(w.model).toBe("clef-flash");
    expect(w.questions.ph).toEqual({ type: "noul", instructions: "Is this phishing?" });
    expect(w.questions.sev.type).toBe("score");
  });

  it("omits model when undefined", () => {
    expect("model" in toWireRequest(batch, undefined)).toBe(false);
  });

  it("normalizes non-string score criteria", () => {
    const w = toWireRequest(
      { state: null, questions: { s: { type: "score", criteria: ["none", null, { level: "high" }, ["a", "b"]] } } },
      undefined,
    );
    expect(w.questions.s).toEqual({ type: "score", instructions: null, criteria: ["none", "", '{"level":"high"}', '["a","b"]'] });
  });
});

describe("parseWireResponse", () => {
  const req = toWireRequest(batch, "clef-flash");

  it("translates a recorded clef-flash response", () => {
    const r = parseWireResponse(clone(recorded), req);
    expect(r.model).toBe("clef-flash");
    expect(r.answers.category).toEqual({ type: "choice", choice: "phishing", probabilities: recorded.answers.category.probabilities, confidence: recorded.answers.category.confidence });
    expect(r.answers.sev).toEqual({
      type: "score",
      score: recorded.answers.sev.score,
      probabilities: [0.01938342314672596, 0.016414813796696622, 0.027428087948065893, 0.48275888210841805, 0.45401479300009356],
      confidence: recorded.answers.sev.confidence,
    });
    expect(r.answers.ph).toEqual({ type: "boolean", probabilityTrue: 0.9597280497047349 });
    expect(r.usage).toEqual({ inputTokens: 266, outputTokens: 0 });
  });

  it("accepts rounded distributions", () => {
    const v = clone(recorded);
    v.answers.category.probabilities = { legitimate: 0.02, phishing: 0.99 };
    expect(() => parseWireResponse(v, req)).not.toThrow();
  });

  it("strips numeric latency_ms and allows missing usage, confidence and legend", () => {
    const v: any = clone(recorded);
    v.latency_ms = 12.5;
    delete v.usage;
    delete v.answers.category.confidence;
    delete v.answers.sev.legend;
    const r = parseWireResponse(v, req);
    expect(r.usage).toBeUndefined();
    expect(r.answers.category).not.toHaveProperty("confidence");
  });

  const bad: Array<[string, (v: any) => void]> = [
    ["non-object", (v) => Object.keys(v).forEach((k) => delete v[k])],
    ["extra top-level field", (v) => (v.extra = 1)],
    ["bad latency_ms", (v) => (v.latency_ms = -1)],
    ["missing answer", (v) => delete v.answers.ph],
    ["extra answer", (v) => (v.answers.other = { type: "noul", noul: 0.5 })],
    ["type mismatch", (v) => (v.answers.ph = { type: "choice", choice: "x", probabilities: { x: 1 } })],
    ["probability above 1", (v) => (v.answers.ph.noul = 1.2)],
    ["NaN probability", (v) => (v.answers.category.probabilities.phishing = "NaN")],
    ["zero-mass distribution", (v) => (v.answers.category.probabilities = { legitimate: 0, phishing: 0 })],
    ["choice not offered", (v) => (v.answers.category.choice = "spam")],
    ["missing choice label", (v) => delete v.answers.category.probabilities.legitimate],
    ["score out of range", (v) => (v.answers.sev.score = 4.5)],
    ["score probabilities keyed wrong", (v) => (v.answers.sev.probabilities = { a: 1, b: 0, c: 0, d: 0, e: 0 })],
    ["legend mismatch", (v) => (v.answers.sev.legend["4"] = "extreme")],
    ["extra answer field", (v) => (v.answers.ph.note = "x")],
    ["negative usage", (v) => (v.usage.input_tokens = -1)],
    ["empty model", (v) => (v.model = "")],
  ];
  it.each(bad)("rejects %s", (_name, mutate) => {
    const v = clone(recorded);
    mutate(v);
    expect(() => parseWireResponse(_name === "non-object" ? null : v, req)).toThrow(InvalidResponseError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/schema.test.ts`
Expected: FAIL, `Cannot find module './schema.js'`.

- [ ] **Step 3: Implement `src/schema.ts`**

```ts
// Request translation and strict response validation, adapted from @openclaw/typesafe
// (extensions/typesafe/src/{client,local}.ts, MIT, Copyright (c) 2026 OpenClaw Foundation).
import type { DecisionAnswer, DecisionBatch, DecisionBatchResult, DecisionEntry } from "openclaw/plugin-sdk/decisions";

export type WireQuestion =
  | { type: "choice"; instructions: DecisionEntry; criteria: Readonly<Record<string, DecisionEntry>> }
  | { type: "score"; instructions: DecisionEntry; criteria: string[] }
  | { type: "noul"; instructions: DecisionEntry; criteria?: { true?: DecisionEntry; false?: DecisionEntry } | null };
export type WireRequest = { state: DecisionEntry; questions: Record<string, WireQuestion>; model?: string };

export class InvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponseError";
  }
}

const criterionText = (level: DecisionEntry): string =>
  typeof level === "string" ? level : level === null ? "" : JSON.stringify(level);

export function toWireRequest(batch: DecisionBatch, model: string | undefined): WireRequest {
  const questions: Record<string, WireQuestion> = {};
  for (const [id, q] of Object.entries(batch.questions)) {
    const instructions = q.instructions ?? null;
    if (q.type === "score") questions[id] = { type: "score", instructions, criteria: q.criteria.map(criterionText) };
    else if (q.type === "choice") questions[id] = { type: "choice", instructions, criteria: q.criteria };
    else questions[id] = q.criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria: q.criteria };
  }
  return model === undefined ? { state: batch.state, questions } : { state: batch.state, questions, model };
}

const fail = (why: string): never => {
  throw new InvalidResponseError(`invalid System One response: ${why}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`unexpected field ${where}.${k}`);
}

function distribution(raw: unknown, labels: string[], where: string): Record<string, number> {
  if (!isObject(raw)) return fail(`${where}.probabilities is not an object`);
  const keys = Object.keys(raw);
  if (keys.length !== labels.length || labels.some((l) => !Object.hasOwn(raw, l))) fail(`${where}.probabilities labels differ from the question`);
  let mass = 0;
  for (const l of labels) {
    if (!isProbability(raw[l])) fail(`${where}.probabilities.${l} is not in [0, 1]`);
    mass += raw[l] as number;
  }
  if (!(mass > 0)) fail(`${where}.probabilities has no mass`);
  return Object.fromEntries(labels.map((l) => [l, raw[l] as number]));
}

function answer(raw: unknown, q: WireQuestion, id: string): DecisionAnswer {
  const where = `answers.${id}`;
  if (!isObject(raw) || raw.type !== q.type) return fail(`${where} does not match question type ${q.type}`);
  if (q.type === "noul") {
    onlyKeys(raw, ["type", "noul"], where);
    if (!isProbability(raw.noul)) fail(`${where}.noul is not in [0, 1]`);
    return { type: "boolean", probabilityTrue: raw.noul as number };
  }
  if (raw.confidence !== undefined && !isProbability(raw.confidence)) fail(`${where}.confidence is not in [0, 1]`);
  const confidence = raw.confidence === undefined ? {} : { confidence: raw.confidence as number };
  if (q.type === "choice") {
    onlyKeys(raw, ["type", "choice", "probabilities", "confidence"], where);
    const labels = Object.keys(q.criteria);
    const probabilities = distribution(raw.probabilities, labels, where);
    if (typeof raw.choice !== "string" || !labels.includes(raw.choice)) fail(`${where}.choice is not an offered label`);
    return { type: "choice", choice: raw.choice as string, probabilities, ...confidence };
  }
  onlyKeys(raw, ["type", "score", "probabilities", "confidence", "legend"], where);
  const labels = q.criteria.map((_, i) => String(i));
  const probabilities = distribution(raw.probabilities, labels, where);
  if (typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > labels.length - 1) {
    fail(`${where}.score is outside the rubric`);
  }
  const legend = raw.legend;
  if (legend !== undefined) {
    if (!isObject(legend) || Object.keys(legend).length !== labels.length || labels.some((l, i) => legend[l] !== q.criteria[i])) {
      fail(`${where}.legend differs from the criteria`);
    }
  }
  return { type: "score", score: raw.score as number, probabilities: labels.map((l) => probabilities[l]), ...confidence };
}

export function parseWireResponse(value: unknown, request: WireRequest): DecisionBatchResult {
  if (!isObject(value)) return fail("not an object");
  let body = value;
  if ("latency_ms" in body) {
    const { latency_ms, ...rest } = body;
    if (typeof latency_ms !== "number" || !Number.isFinite(latency_ms) || latency_ms < 0) fail("latency_ms is invalid");
    body = rest;
  }
  onlyKeys(body, ["model", "answers", "usage"], "response");
  if (typeof body.model !== "string" || body.model.length === 0 || body.model.length > 256) fail("model is missing");
  if (!isObject(body.answers)) return fail("answers is not an object");
  const ids = Object.keys(request.questions);
  if (Object.keys(body.answers).length !== ids.length || ids.some((id) => !Object.hasOwn(body.answers as object, id))) {
    fail("answers differ from the questions");
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const id of ids) answers[id] = answer((body.answers as Record<string, unknown>)[id], request.questions[id], id);
  let usage: DecisionBatchResult["usage"];
  if (body.usage !== undefined) {
    if (!isObject(body.usage)) return fail("usage is not an object");
    onlyKeys(body.usage, ["input_tokens", "output_tokens"], "usage");
    if (!isCount(body.usage.input_tokens) || !isCount(body.usage.output_tokens)) fail("usage counts are invalid");
    usage = { inputTokens: body.usage.input_tokens as number, outputTokens: body.usage.output_tokens as number };
  }
  return usage ? { model: body.model as string, answers, usage } : { model: body.model as string, answers };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/schema.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS for all tests; tsc prints no errors.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/schema.test.ts
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Add System One request translation and strict response validation"
```

---

### Task 4: HTTP transport (`src/transport.ts`)

**Files:**
- Create: `src/transport.ts`
- Test: `src/transport.test.ts`

**Interfaces:**
- Consumes: `WireRequest` (Task 3); `fetchWithSsrFGuard`, `ssrfPolicyFromHttpBaseUrlAllowedOrigin` from `openclaw/plugin-sdk/ssrf-runtime`; `ProviderFailureReason` from `openclaw/plugin-sdk/decisions`.
- Produces:
  - `const MAX_RESPONSE_BYTES = 4 * 1024 * 1024`
  - `class SystemOneError extends Error { reason: ProviderFailureReason; retryAfterMs?: number }`, whose `message` is already safe to log
  - `type GuardedFetch = (params: { url: string; init: RequestInit; signal: AbortSignal; policy?: unknown; maxRedirects: number; capture: false; auditContext: string }) => Promise<{ response: Response; release: () => Promise<void> }>`
  - `function sanitizeDetail(text: string, apiKey?: string): string`
  - `async function postEvaluation(params: { baseUrl: string; apiKey?: string; body: WireRequest; timeoutMs: number; signal: AbortSignal; isAdmissible?: () => boolean; fetchImpl?: GuardedFetch }): Promise<unknown>`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_BYTES, SystemOneError, postEvaluation, sanitizeDetail, type GuardedFetch } from "./transport.js";

const body = { state: null, questions: { q: { type: "noul" as const, instructions: null } }, model: "clef-flash" };

function fake(response: Response | Error) {
  const release = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { response, release };
  }) as unknown as GuardedFetch & ReturnType<typeof vi.fn>;
  return { fetchImpl, release };
}
const call = (fetchImpl: GuardedFetch, extra: Partial<Parameters<typeof postEvaluation>[0]> = {}) =>
  postEvaluation({ baseUrl: "http://10.20.10.7:8080", body, timeoutMs: 5000, signal: new AbortController().signal, fetchImpl, ...extra });
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SystemOneError);
    return e as SystemOneError;
  }
  throw new Error("expected a SystemOneError");
};

describe("postEvaluation", () => {
  it("posts JSON to /v1/systemone and returns the parsed body", async () => {
    const { fetchImpl, release } = fake(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(call(fetchImpl)).resolves.toEqual({ ok: 1 });
    const args = (fetchImpl as any).mock.calls[0][0];
    expect(args.url).toBe("http://10.20.10.7:8080/v1/systemone");
    expect(args.init.method).toBe("POST");
    expect(JSON.parse(args.init.body)).toEqual(body);
    expect(args.init.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(args.maxRedirects).toBe(0);
    expect(args.capture).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends the bearer key only when set", async () => {
    const { fetchImpl } = fake(new Response("{}", { status: 200 }));
    await call(fetchImpl, { apiKey: "s3cret" });
    expect((fetchImpl as any).mock.calls[0][0].init.headers.authorization).toBe("Bearer s3cret");
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate-limited"],
    [400, "unsupported-input"],
    [413, "unsupported-input"],
    [422, "unsupported-input"],
    [404, "transport"],
    [500, "transport"],
    [503, "transport"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const { fetchImpl, release } = fake(new Response('{"error":{"message":"nope"}}', { status }));
    const err = await reasonOf(call(fetchImpl));
    expect(err.reason).toBe(reason);
    expect(err.message).toContain(`HTTP ${status}`);
    expect(err.message).toContain("nope");
    expect(release).toHaveBeenCalledOnce();
  });

  it("parses retry-after-ms and retry-after seconds", async () => {
    let { fetchImpl } = fake(new Response("", { status: 429, headers: { "retry-after-ms": "1500" } }));
    expect((await reasonOf(call(fetchImpl))).retryAfterMs).toBe(1500);
    ({ fetchImpl } = fake(new Response("", { status: 429, headers: { "retry-after": "3" } })));
    expect((await reasonOf(call(fetchImpl))).retryAfterMs).toBe(3000);
    ({ fetchImpl } = fake(new Response("", { status: 429, headers: { "retry-after": "soon" } })));
    expect((await reasonOf(call(fetchImpl))).retryAfterMs).toBeUndefined();
  });

  it("maps network errors, redirects and aborts to transport", async () => {
    for (const e of [new TypeError("fetch failed"), Object.assign(new Error("redirect"), { name: "GuardedFetchRedirectError" }), Object.assign(new Error("blocked"), { name: "SsrFBlockedError" })]) {
      const { fetchImpl } = fake(e);
      expect((await reasonOf(call(fetchImpl))).reason).toBe("transport");
    }
    const ac = new AbortController();
    ac.abort();
    const { fetchImpl } = fake(new Response("{}"));
    expect((await reasonOf(call(fetchImpl, { signal: ac.signal }))).reason).toBe("transport");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to start when not admissible or out of time", async () => {
    const { fetchImpl } = fake(new Response("{}"));
    expect((await reasonOf(call(fetchImpl, { isAdmissible: () => false }))).reason).toBe("transport");
    expect((await reasonOf(call(fetchImpl, { timeoutMs: 0 }))).reason).toBe("transport");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects bad JSON and oversized bodies as invalid-response", async () => {
    let { fetchImpl } = fake(new Response("not json", { status: 200 }));
    expect((await reasonOf(call(fetchImpl))).reason).toBe("invalid-response");
    ({ fetchImpl } = fake(new Response("x".repeat(MAX_RESPONSE_BYTES + 1), { status: 200 })));
    expect((await reasonOf(call(fetchImpl))).reason).toBe("invalid-response");
  });

  it("sanitizes logged detail", async () => {
    const html = `<html>${"Bearer s3cret ".repeat(40)}\n\u0007token s3cret</html>`;
    const { fetchImpl } = fake(new Response(html, { status: 500 }));
    const err = await reasonOf(call(fetchImpl, { apiKey: "s3cret" }));
    expect(err.message).not.toContain("s3cret");
    expect(err.message).not.toMatch(/[\u0000-\u001f]/);
    expect(err.message.length).toBeLessThanOrEqual(260);
  });
});

describe("sanitizeDetail", () => {
  it("masks the key and bearer tokens, strips control characters and truncates", () => {
    const out = sanitizeDetail("Bearer abc.def k3y\u0000 " + "z".repeat(300), "k3y");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("k3y");
    expect(out).not.toContain("\u0000");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/transport.test.ts`
Expected: FAIL, `Cannot find module './transport.js'`.

- [ ] **Step 3: Implement `src/transport.ts`**

```ts
// Error mapping and bounded body reading adapted from @openclaw/typesafe
// (extensions/typesafe/src/transport.ts, MIT, Copyright (c) 2026 OpenClaw Foundation).
import { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ProviderFailureReason } from "openclaw/plugin-sdk/decisions";
import type { WireRequest } from "./schema.js";

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_DETAIL = 200;
const MAX_RETRY_AFTER_MS = 3_600_000;

export class SystemOneError extends Error {
  constructor(readonly reason: ProviderFailureReason, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "SystemOneError";
  }
}

export type GuardedFetch = (params: {
  url: string;
  init: RequestInit;
  signal: AbortSignal;
  policy?: unknown;
  maxRedirects: number;
  capture: false;
  auditContext: string;
}) => Promise<{ response: Response; release: () => Promise<void> }>;

const defaultFetch: GuardedFetch = (params) =>
  fetchWithSsrFGuard(params as Parameters<typeof fetchWithSsrFGuard>[0]);

export function sanitizeDetail(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("***");
  out = out.replace(/bearer\s+\S+/gi, "Bearer ***").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL - 1)}…` : out;
}

function serverMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (typeof m === "string") return m;
  } catch {
    // not JSON; fall through to the raw text
  }
  return text;
}

function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

async function readBounded(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function statusReason(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 413 || status === 422) return "unsupported-input";
  return "transport";
}

export async function postEvaluation(params: {
  baseUrl: string;
  apiKey?: string;
  body: WireRequest;
  timeoutMs: number;
  signal: AbortSignal;
  isAdmissible?: () => boolean;
  fetchImpl?: GuardedFetch;
}): Promise<unknown> {
  const { baseUrl, apiKey } = params;
  const origin = `from ${baseUrl}`;
  if (params.timeoutMs <= 0) throw new SystemOneError("transport", `deadline reached before calling ${baseUrl}`);
  if (params.signal.aborted) throw new SystemOneError("transport", `cancelled before calling ${baseUrl}`);
  if (params.isAdmissible && !params.isAdmissible()) throw new SystemOneError("transport", `request to ${baseUrl} no longer admitted`);

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const signal = AbortSignal.any([params.signal, AbortSignal.timeout(params.timeoutMs)]);

  let guarded: { response: Response; release: () => Promise<void> };
  try {
    guarded = await (params.fetchImpl ?? defaultFetch)({
      url: `${baseUrl}/v1/systemone`,
      init: { method: "POST", headers, body: JSON.stringify(params.body) },
      signal,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl),
      maxRedirects: 0,
      capture: false,
      auditContext: "systemone-decision",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const what = signal.aborted ? (params.signal.aborted ? "cancelled" : "timed out") : `${name}: ${error instanceof Error ? error.message : String(error)}`;
    throw new SystemOneError("transport", `request ${what} ${origin}`.replace(/\s+/g, " ").slice(0, 260));
  }

  try {
    const { response } = guarded;
    if (!response.ok) {
      const { text } = await readBounded(response, MAX_ERROR_BODY_BYTES);
      const detail = sanitizeDetail(serverMessage(text), apiKey);
      throw new SystemOneError(
        statusReason(response.status),
        `HTTP ${response.status} ${origin}${detail ? ` (${detail})` : ""}`,
        response.status === 429 ? retryAfter(response.headers) : undefined,
      );
    }
    const { text, truncated } = await readBounded(response, MAX_RESPONSE_BYTES);
    if (truncated) throw new SystemOneError("invalid-response", `response ${origin} exceeds ${MAX_RESPONSE_BYTES} bytes`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SystemOneError("invalid-response", `response ${origin} is not JSON`);
    }
  } catch (error) {
    if (error instanceof SystemOneError) throw error;
    throw new SystemOneError("transport", `reading the response ${origin} failed`);
  } finally {
    await guarded.release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/transport.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS for all tests; tsc prints no errors. If tsc rejects the `defaultFetch` cast because the SDK option types differ, change only the cast (`params as unknown as Parameters<typeof fetchWithSsrFGuard>[0]`), not the `GuardedFetch` shape.

- [ ] **Step 5: Commit**

```bash
git add src/transport.ts src/transport.test.ts
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Add SSRF-guarded System One transport with error mapping"
```

---

### Task 5: Decision provider and plugin entry (`src/provider.ts`, `src/index.ts`)

**Files:**
- Create: `src/provider.ts`, `src/index.ts`
- Test: `src/provider.test.ts`

**Interfaces:**
- Consumes: `Settings`, `parseSettings` (Task 2); `toWireRequest`, `parseWireResponse`, `InvalidResponseError` (Task 3); `postEvaluation`, `SystemOneError` (Task 4); SDK `DecisionProviderV1`, `DecisionBatch`; `getPreparedPluginSecretInput` from `openclaw/plugin-sdk/secret-input-runtime`; `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`.
- Produces:
  - `const PROVIDER_ID = "systemone"`
  - `function wireModel(selected: string, settings: Settings): string | undefined`
  - `type ProviderDeps = { getSettings: () => Settings | undefined; readPreparedKey: () => string | undefined; warn: (message: string) => void; post?: typeof postEvaluation; now?: () => number }`
  - `function createProvider(deps: ProviderDeps): DecisionProviderV1`
  - the default export of `src/index.ts`, the plugin entry

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import type { DecisionBatch } from "openclaw/plugin-sdk/decisions";
import { createProvider, wireModel, type ProviderDeps } from "./provider.js";
import { SystemOneError } from "./transport.js";

const settings = { baseUrl: "http://10.20.10.7:8080", model: "clef-flash", timeoutMs: 30000 };
const batch: DecisionBatch = { state: "x", questions: { ok: { type: "boolean", instructions: "ok?" } } };
const okBody = { model: "clef-flash", answers: { ok: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 5, output_tokens: 0 } };

function setup(over: Partial<ProviderDeps> = {}) {
  const warn = vi.fn();
  const post = vi.fn(async () => okBody);
  const deps: ProviderDeps = { getSettings: () => settings, readPreparedKey: () => undefined, warn, post, now: () => 1000, ...over };
  return { provider: createProvider(deps), post: (deps.post as ReturnType<typeof vi.fn>), warn };
}
const ctx = (over: Record<string, unknown> = {}) => ({ model: "default", signal: new AbortController().signal, deadlineMonotonicMs: 61000, ...over });

describe("wireModel", () => {
  it("uses the configured model for default", () => expect(wireModel("default", settings)).toBe("clef-flash"));
  it("strips a provider prefix", () => expect(wireModel("systemone/default", settings)).toBe("clef-flash"));
  it("sends nothing for default without a model", () => expect(wireModel("default", { ...settings, model: undefined })).toBeUndefined());
  it("passes other ids through", () => expect(wireModel("systemone/kev-4b", settings)).toBe("kev-4b"));
});

describe("createProvider", () => {
  it("is ready only with settings", () => {
    expect(setup().provider.isReady?.()).toBe(true);
    expect(setup({ getSettings: () => undefined }).provider.isReady?.()).toBe(false);
  });

  it("returns translated answers", async () => {
    const { provider, post } = setup();
    const out = await provider.evaluate(batch, ctx());
    expect(out).toEqual({ status: "ok", result: { model: "clef-flash", answers: { ok: { type: "boolean", probabilityTrue: 0.8 } }, usage: { inputTokens: 5, outputTokens: 0 } } });
    const sent = post.mock.calls[0][0];
    expect(sent.body).toEqual({ state: "x", questions: { ok: { type: "noul", instructions: "ok?" } }, model: "clef-flash" });
    expect(sent.baseUrl).toBe("http://10.20.10.7:8080");
    expect(sent.apiKey).toBeUndefined();
  });

  it("deadline shrinks timeout", async () => {
    const { provider, post } = setup();
    await provider.evaluate(batch, ctx({ deadlineMonotonicMs: 6000 }));
    expect(post.mock.calls[0][0].timeoutMs).toBe(5000);
  });

  it("deadline passed", async () => {
    const { provider, post } = setup({ post: vi.fn(async (p) => { if (p.timeoutMs <= 0) throw new SystemOneError("transport", "deadline reached before calling http://10.20.10.7:8080"); return okBody; }) });
    expect(await provider.evaluate(batch, ctx({ deadlineMonotonicMs: 900 }))).toEqual({ status: "unavailable", reason: "transport" });
    expect(post.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(0);
  });

  it("uses a plain string key", async () => {
    const { provider, post } = setup({ getSettings: () => ({ ...settings, apiKey: "plain" }) });
    await provider.evaluate(batch, ctx());
    expect(post.mock.calls[0][0].apiKey).toBe("plain");
  });

  it("uses the prepared SecretRef key, and fails cold without it", async () => {
    const ref = { source: "env" as const, provider: "default", id: "K" };
    let r = setup({ getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => "resolved" });
    await r.provider.evaluate(batch, ctx());
    expect(r.post.mock.calls[0][0].apiKey).toBe("resolved");
    r = setup({ getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => undefined });
    expect(await r.provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(r.post).not.toHaveBeenCalled();
    expect(r.warn.mock.calls[0][0]).not.toContain("K\"");
  });

  it("maps transport errors and logs one safe line", async () => {
    const { provider, warn } = setup({ post: vi.fn(async () => { throw new SystemOneError("unsupported-input", 'HTTP 400 from http://10.20.10.7:8080 (model \'kev-latest\' not found)'); }) });
    expect(await provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(warn).toHaveBeenCalledWith("systemone: unsupported-input: HTTP 400 from http://10.20.10.7:8080 (model 'kev-latest' not found)");
  });

  it("passes retryAfterMs through", async () => {
    const { provider } = setup({ post: vi.fn(async () => { throw new SystemOneError("rate-limited", "HTTP 429 from x", 2000); }) });
    expect(await provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "rate-limited", retryAfterMs: 2000 });
  });

  it("maps invalid responses", async () => {
    const { provider, warn } = setup({ post: vi.fn(async () => ({ model: "clef-flash", answers: {} })) });
    expect(await provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(warn.mock.calls[0][0]).toMatch(/^systemone: invalid-response: invalid System One response/);
  });

  it("returns credentials-unavailable when unconfigured", async () => {
    expect(await setup({ getSettings: () => undefined }).provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
  });

  it("rethrows unexpected errors", async () => {
    const { provider } = setup({ post: vi.fn(async () => { throw new RangeError("bug"); }) });
    await expect(provider.evaluate(batch, ctx())).rejects.toThrow("bug");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/provider.test.ts`
Expected: FAIL, `Cannot find module './provider.js'`.

- [ ] **Step 3: Implement `src/provider.ts`**

```ts
import type { DecisionProviderV1, ProviderDecisionOutcome } from "openclaw/plugin-sdk/decisions";
import type { Settings } from "./config.js";
import { InvalidResponseError, parseWireResponse, toWireRequest } from "./schema.js";
import { postEvaluation, SystemOneError } from "./transport.js";

export const PROVIDER_ID = "systemone";
const DEFAULT_MODEL_ID = "default";

export type ProviderDeps = {
  getSettings: () => Settings | undefined;
  readPreparedKey: () => string | undefined;
  warn: (message: string) => void;
  post?: typeof postEvaluation;
  now?: () => number;
};

/** The System One `model` label for a host-selected decision model id. */
export function wireModel(selected: string, settings: Settings): string | undefined {
  const id = selected.startsWith(`${PROVIDER_ID}/`) ? selected.slice(PROVIDER_ID.length + 1) : selected;
  return id === DEFAULT_MODEL_ID ? settings.model : id;
}

export function createProvider(deps: ProviderDeps): DecisionProviderV1 {
  const post = deps.post ?? postEvaluation;
  const now = deps.now ?? (() => performance.now());
  const unavailable = (reason: SystemOneError["reason"], message: string, retryAfterMs?: number): ProviderDecisionOutcome => {
    deps.warn(`${PROVIDER_ID}: ${reason}: ${message}`);
    return retryAfterMs === undefined ? { status: "unavailable", reason } : { status: "unavailable", reason, retryAfterMs };
  };
  return {
    id: PROVIDER_ID,
    contractVersion: 1,
    isReady: () => deps.getSettings() !== undefined,
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const settings = deps.getSettings();
      if (!settings) return unavailable("credentials-unavailable", "plugin is not configured (baseUrl missing or invalid)");
      let apiKey: string | undefined;
      if (typeof settings.apiKey === "string") apiKey = settings.apiKey;
      else if (settings.apiKey) {
        apiKey = deps.readPreparedKey();
        if (!apiKey) return unavailable("credentials-unavailable", "the apiKey SecretRef did not resolve at startup");
      }
      const request = toWireRequest(batch, wireModel(context.model, settings));
      try {
        const raw = await post({
          baseUrl: settings.baseUrl,
          apiKey,
          body: request,
          timeoutMs: Math.min(settings.timeoutMs, Math.floor(context.deadlineMonotonicMs - now())),
          signal: context.signal,
          isAdmissible: context.isAdmissible,
        });
        context.signal.throwIfAborted();
        return { status: "ok", result: parseWireResponse(raw, request) };
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof SystemOneError) return unavailable(error.reason, error.message, error.retryAfterMs);
        if (error instanceof InvalidResponseError) return unavailable("invalid-response", error.message);
        throw error;
      }
    },
  };
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { parseSettings } from "./config.js";
import { createProvider, PROVIDER_ID } from "./provider.js";

type ConfigSnapshot = { plugins?: { entries?: Record<string, { config?: unknown } | undefined> } };

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "System One",
  description: "Typed decision provider for any System One server.",
  register(api) {
    // Read the live config on every call so Settings changes apply without re-registering.
    const current = () => (api.runtime.config.current() as ConfigSnapshot).plugins?.entries?.[PROVIDER_ID]?.config ?? api.pluginConfig;
    api.registerDecisionProvider(
      createProvider({
        getSettings: () => parseSettings(current()),
        readPreparedKey: () => getPreparedPluginSecretInput(PROVIDER_ID, "apiKey").value,
        warn: (message) => api.logger.warn(message),
      }),
    );
  },
});
```

- [ ] **Step 5: Run all tests and the build**

Run: `npx vitest run && npm run build && ls dist`
Expected: every test file passes; `dist/` contains `config.js schema.js transport.js provider.js index.js`. If `api.runtime.config.current` doesn't type-check on 2026.10.1, check `node_modules/openclaw/dist/plugin-sdk/plugin-entry.d.ts` for the runtime config accessor and use that name. Change only this line.

- [ ] **Step 6: Commit**

```bash
git add src/provider.ts src/provider.test.ts src/index.ts
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Add systemone decision provider and plugin entry"
```

---

### Task 6: README, validation and live checks on megatron

**Files:**
- Create: `README.md`
- Modify: `docs/specs/2026-10-11-systemone-design.md` (record the live results under a new "Verification" heading)

**Interfaces:**
- Consumes: the built plugin from Tasks 1–5.
- Produces: a validated package ready for publishing. Publishing itself is not part of this plan.

- [ ] **Step 1: Write `README.md`**

The sections, in order, with this content:

1. **Title and summary:** "OpenClaw decision-model provider for any System One server: Kev, a llama.cpp router, or your own. Adds `systemone/default` to the Decision picker."
2. **Why not `@openclaw/typesafe`:** loopback-only `baseUrl`, the fixed `kev-latest` label, no key for local servers. Link the typesafe docs.
3. **Install:** `openclaw plugins install clawhub:openclaw-plugin-systemone`, then enable.
4. **Configure,** with three examples:
   - Kev on loopback: `baseUrl: "http://127.0.0.1:8009"`, no `model`;
   - llama.cpp router: `baseUrl: "http://10.0.0.5:8080"`, `model: "clef-flash"`;
   - an authenticated server: `baseUrl: "https://decide.example.com"`, `apiKey: { source: "env", provider: "default", id: "SYSTEMONE_API_KEY" }`.
   Then the selection: `agents.defaults.decisionModel: "systemone/default"` or `agents.entries.<id>.decisionModel`. Include the field table from the spec's Section 1.
5. **Choosing models:** `systemone/default` sends `model`, and `systemone/<name>` sends `<name>`. Write that second part as Task 1 Step 6 found it (supported or not supported).
6. **How agents use it:** the three consumers and the recommended rollout, copied from the spec's "How agents use it" section, including the example `AGENTS.md` line and the Decision assistance privacy warning.
7. **Errors:** the reason table from spec Section 3, plus "look for `systemone:` warnings in the gateway log".
8. **Security:**
   - the SSRF policy trusts only the configured origin, and redirects are refused;
   - use https for non-local servers when a key is set;
   - the key is never logged;
   - evidence goes to the configured server.
9. **Credits:** adapted from `@openclaw/typesafe` (MIT, OpenClaw Foundation).
10. **License:** MIT.

- [ ] **Step 2: Validate the package**

Run: `cd ~/openclaw-plugins/systemone && npm test && npm run validate && clawhub package validate . --openclaw-version 2026.10.1`
Expected: tests pass; Plugin Inspector `PASS` with 0 breakages. Fix any findings in the owning file and re-run before continuing.

- [ ] **Step 3: Ask the owner before changing live config**

Stop and ask: "Ready to install systemone on megatron from the local path, enable it with `baseUrl http://10.20.10.7:8080` and `model clef-flash`, set `decisionModel: systemone/default` for one test agent, and restart the gateway. OK?" Continue only after an explicit yes.

- [ ] **Step 4: Install and configure (after the owner's OK)**

```bash
openclaw plugins install ~/openclaw-plugins/systemone --link
openclaw config set plugins.entries.systemone.enabled true
openclaw config set plugins.entries.systemone.config '{"baseUrl":"http://10.20.10.7:8080","model":"clef-flash"}' --json
openclaw config set agents.entries.starscream.decisionModel '"systemone/default"' --json
openclaw gateway restart
openclaw plugins inspect systemone --json
```
Expected: inspect shows `status: loaded`, the decision provider `systemone` registered and ready. If `openclaw config set` uses different flags on 2026.10.1, check `openclaw config set --help` and adapt; the values stay the same.

- [ ] **Step 5: Live decision check**

Run a `decision_evaluate` call through the gateway as the test agent:
```bash
openclaw gateway call tools.invoke --params '{"name":"decision_evaluate","sessionKey":"agent:starscream:systemone-test","args":{"state":{"subject":"Your account is locked, verify now","links":["paypa1-secure.xyz"]},"questions":{"kind":{"type":"choice","criteria":{"phishing":"fake login page","legitimate":"real mail"}},"danger":{"type":"score","criteria":["harmless","low","high","critical"]},"isPhish":{"type":"boolean","instructions":"Is this phishing?"}}}}' --json
```
Expected:
- `kind.choice` is `phishing`, with probabilities for both labels;
- `danger.score` is between 0 and 3, with 4 probabilities;
- `isPhish.probabilityTrue` is above 0.5;
- the provenance model is `clef-flash`.

Then `openclaw plugins inspect systemone --json` shows a last success and usage.

- [ ] **Step 6: Error check, then the pass-through check**

1. Set the model label to something that doesn't exist:
   `openclaw config set plugins.entries.systemone.config.model '"kev-latest"' --json`
2. Re-run Step 5's call. Expected: `unavailable` with `unsupported-input`.
3. Find the warning: `journalctl --user -u openclaw-gateway --since -5min | grep "systemone:"`. Expected: one line containing `HTTP 400` and `kev-latest`, with no key or state.
4. Restore `"clef-flash"`.
5. If Task 1 Step 6 found pass-through **accepted**, set the agent's `decisionModel` to `systemone/clef-flash`, re-run Step 5 and expect success, then restore `systemone/default`.

- [ ] **Step 7: Record the results and commit**

Add a "Verification (2026-10-11)" section to the spec with the outcome of each of Steps 2, 5 and 6: inspector result, answers, model and the warning line. Then:

```bash
git add README.md docs/specs/2026-10-11-systemone-design.md
git -c user.name="Igor Guarisma" -c user.email="igor.guarisma@gmail.com" commit -m "Add README and record live verification against clef-flash"
```

- [ ] **Step 8: Report and stop**

Tell the owner the results and ask whether to:
1. create the GitHub repo and push;
2. publish 0.1.0 to ClawHub;
3. keep the test agent's `decisionModel` or revert it.

Do none of these without an explicit yes.
