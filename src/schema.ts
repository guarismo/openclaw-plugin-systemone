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
