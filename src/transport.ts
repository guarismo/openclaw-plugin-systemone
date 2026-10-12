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
    const what = signal.aborted
      ? (params.signal.aborted ? "cancelled" : "timed out")
      : `${name}: ${sanitizeDetail(error instanceof Error ? error.message : String(error), apiKey)}`;
    throw new SystemOneError("transport", `request ${what} ${origin}`);
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
