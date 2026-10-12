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
