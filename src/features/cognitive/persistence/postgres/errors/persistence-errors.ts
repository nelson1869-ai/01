export type PersistenceErrorCode =
  | "STALE_WRITE"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "INVALID_PERSISTED_STATE"
  | "STATE_CONFLICT";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static staleWrite(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PersistenceError {
    return new PersistenceError("STALE_WRITE", message, details);
  }

  static idempotencyConflict(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PersistenceError {
    return new PersistenceError("IDEMPOTENCY_CONFLICT", message, details);
  }

  static notFound(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PersistenceError {
    return new PersistenceError("NOT_FOUND", message, details);
  }

  static invalidPersistedState(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PersistenceError {
    return new PersistenceError("INVALID_PERSISTED_STATE", message, details);
  }

  static stateConflict(
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): PersistenceError {
    return new PersistenceError("STATE_CONFLICT", message, details);
  }
}

export function isUniqueConstraintViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code: string }).code === "23505";
  }
  return false;
}
