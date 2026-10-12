export type SecretRef = { source: "env" | "file" | "exec" | "store"; provider: string; id: string };
export type Settings = { baseUrl: string; apiKey?: string | SecretRef; model?: string; timeoutMs: number };

export const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
// OpenClaw caps every decision at 30 s (DecisionProviderHost budget), so a longer timeout can't apply.
const MAX_TIMEOUT_MS = 30_000;
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
