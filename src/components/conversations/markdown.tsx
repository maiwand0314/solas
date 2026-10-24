"use client";

import { isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

// Renders an agent's reply as Markdown, styled with Solas tokens.
//
// Safety: react-markdown builds React elements and never injects HTML, so raw
// HTML in a reply shows as text. Unsafe link schemes (javascript:) are removed
// by its default URL filter. Images are not rendered at all: an image from an
// arbitrary URL would make the browser contact that server on its own.

const components: Components = {
  // Headings sit below the page's own h1 (the conversation title).
  h1: ({ children }) => <h3 className="mt-6 mb-2 text-lg font-semibold tracking-[-0.01em] first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-5 mb-2 font-semibold first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-4 mb-1.5 font-medium first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 marker:text-subtle">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-subtle">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border-strong pl-3 text-muted">{children}</blockquote>,
  hr: () => <hr className="my-5 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-surface-hover px-3 py-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-t border-border px-3 py-2 align-top">{children}</td>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

export function Markdown({ children }: { children: string }) {
  return (
    // Inline code (code not inside a pre) gets a subtle chip; code blocks are styled by CodeBlock.
    <div className="text-reading break-words [&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-surface-hover [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.875em]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={["img"]} unwrapDisallowed>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** A fenced code block: language label, a Copy button, and horizontal scrolling. */
function CodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = languageOf(children);

  async function copy() {
    // Markdown keeps the line break before the closing fence; don't copy it.
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the code is still selectable.
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex h-9 items-center justify-between border-b border-border pr-1.5 pl-3">
        <span className="font-mono text-xs text-subtle">{language ?? "code"}</span>
        <Button size="sm" variant="ghost" onClick={copy} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <pre ref={preRef} className="overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-5">
        {children}
      </pre>
    </div>
  );
}

/** "language-ts" on the inner <code> → "ts". */
function languageOf(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const className = (children as ReactElement<{ className?: string }>).props.className ?? "";
  return /language-(\S+)/.exec(className)?.[1] ?? null;
}
