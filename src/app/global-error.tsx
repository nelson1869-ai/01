"use client";

import { useEffect } from "react";

interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("Global root layout caught error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center p-6 bg-zinc-950 text-zinc-50 font-sans antialiased">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-red-900/50 bg-red-950/50 px-3 py-1 text-xs font-medium text-red-300">
            Critical System Error
          </div>

          <h1 className="text-3xl font-bold tracking-tight">
            Application Error
          </h1>

          <p className="text-sm text-zinc-400">
            A critical root-level error occurred. Please refresh or reset the
            runtime.
          </p>

          <div>
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex items-center justify-center rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
            >
              Reset Application
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
