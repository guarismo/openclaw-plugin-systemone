# System One decisions for OpenClaw

An OpenClaw decision-model provider for any server that speaks the System One API: Kev, a llama.cpp
router, or your own. It adds **System One (configured model)** (`systemone/default`) to the
Control UI **Decision** picker, so `decision_evaluate` and other decision consumers can run on a
model you host.

## Why not `@openclaw/typesafe`?

The official [TypeSafe AI plugin](https://docs.openclaw.ai/plugins/typesafe) is built for hosted Jev
and a Kev server running on the same machine. It doesn't fit self-hosted System One servers in
three ways:

- `baseUrl` must be a loopback address, so a server on another machine is refused.
- Local requests always carry the model label `kev-latest`. Servers that pick a model by name, such
  as `llama-server` in router mode, reject it with `400 model 'kev-latest' not found`.
- There is no API key for local servers.

This plugin removes all three limits.

## Install

```bash
openclaw plugins install clawhub:openclaw-plugin-systemone
openclaw config set plugins.entries.systemone.enabled true
```

The plugin needs OpenClaw 2026.10.1 or later.

## Configure

Set the server under `plugins.entries.systemone.config`, then pick the model for the decision role.

**Kev on this machine:**

```json5
plugins: { entries: { systemone: { enabled: true, config: { baseUrl: "http://127.0.0.1:8009" } } } }
```

**llama.cpp router on your network:**

```json5
plugins: { entries: { systemone: { enabled: true, config: {
  baseUrl: "http://10.0.0.5:8080", model: "clef-flash" } } } }
```

**Server that needs a key:**

```json5
plugins: { entries: { systemone: { enabled: true, config: {
  baseUrl: "https://decide.example.com",
  apiKey: { source: "env", provider: "default", id: "SYSTEMONE_API_KEY" } } } } }
```

**Select it** for every agent or for one agent:

```json5
agents: {
  defaults: { decisionModel: "systemone/default" },
  // or only for one agent:
  entries: { myagent: { decisionModel: "systemone/default" } },
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | string | required | An `http://` or `https://` origin: host and optional port, nothing else. The plugin calls `<baseUrl>/v1/systemone`. Paths, query strings, fragments and `user:pass@` are rejected. |
| `apiKey` | string or SecretRef | none | Sent as `Authorization: Bearer <key>`. A SecretRef (`{ source: env\|file\|exec\|store, provider, id }`) is resolved at gateway startup and hidden in Settings. |
| `model` | string | none | The model label that `systemone/default` sends. Leave it empty for single-model servers such as Kev. |
| `timeoutMs` | integer | 30000 | Per-request limit, from 1,000 to 30,000. OpenClaw allows each decision at most 30 seconds, so a model that is slower than that can't be used. Use a smaller `timeoutMs` if you want to fail faster. |

## Choosing models

- `systemone/default` sends the configured `model`, or no label when it's empty.
- `systemone/<name>` sends `<name>` as the label, so different agents can use different models on
  the same router, for example `systemone/clef-flash` for one agent and `systemone/kev-4b` for
  another. OpenClaw accepts these names even though they aren't listed in the picker. They just
  don't get the capability hints the picker entry has.

## How agents use it

The plugin only provides the model. Three things in OpenClaw can use it.

1. **The `decision_evaluate` tool.** Any agent with a decision model gets this core tool, subject
   to its tool policy. The agent decides when to call it and passes explicit `state` plus questions
   of three kinds: a **choice**, a **score** on a scale, or a **boolean** probability. The tool
   doesn't read the conversation by itself. Agents rarely use it unprompted, so tell them when to,
   in `AGENTS.md` or a skill. For example:

   > To triage a forwarded email, call `decision_evaluate` with a phishing/scam/spam/legitimate
   > choice and a severity score. If it fails or is unavailable, say so; never invent results.

   That last sentence matters for small chat models. In testing, a 12B model that got validation
   errors from the tool reported made-up probabilities instead.

   **Sandboxed agents:** an agent with sandbox `mode: "all"` only sees tools on its sandbox
   allowlist. Add `decision_evaluate` to `tools.sandbox.tools.alsoAllow`, and to `tools.alsoAllow`
   if the agent uses one, or tool search won't find it.

2. **Decision assistance (experimental).** With
   `agents.defaults.experimental.decisionAssistance: true`, OpenClaw asks the decision model before
   each eligible user turn whether the request needs tools, and drops optional tools for purely
   conversational turns. **This sends the current message and up to about 6,000 characters of
   recent conversation to your `baseUrl` on every eligible turn.** Turn it on only if that server
   is somewhere you're happy to send chat content.

3. **Other plugins.** They call `api.runtime.decisions.evaluate(...)` and use your model without
   handling its credentials.

**Suggested rollout:** select the model for one agent first, add the `AGENTS.md` guidance, and
leave Decision assistance off until you've seen how the tool behaves.

## Errors

When a decision can't be made, the result is `unavailable` with one of these reasons, and the
gateway log gets one `systemone:` warning line saying why.

| What happened | Reason |
|---|---|
| `baseUrl` missing or invalid, or a SecretRef `apiKey` that didn't resolve | the provider reports not ready, and calls return `credentials-unavailable` (an invalid `baseUrl` is normally refused when the config is saved) |
| An `apiKey` with spaces or control characters (for example a trailing newline from a file) | `credentials-unavailable` (the key isn't sent or logged) |
| HTTP 401 or 403 | `authentication` |
| HTTP 429 | `rate-limited`, with `retry-after` passed on |
| HTTP 400, 413 or 422, including an unknown model label | `unsupported-input` |
| Any other HTTP error, connection failure, DNS failure, timeout, cancellation or redirect | `transport` |
| Bad JSON, a response over 4 MiB, or answers that don't match the questions | `invalid-response` |

To see why a call failed:

```bash
journalctl --user -u openclaw-gateway --since -10min | grep "systemone:"
# systemone: unsupported-input: HTTP 400 from http://10.0.0.5:8080 (model 'kev-latest' not found)
```

The plugin doesn't retry. Retries and backoff belong to OpenClaw and to whatever called the
decision.

## Security

- Requests go through OpenClaw's SSRF-guarded fetch with a policy that trusts exactly the
  configured origin. Redirects are refused, so a request can't be bounced to another host.
- Use `https://` for any server not on this machine when you set an API key. Over plain `http://`
  on a network, the key is visible to anyone who can see the traffic.
- The API key, the request state and the question text are never logged. Server error text is cut
  to 200 characters, with control characters stripped and bearer tokens masked.
- Everything an agent or consumer submits goes to the configured server. Only point the plugin at a
  server you trust with that content.

## Credits

Request translation, response validation and error mapping are adapted from the
[`@openclaw/typesafe`](https://github.com/openclaw/openclaw/tree/main/extensions/typesafe) plugin,
MIT, Copyright (c) 2026 OpenClaw Foundation.

## License

MIT. See [LICENSE](LICENSE).
