"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { cancelRun, getRunState, retryRun, sendMessage } from "@/app/(app)/conversations/actions";
import { SendIcon, StopIcon } from "@/components/icons";
import { Button, buttonClassName } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { RelativeTime } from "@/components/ui/relative-time";
import { useNow } from "@/components/use-now";
import { MESSAGE_MAX_LENGTH, messageContentSchema } from "@/lib/conversations/validation";
import type { RunSnapshot, RunState, ToolCallView } from "@/server/conversations/service";
import { Markdown } from "./markdown";
import { ToolActivity, type ToolInfo } from "./tool-activity";

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
  createdAt: Date;
  /** On a reply: the run that produced it. */
  runId: string | null;
  /** On a message the owner sent: the ID the browser chose for it. */
  clientMessageId: string | null;
};

type ConversationViewProps = {
  agent: ConversationAgent;
  /** null for a new conversation; the first message creates it. */
  conversationId: string | null;
  messages: ConversationMessage[];
  runs: RunState[];
  /** Every tool call in the conversation, oldest first. */
  toolCalls: ToolCallView[];
  toolInfo: ToolInfo;
};

/** How often the run's state is fetched: often while text streams in. */
const POLL_PENDING_MS = 1_000;
const POLL_RUNNING_MS = 500;
/** A pending run this old suggests the worker isn't running. */
const WORKER_HINT_AFTER_MS = 10_000;
/** Within this many pixels of the end counts as "reading the latest". */
const NEAR_BOTTOM_PX = 120;

const isActive = (run: RunState) => run.status === "pending" || run.status === "running";

/**
 * One conversation with an agent. Everything shown is real: messages come
 * from PostgreSQL, and the reply's status and text are the run's actual
 * state, fetched from the server while it is pending or running. Text appears
 * as the worker saves it from Claude's stream; nothing is typed out for show.
 * When the run ends, the page re-renders on the server with the saved reply.
 */
