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

  it("rejects keys that cannot be sent as a header, without logging them", async () => {
    const ref = { source: "file" as const, provider: "default", id: "K" };
    for (const over of [
      { getSettings: () => ({ ...settings, apiKey: "sk-ab\ncd" }) },
      { getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => "sk-ab\ncd\n" },
    ]) {
      const r = setup(over);
      expect(await r.provider.evaluate(batch, ctx())).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(r.post).not.toHaveBeenCalled();
      expect(r.warn.mock.calls[0][0]).not.toContain("sk-ab");
    }
  });

  it("trims a prepared key", async () => {
    const ref = { source: "file" as const, provider: "default", id: "K" };
    const r = setup({ getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => "sk-abcd\n" });
    await r.provider.evaluate(batch, ctx());
    expect(r.post.mock.calls[0][0].apiKey).toBe("sk-abcd");
  });

  it("is not ready while a SecretRef key is unresolved", () => {
    const ref = { source: "env" as const, provider: "default", id: "K" };
    expect(setup({ getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => undefined }).provider.isReady?.()).toBe(false);
    expect(setup({ getSettings: () => ({ ...settings, apiKey: ref }), readPreparedKey: () => "k" }).provider.isReady?.()).toBe(true);
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
