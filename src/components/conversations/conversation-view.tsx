"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { cancelRun, getRunState, sendMessage } from "@/app/(app)/conversations/actions";
import { SendIcon, StopIcon } from "@/components/icons";
import { Button, buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { MESSAGE_MAX_LENGTH, messageContentSchema } from "@/lib/conversations/validation";
import type { RunState } from "@/server/conversations/service";

export type ConversationAgent = {
  id: string;
  name: string;
  /** "Claude · Opus 5.5", or null when no model is set. */
  modelLabel: string | null;
  /** Why the agent can't answer right now, or null when it can. */
  unavailableReason: string | null;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ConversationViewProps = {
  agent: ConversationAgent;
  /** null for a new conversation; the first message creates it. */
  conversationId: string | null;
  messages: ConversationMessage[];
  runs: RunState[];
};

const POLL_MS = 1_000;
/** A pending run this old suggests the worker isn't running. */
const WORKER_HINT_AFTER_MS = 10_000;

const isActive = (run: RunState) => run.status === "pending" || run.status === "running";

/**
 * One conversation with an agent. Everything shown here is real: messages
 * come from PostgreSQL, and the reply status is the run's actual state, polled
 * from the server every second while a reply is pending or running. When the
 * run finishes, the page re-renders on the server with the saved reply.
 */
export function ConversationView({ agent, conversationId, messages, runs }: ConversationViewProps) {
  const router = useRouter();
  const composerId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [stopping, startStopping] = useTransition();
  const [stopRequestedFor, setStopRequestedFor] = useState<string | null>(null);
  const [optimisticMessages, addOptimisticMessage] = useOptimistic(messages, (current, content: string) => [
    ...current,
    { id: "sending", role: "user" as const, content },
  ]);

  const activeRun = runs.find(isActive);
  const { liveRun, connectionLost } = useRunPolling(activeRun);
  const now = useNow(Boolean(activeRun));
  const runByMessage = new Map(runs.map((run) => [run.userMessageId, run.id === liveRun?.id ? liveRun : run]));

  const endRef = useRef<HTMLDivElement>(null);
  const lastRun = runs.at(-1);
  // Keep the newest message and status in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [optimisticMessages.length, lastRun?.status, liveRun?.status]);

  const canSend = !agent.unavailableReason && !activeRun && !sending;

  function send() {
    if (!canSend) return;
    const check = messageContentSchema.safeParse(draft);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "Write a message first.");
      return;
    }
    const content = check.data;
    setError(null);
    startSending(async () => {
      addOptimisticMessage(content);
      try {
        const result = await sendMessage(
          conversationId ? { conversationId, content } : { agentId: agent.id, content },
        );
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setDraft("");
        if (conversationId) router.refresh();
        else router.replace(`/conversations/${result.data.conversationId}`);
      } catch {
        // The request itself failed (server stopped, network down). Nothing
        // was saved that we know of, so keep the draft for another try.
        setError("Couldn’t reach Solas. Check that it’s running, then send again.");
      }
    });
  }

  function stop() {
    if (!activeRun || stopping) return;
    setStopRequestedFor(activeRun.id);
    startStopping(async () => {
      try {
        const result = await cancelRun(activeRun.id);
        if (!result.ok) setError(result.error.message);
        else if (!isActive(result.data)) router.refresh();
      } catch {
        setError("Couldn’t reach Solas to stop the reply. Try again.");
      }
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line; ignore Enter while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && activeRun) {
      event.preventDefault();
      stop();
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col">
      <ol aria-label="Messages" className="flex flex-col gap-6 pb-6">
        {optimisticMessages.length === 0 && (
          <li className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center">
            <p className="font-medium">Start the conversation</p>
            <p className="mt-1 text-sm text-muted">
              {agent.name} answers with its saved instructions
              {agent.modelLabel ? <> using {agent.modelLabel}</> : null}. Each reply is a real Claude run.
            </p>
          </li>
        )}
        {optimisticMessages.map((message) => {
          const run = message.role === "user" ? runByMessage.get(message.id) : undefined;
          return (
            <li key={message.id} className="flex flex-col gap-3">
              <MessageBubble message={message} agentName={agent.name} />
              {message.id === "sending" && <StatusLine>Sending…</StatusLine>}
              {run && run.status !== "completed" && (
                <RunStatus
                  run={run}
                  agentName={agent.name}
                  now={now}
                  connectionLost={connectionLost && run.id === activeRun?.id}
                  stopRequested={stopRequestedFor === run.id}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />

      <div className="sticky bottom-0 -mx-4 bg-background px-4 pt-2 pb-4 md:mx-0 md:px-0">
        {agent.unavailableReason ? (
          <Callout
            title={`${agent.name} can’t answer right now`}
            actions={
              <Link href={`/agents/${agent.id}`} className={buttonClassName({ size: "sm" })}>
                Open agent
              </Link>
            }
          >
            {agent.unavailableReason}
          </Callout>
        ) : (
          <form
            onSubmit={onSubmit}
            className="rounded-lg border border-border-strong bg-surface shadow-control focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
          >
            <label htmlFor={composerId} className="sr-only">
              Message {agent.name}
            </label>
            {/* A plain textarea: the form around it draws the border and focus ring. */}
            <textarea
              id={composerId}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={onKeyDown}
              maxLength={MESSAGE_MAX_LENGTH}
              rows={3}
              placeholder={`Message ${agent.name}`}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${composerId}-hint`}
              className="block max-h-64 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-reading text-foreground placeholder:text-subtle focus:outline-none"
            />
            <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
              <p id={`${composerId}-hint`} className="text-xs text-subtle">
                {activeRun ? "Wait for the reply, or stop it (Esc)." : "Enter to send · Shift+Enter for a new line"}
              </p>
              {activeRun ? (
                <Button size="sm" onClick={stop} disabled={stopping || stopRequestedFor === activeRun.id}>
                  <StopIcon className="size-3.5" />
                  {stopRequestedFor === activeRun.id ? "Stopping…" : "Stop"}
                </Button>
              ) : (
                <Button type="submit" size="sm" variant="primary" disabled={!canSend || draft.trim() === ""}>
                  <SendIcon className="size-3.5" />
                  {sending ? "Sending…" : "Send"}
                </Button>
              )}
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message, agentName }: { message: ConversationMessage; agentName: string }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-surface-hover px-4 py-2.5 text-reading break-words whitespace-pre-wrap">
        <span className="sr-only">You: </span>
        {message.content}
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-subtle">{agentName}</p>
      {/* Plain text for now: Markdown isn't rendered yet, so formatting marks show as typed. */}
      <div className="text-reading break-words whitespace-pre-wrap">{message.content}</div>
    </div>
  );
}

function RunStatus({
  run,
  agentName,
  now,
  connectionLost,
  stopRequested,
}: {
  run: RunState;
  agentName: string;
  now: number | null;
  connectionLost: boolean;
  stopRequested: boolean;
}) {
  if (run.status === "failed") {
    return (
      <Callout tone="danger" title="No reply">
        {run.errorMessage ?? "The run failed. Check the worker log."}
      </Callout>
    );
  }
  if (run.status === "cancelled") {
    return <StatusLine>Stopped. No reply was saved.</StatusLine>;
  }

  let text: string;
  if (run.status === "running") {
    text = stopRequested ? "Stopping" : `${agentName} is responding`;
    if (now !== null && run.startedAt) text += ` · ${formatElapsed(now - new Date(run.startedAt).getTime())}`;
  } else {
    text = "Waiting for the worker to start…";
  }
  const waitedLong =
    run.status === "pending" && now !== null && now - new Date(run.createdAt).getTime() > WORKER_HINT_AFTER_MS;

  return (
    <div>
      <StatusLine active>{text}</StatusLine>
      {waitedLong && (
        <p className="mt-1 text-sm text-muted">
          Nothing has picked this up yet. Is the worker running? Start it with <code>npm run worker</code>.
        </p>
      )}
      {connectionLost && <p className="mt-1 text-sm text-muted">Lost contact with Solas. Retrying…</p>}
    </div>
  );
}

function StatusLine({ children, active = false }: { children: string; active?: boolean }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted tabular-nums">
      {active && <span aria-hidden="true" className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />}
      {children}
    </p>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Polls the active run's real state. When it finishes, refreshes the page so
 * the server renders the saved reply (or the error) from the database.
 */
function useRunPolling(activeRun: RunState | undefined) {
  const router = useRouter();
  const [liveRun, setLiveRun] = useState<RunState | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const runId = activeRun?.id;

  useEffect(() => {
    if (!runId) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await getRunState(runId);
        if (stopped) return;
        setConnectionLost(false);
        if (!result.ok) return;
        setLiveRun(result.data);
        if (!isActive(result.data)) {
          stopped = true;
          window.clearInterval(timer);
          router.refresh();
        }
      } catch {
        if (!stopped) setConnectionLost(true);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [runId, router]);

  return { liveRun: liveRun?.id === runId ? liveRun : null, connectionLost };
}

function subscribeEverySecond(onTick: () => void) {
  const timer = window.setInterval(onTick, 1_000);
  return () => window.clearInterval(timer);
}
const subscribeNever = () => () => {};
// Rounded so repeated reads within a second return the same value.
const currentSecond = () => Math.floor(Date.now() / 1_000) * 1_000;

/**
 * The current time, updated every second while `ticking`, for elapsed times.
 * null on the server and during hydration: the server's clock isn't the
 * browser's, and showing two different times would break hydration.
 */
function useNow(ticking: boolean): number | null {
  return useSyncExternalStore(ticking ? subscribeEverySecond : subscribeNever, currentSecond, () => null);
}