export function ConversationView({ agent, conversationId, messages, runs, toolCalls, toolInfo }: ConversationViewProps) {
  const router = useRouter();
  const composerId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();
  const [stopping, startStopping] = useTransition();
  const [retrying, startRetrying] = useTransition();
  const [stopRequestedFor, setStopRequestedFor] = useState<string | null>(null);
  // One ID per message the owner sends, reused if the same send is retried,
  // so the server can recognise a repeat instead of saving it twice.
  const sendId = useRef<string | null>(null);
  const [optimisticMessages, addOptimisticMessage] = useOptimistic(
    messages,
    (current, sent: { content: string; clientMessageId: string }) => [
      ...current,
      { id: "sending", role: "user" as const, createdAt: new Date(), runId: null, ...sent },
    ],
  );
  // Everything below is reconciled by ID, so nothing can show twice: the
  // message being sent disappears once the saved one (same clientMessageId)
  // is on the page, and a run's streamed text once its saved reply (same runId) is.
  const savedClientIds = new Set(messages.map((message) => message.clientMessageId));
  const savedReplyRunIds = new Set(messages.map((message) => message.runId));
  const visibleMessages = optimisticMessages.filter(
    (message) => message.id !== "sending" || !savedClientIds.has(message.clientMessageId),
  );

  const activeRun = runs.find(isActive);
  const { liveRun, lastText, connectionLost } = useRunPolling(activeRun);
  const now = useNow(Boolean(activeRun));

  // The latest run per message (a retry adds a newer one), with live state on top.
  const runByMessage = new Map<string, RunState>();
  for (const run of runs) {
    if (run.userMessageId) runByMessage.set(run.userMessageId, run.id === liveRun?.id ? liveRun : run);
  }

  // Tool calls per run; the live run's come from the latest poll.
  const callsByRun = new Map<string, ToolCallView[]>();
  for (const call of toolCalls) callsByRun.set(call.runId, [...(callsByRun.get(call.runId) ?? []), call]);
  const callsFor = (runId: string) => (liveRun?.id === runId ? liveRun.toolCalls : (callsByRun.get(runId) ?? []));

  const lastMessage = messages.at(-1);
  const lastRun = lastMessage?.role === "user" ? runByMessage.get(lastMessage.id) : undefined;
  const canRetry =
    !agent.unavailableReason && !activeRun && (lastRun?.status === "failed" || lastRun?.status === "cancelled");

  const { endRef, atBottom, scrollToEnd } = useStickToBottom(
    `${visibleMessages.length}:${lastRun?.status}:${liveRun?.partialOutput?.length ?? 0}:${liveRun?.toolCalls.map((call) => call.status).join()}`,
  );

  const canSend = !agent.unavailableReason && !activeRun && !sending;

  function send() {
    if (!canSend) return;
    const check = messageContentSchema.safeParse(draft);
    if (!check.success) {
      setError(check.error.issues[0]?.message ?? "Write a message first.");
      return;
    }
    const content = check.data;
    sendId.current ??= crypto.randomUUID();
    const clientMessageId = sendId.current;
    setError(null);
    startSending(async () => {
      addOptimisticMessage({ content, clientMessageId });
      try {
        const result = await sendMessage(
          conversationId
            ? { conversationId, agentId: agent.id, content, clientMessageId }
            : { agentId: agent.id, content, clientMessageId },
        );
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        sendId.current = null;
        setDraft("");
        if (conversationId) router.refresh();
        else router.replace(`/conversations/${result.data.conversationId}`);
      } catch {
        // The request failed in transit (server stopped, network down). It may
        // or may not have been saved; sending again reuses the same ID, so it
        // can't be saved twice.
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

  function retry() {
    if (!lastRun || !canRetry || retrying) return;
    startRetrying(async () => {
      try {
        const result = await retryRun(lastRun.id);
        if (!result.ok) setError(result.error.message);
        else router.refresh();
      } catch {
        setError("Couldn’t reach Solas. Try again.");
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
      <ol aria-label="Messages" className="flex flex-col gap-7 pb-6">
        {visibleMessages.length === 0 && (
          <li className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center">
            <p className="font-medium">Start the conversation</p>
            <p className="mt-1 text-sm text-muted">
              {agent.name} answers with its saved instructions
              {agent.modelLabel ? <> using {agent.modelLabel}</> : null}. The conversation is saved, so you can
              leave and continue later.
            </p>
          </li>
        )}
        {visibleMessages.map((message) => {
          const run = message.role === "user" ? runByMessage.get(message.id) : undefined;
          return (
            <li key={message.id} className="flex flex-col gap-5">
              <MessageBlock message={message} agentName={agent.name} />
              {message.id === "sending" && <StatusLine>Sending…</StatusLine>}
              {run?.status === "completed" && (
                <ToolActivity calls={callsFor(run.id)} toolInfo={toolInfo} agentName={agent.name} now={now} collapsed />
              )}
              {run && run.status !== "completed" && (
                <RunBlock
                  run={run}
                  calls={callsFor(run.id)}
                  toolInfo={toolInfo}
                  agentName={agent.name}
                  now={now}
                  connectionLost={connectionLost && run.id === activeRun?.id}
                  stopRequested={stopRequestedFor === run.id}
                  onRetry={run.id === lastRun?.id && canRetry ? retry : undefined}
                  retrying={retrying}
                />
              )}
              {/* Finished, and the saved reply is still on its way from the server.
                  Shown only until a saved reply for this run is on the page. */}
              {run?.status === "completed" && lastText?.runId === run.id && !savedReplyRunIds.has(run.id) && (
                <AgentText agentName={agent.name} label="just now">
                  {lastText.text}
                </AgentText>
              )}
            </li>
          );
        })}
      </ol>

      <div className="sticky bottom-0 -mx-4 bg-background px-4 pt-2 pb-4 md:mx-0 md:px-0">
        {!atBottom && visibleMessages.length > 0 && (
          <div className="pointer-events-none absolute -top-10 right-0 left-0 flex justify-center">
            <Button size="sm" onClick={scrollToEnd} className="pointer-events-auto shadow-popover">
              Jump to latest
            </Button>
          </div>
        )}
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
                sendId.current = null; // a changed message is a new message
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
      {/* Below the sticky composer, so "the end" really is the end of the page. */}
      <div ref={endRef} />
    </div>
  );
}

function MessageBlock({ message, agentName }: { message: ConversationMessage; agentName: string }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
        <div className="rounded-lg bg-surface-hover px-4 py-2.5 text-reading break-words whitespace-pre-wrap">
          <span className="sr-only">You: </span>
          {message.content}
        </div>
        {message.id !== "sending" && (
          <span className="text-xs text-subtle tabular-nums">
            <RelativeTime date={message.createdAt} />
          </span>
        )}
      </div>
    );
  }
  return (
    <AgentText agentName={agentName} time={message.createdAt}>
      {message.content}
    </AgentText>
  );
}

/** An agent's text: name and time above, Markdown below. */
function AgentText({
  agentName,
  time,
  label,
  muted = false,
  children,
}: {
  agentName: string;
  time?: Date;
  label?: string;
  muted?: boolean;
  children: string;
}) {
  return (
    <div className={muted ? "text-muted" : undefined}>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-subtle">
        <span className="font-medium text-muted">{agentName}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{time ? <RelativeTime date={time} /> : label}</span>
      </p>
      <Markdown>{children}</Markdown>
    </div>
  );
}

function RunBlock({
  run,
  calls,
  toolInfo,
  agentName,
  now,
  connectionLost,
  stopRequested,
  onRetry,
  retrying,
}: {
  run: RunState;
  calls: ToolCallView[];
  toolInfo: ToolInfo;
  agentName: string;
  now: number | null;
  connectionLost: boolean;
  stopRequested: boolean;
  onRetry?: () => void;
  retrying: boolean;
}) {
  const retryButton = onRetry && (
    <Button size="sm" onClick={onRetry} disabled={retrying}>
      {retrying ? "Retrying…" : "Retry"}
    </Button>
  );

  if (run.status === "failed" || run.status === "cancelled") {
    return (
      <div className="flex flex-col gap-3">
        <ToolActivity calls={calls} toolInfo={toolInfo} agentName={agentName} now={now} />
        {run.partialOutput && (
          <AgentText agentName={agentName} label="incomplete, not saved" muted>
            {run.partialOutput}
          </AgentText>
        )}
        {run.status === "failed" ? (
          <Callout tone="danger" title="No reply" actions={retryButton}>
            {run.errorMessage ?? "The run failed. Check the worker log."}
          </Callout>
        ) : (
          <div className="flex items-center gap-3">
            <StatusLine>Stopped. No reply was saved.</StatusLine>
            {retryButton}
          </div>
        )}
      </div>
    );
  }

  const elapsed = now !== null && run.startedAt ? ` · ${formatElapsed(now - new Date(run.startedAt).getTime())}` : "";
  const waitedLong =
    run.status === "pending" && now !== null && now - new Date(run.createdAt).getTime() > WORKER_HINT_AFTER_MS;

  const awaitingApproval = calls.some((call) => call.status === "awaiting_approval");
  return (
    <div className="flex flex-col gap-3">
      <ToolActivity calls={calls} toolInfo={toolInfo} agentName={agentName} now={now} />
      {run.status === "running" && run.partialOutput && (
        <AgentText agentName={agentName} label="writing">
          {run.partialOutput}
        </AgentText>
      )}
      <StatusLine active>
        {run.status === "pending"
          ? "Waiting for the worker to start…"
          : awaitingApproval
            ? "Waiting for your approval"
            : stopRequested
              ? `Stopping${elapsed}`
              : `${run.partialOutput ? `${agentName} is writing` : `${agentName} is responding`}${elapsed}`}
      </StatusLine>
      {waitedLong && (
        <p className="text-sm text-muted">
          Nothing has picked this up yet. Is the worker running? Start it with <code>npm run worker</code>.
        </p>
      )}
      {connectionLost && <p className="text-sm text-muted">Lost contact with Solas. Retrying…</p>}
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
 * Fetches the active run's real state: every second while it waits, twice a
 * second while text streams in. When it ends, refreshes the page so the
 * server renders the saved reply (or the error) from the database.
 */
function useRunPolling(activeRun: RunState | undefined) {
  const router = useRouter();
  const [liveRun, setLiveRun] = useState<RunSnapshot | null>(null);
  // The last text seen for a run, shown for the moment between "completed"
  // and the saved reply arriving (the run's draft is cleared when it completes).
  const [lastText, setLastText] = useState<{ runId: string; text: string } | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const runId = activeRun?.id;

  useEffect(() => {
    if (!runId) return;
    const id = runId;
    let stopped = false;
    let timer: number | undefined;
    let status = "pending";

    async function tick() {
      try {
        const result = await getRunState(id);
        if (stopped) return;
        setConnectionLost(false);
        if (result.ok) {
          status = result.data.status;
          setLiveRun(result.data);
          if (result.data.partialOutput) setLastText({ runId: id, text: result.data.partialOutput });
          if (!isActive(result.data)) {
            stopped = true;
            router.refresh();
            return;
          }
        }
      } catch {
        if (!stopped) setConnectionLost(true);
      }
      if (!stopped) timer = window.setTimeout(tick, status === "running" ? POLL_RUNNING_MS : POLL_PENDING_MS);
    }

    timer = window.setTimeout(tick, POLL_RUNNING_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [runId, router]);

  return {
    // Keep the finished state until the refreshed page replaces it.
    liveRun: liveRun && (liveRun.id === runId || !isActive(liveRun)) ? liveRun : null,
    lastText,
    connectionLost,
  };
}

/**
 * Keeps the newest content in view, but only while the owner is reading the
 * end. Scrolling up to read stops the following; "Jump to latest" resumes it.
 */
function useStickToBottom(contentKey: string) {
  const endRef = useRef<HTMLDivElement>(null);
  // Starts true so a conversation opens at its newest message.
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    function onScroll() {
      const distance = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      following.current = distance < NEAR_BOTTOM_PX;
      setAtBottom(following.current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (following.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [contentKey]);

  function scrollToEnd() {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    endRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }

  return { endRef, atBottom, scrollToEnd };
}
