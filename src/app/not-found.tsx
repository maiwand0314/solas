import type { Metadata } from "next";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <p className="font-mono text-xs text-subtle">404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-[-0.015em]">Page not found</h1>
      <p className="mt-1 max-w-sm text-muted">This page doesn’t exist in Solas.</p>
      <Link href="/" className={buttonClassName({ className: "mt-6" })}>
        Go to Overview
      </Link>
    </main>
  );
}
