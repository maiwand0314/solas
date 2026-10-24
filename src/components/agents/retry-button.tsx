"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

/** Re-renders the current page on the server, e.g. after the database is back. */
export function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button size="sm" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
      {pending ? "Retrying…" : "Try again"}
    </Button>
  );
}
