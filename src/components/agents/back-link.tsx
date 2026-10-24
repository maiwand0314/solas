import Link from "next/link";
import { ArrowLeftIcon } from "@/components/icons";

export function BackLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="mb-5 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted transition-colors duration-100 hover:text-foreground"
    >
      <ArrowLeftIcon className="size-3.5" />
      {children}
    </Link>
  );
}
