export type AiErrorCode =
  | "MISSING_CREDENTIAL"
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "SAFETY_BLOCKED"
  | "INVALID_STRUCTURED_OUTPUT"
  | "RESPONSE_TOO_LARGE"
  | "UNKNOWN_PROVIDER_FAILURE";

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly provider: string;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    options: {
      readonly code: AiErrorCode;
      readonly provider: string;
      readonly isRetryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    // Redact any potential API key or secret strings from the message
    const sanitizedMessage = sanitizeErrorMessage(message);
    super(sanitizedMessage, { cause: options.cause });
    this.name = "AiProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.isRetryable = options.isRetryable ?? false;
  }

  static missingCredential(provider: string): AiProviderError {
    return new AiProviderError(`API key or credentials missing for provider "${provider}".`, {
      code: "MISSING_CREDENTIAL",
      provider,
      isRetryable: false,
    });
  }

  static authenticationFailed(provider: string): AiProviderError {
    return new AiProviderError(`Authentication failed for provider "${provider}".`, {
      code: "AUTHENTICATION_FAILED",
      provider,
      isRetryable: false,
    });
  }

  static rateLimited(provider: string): AiProviderError {
    return new AiProviderError(`Rate limit exceeded for provider "${provider}".`, {
      code: "RATE_LIMITED",
      provider,
      isRetryable: true,
    });
  }

  static timeout(provider: string, timeoutMs: number): AiProviderError {
    return new AiProviderError(`Request to provider "${provider}" timed out after ${timeoutMs}ms.`, {
      code: "TIMEOUT",
      provider,
      isRetryable: true,
    });
  }

  static safetyBlocked(provider: string, reason?: string): AiProviderError {
    return new AiProviderError(
      `Request to provider "${provider}" was blocked by safety filters: ${reason ?? "Safety policy violation"}`,
      {
        code: "SAFETY_BLOCKED",
        provider,
        isRetryable: false,
      },
    );
  }

  static invalidStructuredOutput(provider: string, details: string): AiProviderError {
    return new AiProviderError(
      `Provider "${provider}" returned invalid structured output: ${sanitizeErrorMessage(details)}`,
      {
        code: "INVALID_STRUCTURED_OUTPUT",
        provider,
        isRetryable: false,
      },
    );
  }

  static providerUnavailable(provider: string, details?: string): AiProviderError {
    return new AiProviderError(
      `Provider "${provider}" is temporarily unavailable: ${details ? sanitizeErrorMessage(details) : "Service error"}`,
      {
        code: "PROVIDER_UNAVAILABLE",
        provider,
        isRetryable: true,
      },
    );
  }

  static unknown(provider: string, rawError: unknown): AiProviderError {
    const rawMessage =
      rawError instanceof Error ? rawError.message : typeof rawError === "string" ? rawError : "Unknown failure";
    return new AiProviderError(sanitizeErrorMessage(rawMessage), {
      code: "UNKNOWN_PROVIDER_FAILURE",
      provider,
      isRetryable: false,
      cause: rawError,
    });
  }
}

export function sanitizeErrorMessage(message: string): string {
  if (!message) return "";
  // Redact AI API keys, GitHub tokens, Bearer tokens, passwords
  return message
    .replace(/AIza[0-9A-Za-z-_]{20,}/g, "[REDACTED_GEMINI_KEY]")
    .replace(/ghp_[0-9A-Za-z]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[0-9A-Za-z_]{20,}/g, "[REDACTED_GITHUB_PAT]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/key=[A-Za-z0-9._~+/-]+/gi, "key=[REDACTED]")
    .replace(/token=[A-Za-z0-9._~+/-]+/gi, "token=[REDACTED]");
}
