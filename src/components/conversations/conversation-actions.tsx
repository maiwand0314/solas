"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { deleteConversation, renameConversation } from "@/app/(app)/conversations/actions";
import { AgentsIcon, PencilIcon, TrashIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field, fieldAria } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { conversationTitleSchema, TITLE_MAX_LENGTH } from "@/lib/conversations/validation";

type ConversationRef = { id: string; title: string; agentId: string };

const dialogClassName =
  "mx-auto my-auto w-[min(440px,calc(100vw-2rem))] rounded-xl border border-border bg-surface-raised shadow-popover open:animate-dialog-in";

/** The "⋯" menu in a conversation's header: Rename, Open agent, Delete. */
export function ConversationActions({ conversation }: { conversation: ConversationRef }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);

  return (
    <>
      <Menu
        label="Conversation actions"
        items={[
          { label: "Rename…", icon: PencilIcon, onSelect: () => setDialog("rename") },
          { label: "Open agent", icon: AgentsIcon, onSelect: () => router.push(`/agents/${conversation.agentId}`) },
          { label: "Delete…", icon: TrashIcon, tone: "danger", separated: true, onSelect: () => setDialog("delete") },
        ]}
      />
      {/* key: a fresh form with the current title each time it opens */}
      <RenameDialog
        key={dialog === "rename" ? "open" : "closed"}
        conversation={conversation}
        open={dialog === "rename"}
        onOpenChange={(open) => setDialog(open ? "rename" : null)}
      />
      <DeleteDialog
        conversation={conversation}
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
      />
    </>
  );
}

type DialogProps = { conversation: ConversationRef; open: boolean; onOpenChange: (open: boolean) => void };

function RenameDialog({ conversation, open, onOpenChange }: DialogProps) {
  const titleId = useId();
  const inputId = useId();
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const check = conversationTitleSchema.safeParse(title);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "Enter a title.");
      return;
    }
    startTransition(async () => {
      const result = await renameConversation(conversation.id, check.data);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      toast.success("Conversation renamed.");
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !pending && onOpenChange(next)}
      aria-labelledby={titleId}
      className={dialogClassName}
    >
      <form onSubmit={onSubmit} noValidate>
        <div className="p-5">
          <h2 id={titleId} className="mb-4 text-lg font-semibold tracking-[-0.01em]">
            Rename conversation
          </h2>
          <Field id={inputId} label="Title" required error={error ?? undefined}>
            <Input
              {...fieldAria(inputId, { error: error ?? undefined })}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              maxLength={TITLE_MAX_LENGTH}
              autoComplete="off"
              autoFocus
            />
          </Field>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
          <Button onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ conversation, open, onOpenChange }: DialogProps) {
  const router = useRouter();
  const titleId = useId();
  const descriptionId = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function changeOpen(next: boolean) {
    if (pending) return; // don't close mid-request
    if (!next) setError(null);
    onOpenChange(next);
  }

  function confirmDelete() {
    if (pending) return;
    startTransition(async () => {
      const result = await deleteConversation(conversation.id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      toast.success("Conversation deleted.");
      router.replace("/conversations");
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={dialogClassName}
    >
      <div className="p-5">
        <h2 id={titleId} className="text-lg font-semibold tracking-[-0.01em] break-words">
          Delete “{conversation.title}”?
        </h2>
        <p id={descriptionId} className="mt-2 text-muted">
          This permanently deletes the conversation and all its messages. A reply that is still being written is
          stopped. The agent itself is not affected.
        </p>
        {error && (
          <Callout tone="danger" role="alert" className="mt-4">
            {error}
          </Callout>
        )}
      </div>
      <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
        {/* autoFocus: the dialog opens with the safe option focused. */}
        <Button autoFocus onClick={() => changeOpen(false)} disabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" onClick={confirmDelete} disabled={pending}>
          {pending ? "Deleting…" : "Delete conversation"}
        </Button>
      </div>
    </Dialog>
  );
}
