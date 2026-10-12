import type { DecisionProviderV1, ProviderDecisionOutcome } from "openclaw/plugin-sdk/decisions";
import type { Settings } from "./config.js";
import { InvalidResponseError, parseWireResponse, toWireRequest } from "./schema.js";
import { postEvaluation, SystemOneError } from "./transport.js";

export const PROVIDER_ID = "systemone";
const DEFAULT_MODEL_ID = "default";
const HEADER_SAFE_KEY = /^[\x21-\x7e]+$/;

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
    isReady: () => {
      const settings = deps.getSettings();
      return settings !== undefined && (typeof settings.apiKey !== "object" || !!deps.readPreparedKey()?.trim());
    },
    async evaluate(batch, context) {
      context.signal.throwIfAborted();
      const settings = deps.getSettings();
      if (!settings) return unavailable("credentials-unavailable", "plugin is not configured (baseUrl missing or invalid)");
      let apiKey: string | undefined;
      if (typeof settings.apiKey === "string") apiKey = settings.apiKey;
      else if (settings.apiKey) {
        apiKey = deps.readPreparedKey()?.trim();
        if (!apiKey) return unavailable("credentials-unavailable", "the apiKey SecretRef did not resolve at startup");
      }
      // A key with spaces or control characters can't go in a header, and undici would echo it in its error.
      if (apiKey !== undefined && !HEADER_SAFE_KEY.test(apiKey)) {
        return unavailable("credentials-unavailable", "the apiKey contains characters that can't be sent in an HTTP header");
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
