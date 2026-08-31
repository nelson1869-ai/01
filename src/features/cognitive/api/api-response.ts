import { ZodError } from "zod";
import { sanitizeErrorMessage } from "../ai/ai-errors";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";

export interface ApiErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ApiErrorEnvelope {
  readonly error: ApiErrorPayload;
}

export interface ApiDataEnvelope<T> {
  readonly data: T;
}

export function apiSuccess<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return Response.json({ data } satisfies ApiDataEnvelope<T>, {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function apiCreated<T>(data: T, headers?: HeadersInit): Response {
  return apiSuccess(data, 201, headers);
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): Response {
  const sanitizedMessage = sanitizeErrorMessage(message);
  return Response.json(
    {
      error: {
        code,
        message: sanitizedMessage,
        ...(details !== undefined ? { details } : {}),
      },
    } satisfies ApiErrorEnvelope,
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

export function handleRouteError(error: unknown): Response {
  if (error instanceof ZodError) {
    return apiError(
      "VALIDATION_ERROR",
      "Request validation failed.",
      400,
      error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    );
  }

  if (error instanceof PersistenceError) {
    switch (error.code) {
      case "NOT_FOUND":
        return apiError("NOT_FOUND", error.message, 404);
      case "IDEMPOTENCY_CONFLICT":
        return apiError("IDEMPOTENCY_CONFLICT", error.message, 409, error.details);
      case "STATE_CONFLICT":
        return apiError("STATE_CONFLICT", error.message, 409, error.details);
      case "STALE_WRITE":
        return apiError("STALE_WRITE", error.message, 409, error.details);
      case "INVALID_PERSISTED_STATE":
      default:
        return apiError(
          "INTERNAL_ERROR",
          "A persistent state error occurred.",
          500,
        );
    }
  }

  const rawMessage =
    error instanceof Error ? error.message : "An unexpected server error occurred.";
  return apiError("INTERNAL_ERROR", rawMessage, 500);
}
