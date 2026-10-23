import Link from "next/link";
import { cn } from "@/lib/cn";

type WordmarkProps = {
  /** Show only the initial, for the collapsed sidebar rail. */
  monogram?: boolean;
  className?: string;
};

/** Temporary typographic wordmark until the brand identity is designed. */
export function Wordmark({ monogram = false, className }: WordmarkProps) {
  return (
    <Link
      href="/"
      aria-label="Solas, go to Overview"
      className={cn(
        "rounded-md px-1.5 py-0.5 text-lg font-semibold tracking-[-0.02em] text-foreground",
        className,
      )}
    >
      {monogram ? "S" : "Solas"}
    </Link>
  );
}
