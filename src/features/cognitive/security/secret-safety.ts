import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";

const DISALLOWED_SECRET_KEY_WORDS = new Set([
  "authorization",
  "authorizationheader",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "apitoken",
  "authtoken",
  "githubtoken",
  "secretkey",
  "password",
  "cookie",
  "privatekey",
  "secret",
  "token",
  "authbrand",
  "runtimeauthorization",
  "chainofthought",
  "scratchpad",
  "hiddenreasoning",
  "modelthoughts",
  "rawmodeltrace",
]);

export function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  if (DISALLOWED_SECRET_KEY_WORDS.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("apikey") ||
    normalized.includes("apitoken") ||
    normalized.includes("authtoken") ||
    normalized.includes("secretkey") ||
    normalized.includes("databaseurl") ||
    normalized.includes("dburl") ||
    normalized.includes("githubtoken") ||
    normalized.includes("geminitoken") ||
    normalized.includes("geminiapikey") ||
    normalized.includes("runtimeauth")
  );
}

const HIGH_CONFIDENCE_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /ghp_[a-zA-Z0-9]{20,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /AIzaSy[a-zA-Z0-9_-]{33}/,
  /\bBearer\s+[a-zA-Z0-9._~+/-]{20,}/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
];

export function containsHighConfidenceSecret(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return HIGH_CONFIDENCE_SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

export function sanitizeSecretValues(text: string): string {
  return text
    .replace(
      /\b(?:GEMINI_API_KEY|GITHUB_TOKEN|TEST_DATABASE_URL|DATABASE_URL)\s*[=:]\s*\S+/gi,
      "[REDACTED_SECRET]",
    )
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[a-zA-Z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, "[REDACTED_GEMINI_KEY]")
    .replace(
      /bearer\s+[a-zA-Z0-9._~+/-]{20,}/gi,
      "Bearer [REDACTED_AUTH_HEADER]",
    )
    .replace(
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
}

export function assertDataSecurity(data: unknown, path: string = ""): void {
  if (data === null || typeof data !== "object") {
    if (typeof data === "string" && containsHighConfidenceSecret(data)) {
      throw PersistenceError.invalidPersistedState(
        `High-confidence credential detected in data at ${path || "root"}.`,
      );
    }
    return;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertDataSecurity(data[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      throw PersistenceError.invalidPersistedState(
        `Disallowed property "${key}" (credential, brand, or chain-of-thought) found in cognitive context at ${path ? `${path}.${key}` : key}.`,
      );
    }
    if (typeof value === "string" && containsHighConfidenceSecret(value)) {
      throw PersistenceError.invalidPersistedState(
        `High-confidence credential detected in property "${key}" at ${path ? `${path}.${key}` : key}.`,
      );
    }
    assertDataSecurity(value, path ? `${path}.${key}` : key);
  }
}
