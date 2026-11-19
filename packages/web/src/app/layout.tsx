import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "kube-triage",
  description: "Read-only incident timelines for Kubernetes and Prometheus",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <header className="border-b border-slate-200 dark:border-slate-800">
          <div className="mx-auto flex max-w-5xl flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight whitespace-nowrap">
              kube-triage
            </Link>
            <p className="text-sm text-slate-600 dark:text-slate-400">Read-only. Nothing here changes your cluster.</p>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
