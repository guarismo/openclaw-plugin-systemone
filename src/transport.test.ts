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

describe("postEvaluation key safety", () => {
  it("never logs the key from a network error message", async () => {
    const { fetchImpl } = fake(new TypeError('Headers.append: "Bearer sk-SECRET\nX" is an invalid header value.'));
    const err = await reasonOf(call(fetchImpl, { apiKey: "sk-SECRET\nX" }));
    expect(err.reason).toBe("transport");
    expect(err.message).not.toContain("sk-SECRET");
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
