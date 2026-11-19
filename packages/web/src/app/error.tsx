"use client";

// Shown when the API is unreachable or rejects the dashboard's key. Details stay in the server log.
export default function ErrorPage() {
  return (
    <div role="alert">
      <h1 className="text-2xl font-semibold tracking-tight">Cannot load incidents</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">The incident API did not answer correctly. Check that it is running and that the dashboard's API key is valid, then reload.</p>
    </div>
  );
}
