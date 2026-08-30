import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-300">
          404 Error
        </div>

        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Page Not Found
        </h1>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The autonomous agent or resource you requested does not exist or has
          been relocated.
        </p>

        <div>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
