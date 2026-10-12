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
