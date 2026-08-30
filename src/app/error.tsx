"use client";

import { useEffect } from "react";

interface ErrorBoundaryProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  useEffect(() => {
    // Log to audit logger or telemetry when configured
    console.error("Route error boundary caught error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-300">
          Execution Error
        </div>

        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Something went wrong
        </h1>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          An unexpected error occurred during execution. You can attempt to
          re-render this segment.
        </p>

        {error.digest ? (
          <p className="font-mono text-xs text-zinc-400 dark:text-zinc-500">
            Error Digest: {error.digest}
          </p>
        ) : null}

        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Try Again
          </button>
        </div>
      </div>
    </main>
  );
}
