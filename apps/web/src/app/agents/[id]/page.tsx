"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Check, Copy, Lock, RefreshCw } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import { motion } from "motion/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { BorderBeamButton } from "@/components/ui/border-beam-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyButton } from "@/components/ui/copy-button";
import AgentAvatar from "@/components/ui/agent-avatar";
import { Markdown } from "@/components/ui/markdown";
import { useGuestSession } from "@/lib/session";
import { cachedFetch, useCachedData } from "@/lib/client-cache";
import { useTheme } from "next-themes";

type ToolCall = { tool: string; input?: unknown; output?: unknown };
type ChatMessage = {
  role: "user" | "agent";
  content: string;
  toolsUsed: ToolCall[];
  timestamp: string;
  attestationId?: string | null;
};

// strip markdown so copying an ai reply pastes clean prose, not syntax:
// fences, backticks, bold/italic markers, headings, blockquotes, link
// destinations, and gfm table pipes are removed, text content kept.
const plainTextFromMarkdown = (src: string): string =>
  src
    .replace(/```[a-zA-Z0-9_-]*\s*\n?/g, "")
    .replace(/`/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[*+]\s+/gm, "- ")
    .replace(/^[\s|:\-]{2,}$/gm, "")
    .replace(/^\|/gm, "")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const actionButton =
  "flex items-center justify-center size-7 rounded-full text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-all duration-200 dark:hover:text-neutral-200 dark:hover:bg-white/10";

// one icon-sized action per message: copy for both roles, retry for agents.
function MessageActionCopy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={actionButton}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
type AgentScore = {
  agentId: string;
  composite: number;
  breakdown: {
    source: string;
    value: number;
    count: number;
    lastUpdated: string;
  }[];
  computedAt: string;
};
type Attestation = {
  id: string;
  agentId: string;
  task: string;
  output: string;
  toolsUsed: ToolCall[];
  source: string;
  contentHash: string;
  signature: string;
  signedBy: string;
  timestamp: string;
  schemaVersion: number;
};
type ApiError = { error?: { code?: string; message?: string } };

const toolLine = (tools: ToolCall[]) =>
  tools.map((t) => `tool: ${t.tool}`).join(" · ");

// a smooth entry for freshly added bubbles; history rendered from the cache
// mounts without animation so reloads do not replay every row.
const bubbleMotion = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: "spring" as const, stiffness: 400, damping: 30 },
};

export default function ChatInterface() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const { theme } = useTheme()
  const queryName = searchParams.get("name");
  const { ready: sessionReady, session: guest } = useGuestSession();

  const [name, setName] = useState<string | null>(queryName ?? null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<ChatMessage | null>(
    null,
  );
  const [sendSeq, setSendSeq] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const firstScrollRef = useRef(true);
  const prevGeneratingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const transcriptKey =
    sessionReady && guest !== null && id !== undefined
      ? `chat:${guest.userId}:${id}`
      : null;
  const scoreKey =
    sessionReady && guest !== null && id !== undefined
      ? `score:${guest.userId}:${id}`
      : null;

  const {
    data: transcriptData,
    error: transcriptError,
    locked: transcriptLocked,
    commit: commitTranscript,
    lock: lockTranscript,
  } = useCachedData<{ agentId: string; messages: ChatMessage[] }>(
    transcriptKey,
    () =>
      cachedFetch<{ agentId: string; messages: ChatMessage[] }>(
        `/api/agents/${encodeURIComponent(id ?? "")}/chat`,
      ),
    // a mount-time transcript GET can resolve after the chat POST committed
    // the fresher full transcript (groq takes seconds); length is monotonic
    // for one agent, so never regress to a shorter list.
    {
      // length is monotonic for one agent, so never regress to a shorter
      // list even when a slow mount-time GET resolves after a chat POST.
      merge: (prev, fresh) => {
        if (prev.messages.length !== fresh.messages.length) {
          return prev.messages.length >= fresh.messages.length ? prev : fresh;
        }
        // equal length: prefer the copy carrying more attestation links, so
        // a cached transcript from before the per-message attestation
        // backfill cannot hold the footers hostage.
        const linked = (msgs: ChatMessage[]) =>
          msgs.filter(
            (m) => m.attestationId !== null && m.attestationId !== undefined,
          ).length;
        return linked(fresh.messages) >= linked(prev.messages) ? fresh : prev;
      },
    },
  );

  const {
    data: scoreData,
    error: scoreError,
    commit: commitScore,
  } = useCachedData<{ manifest?: { name: string }; score?: AgentScore }>(
    scoreKey,
    () =>
      cachedFetch<{ manifest?: { name: string }; score?: AgentScore }>(
        `/api/agents/${encodeURIComponent(id ?? "")}/score`,
      ),
    // composite only ever grows (attestations are append-only), so a stale
    // score GET resolving late must not regress the chip after a chat POST.
    {
      merge: (prev, fresh) =>
        (fresh.score?.composite ?? 0) >= (prev.score?.composite ?? 0)
          ? fresh
          : prev,
    },
  );

  const locked = transcriptLocked;
  const loadError = transcriptError ?? scoreError;

  // keep focus in the composer whenever it becomes available: on mount,
  // after a lock clears, and after a turn finishes generating. it never
  // focuses while disabled, so focus cannot land on an inert input.
  const composerEnabled = !locked && !isGenerating && loadError === null;
  useEffect(() => {
    if (composerEnabled) composerRef.current?.focus();
  }, [composerEnabled]);

  // sync name from score manifest when no query name was provided (deep link)
  useEffect(() => {
    if (scoreData?.manifest?.name && name === null) {
      setName(scoreData.manifest.name.replace(/\.agent$/, ""));
    }
  }, [scoreData, name]);

  const searchOrb = (size: 64 | 20) => (
    <ThinkingOrb state="searching" size={size} />
  );

  // optimistic display list: server transcript plus the in-flight user bubble.
  const messages = transcriptData?.messages ?? null;
  const displayedMessages: ChatMessage[] =
    pendingMessage === null
      ? messages ?? []
      : [...(messages ?? []), pendingMessage];

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  // first data paint (cache or fresh fetch): land at the bottom once, so the
  // transcript does not replay a long scroll while the user watches.
  useEffect(() => {
    if (messages !== null && firstScrollRef.current) {
      firstScrollRef.current = false;
      scrollToBottom("auto");
    }
  }, [messages, scrollToBottom]);

  // on send, glide to your own bubble and the orb. on reply arrival, do
  // nothing on purpose: the answer replaces the orb in place, so the top of
  // the reply lands where the user already is instead of yanking the
  // viewport to the end of a long answer.
  useEffect(() => {
    if (isGenerating && !prevGeneratingRef.current) {
      scrollToBottom("smooth");
    }
    prevGeneratingRef.current = isGenerating;
  }, [isGenerating, scrollToBottom]);

  const hasText = message.trim().length > 0;

  const runTurn = async (text: string) => {
    if (locked || isGenerating || id === undefined || messages === null) return;
    setMessage("");
    setSendError(null);
    // optimistic bubble: your message is visible instantly while the agent
    // runs. it is client-only until the POST returns the authoritative
    // transcript, which then replaces it (same position, server-persisted).
    setPendingMessage({
      role: "user",
      content: text,
      toolsUsed: [],
      timestamp: new Date().toISOString(),
      attestationId: null,
    });
    setSendSeq((n) => n + 1);
    setIsGenerating(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body:
        | {
            chatSession: { agentId: string; messages: ChatMessage[] };
            score: AgentScore;
            scoreDelta: number;
            attestation: Attestation;
          }
        | ApiError = await res.json();
      if (!res.ok) {
        if (res.status === 403) {
          // the session key is gone (expired or never held): purge the cached
          // transcript and lock the composer, fail closed to the locked state.
          lockTranscript();
          setSendError(
            "this agent's session expired, create a new agent to continue",
          );
        } else {
          setSendError(
            (body as ApiError).error?.message ??
              "the agent could not run, try again",
          );
        }
        // the message never landed on the ledger: drop the optimistic bubble
        // and put the text back so nothing is silently lost.
        setPendingMessage(null);
        setMessage(text);
        return;
      }
      const okBody = body as {
        chatSession: { messages: ChatMessage[] };
        score: AgentScore;
        scoreDelta: number;
        attestation: Attestation;
      };
      commitTranscript({ agentId: id, messages: okBody.chatSession.messages });
      commitScore({
        manifest: { name: `${name ?? id.slice(0, 8)}.agent` },
        score: okBody.score,
      });
      setPendingMessage(null);
    } catch {
      setPendingMessage(null);
      setMessage(text);
      setSendError("could not reach the server, check your connection");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSend = async () => {
    const text = message.trim();
    if (!hasText) return;
    await runTurn(text);
  };

  // retry replays the user prompt that preceded the answer as a brand new
  // turn: the ledger is append-only (attestations are permanent signed
  // records and the score is composite over them), so the old exchange stays
  // visible with its own attestation and a fresh exchange is appended.
  const handleRetry = async (userPrompt: string) => {
    if (locked || isGenerating || messages === null) return;
    await runTurn(userPrompt);
  };

  const displayName = name ?? (id !== undefined ? id.slice(0, 8) : "agent");
  const scoreDelta =
    scoreData?.score !== undefined &&
    scoreData.score !== null &&
    scoreData.score.composite > 0
      ? `+${scoreData.score.composite.toFixed(2)}`
      : "+0.00";

  return (
    <div className="h-screen bg-white flex flex-col font-sans relative overflow-hidden dark:bg-neutral-950 dark:text-neutral-100">
      {/* Header Bar — fixed height, never squeezed by the transcript */}
      <header className="flex items-center gap-4 w-full max-w-5xl mx-auto shrink-0 px-4 py-3 z-20">
        <Link
          href="/agents"
          className="p-2 rounded-full hover text-neutral-600 hover:text-neutral-800 transition-all duration-200 hover:scale-102 active:scale-98 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>

        <div className="flex-1 flex items-center gap-3 min-w-0">
          <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden dark:from-neutral-800 dark:to-neutral-700">
            <AgentAvatar
              name={displayName}
              seed={id}
              className="w-full h-full"
            />
          </div>
          <div className="flex flex-col items-start gap-0.5 min-w-0">
            <h1 className="text-sm font-medium tracking-tight text-neutral-900 truncate dark:text-neutral-50">
              {displayName}
            </h1>
            <div className="flex items-center gap-1.5 text-xs text-neutral-400">
              <CopyButton
                value={id ?? ""}
                label="Copy agent id"
                className="text-xs"
              >
                <span className="font-mono">
                  {id !== undefined && `${id.slice(0, 4)}...${id.slice(-4)}`}
                </span>
              </CopyButton>
              {locked && (
                <span className="flex items-center gap-1 bg-neutral-100 px-1.5 py-0.5 rounded-full text-neutral-500 text-[10px] font-medium dark:bg-white/10 dark:text-neutral-400">
                  <Lock className="w-2.5 h-2.5" strokeWidth={3} /> expired
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Live Score Chip */}
        <Link
          href={`/agents/${encodeURIComponent(
            id ?? "",
          )}/score?name=${encodeURIComponent(displayName)}`}
          className="ml-auto shrink-0"
        >
          <BorderBeamButton
            beamSize="pulse-inner"
            theme={theme === "dark" ? "dark" : "light"}
            className="cursor-pointer rounded-full text-xs md:text-md font-mono tracking-tight font-medium text-neutral-700 bg-transparent hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            <span className="size-2 rounded-full bg-emerald-500"></span>
            score{" "}
            {scoreData?.score !== undefined && scoreData.score !== null
              ? scoreData.score.composite.toFixed(2)
              : "—"}
            {scoreData?.score !== undefined &&
              scoreData.score !== null &&
              scoreData.score.composite > 0 && (
                <span className="text-emerald-600 text-sm font-semibold ml-2 dark:text-emerald-400">
                  {scoreDelta}
                </span>
              )}
          </BorderBeamButton>
        </Link>
      </header>

      {/* Transcript — this is the scroll view; flex-1 min-h-0 makes it take
          exactly the leftover space and scroll internally, so the composer
          below never moves or gets pushed around. */}
      <div className="relative w-full flex-1 min-h-0 flex justify-center z-10">
        <div className="w-full max-w-4xl flex flex-col h-full p-4">
          <ScrollArea className="flex-1 min-h-0">
            <div className="flex flex-col gap-3 py-4 pr-3 min-h-full">
              {loadError ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-6 gap-3">
                  <p className="text-sm font-medium text-rose-600 dark:text-rose-400">
                    {loadError}
                  </p>
                  <Link
                    href="/agents"
                    className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    back to your agents
                  </Link>
                </div>
              ) : displayedMessages.length === 0 && !locked ? (
                messages === null ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
                    <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
                      {searchOrb(20)}
                      loading transcript
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                      say hello to get started
                    </p>
                    <p className="text-xs text-neutral-500 mt-1 dark:text-neutral-400">
                      your first message becomes this agent&apos;s first attestation
                    </p>
                  </div>
                )
              ) : locked ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-6 gap-3">
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    this agent&apos;s signing key expired after inactivity
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    create a new agent to continue.
                  </p>
                  <Link
                    href="/agents/new"
                    className="text-xs font-medium text-neutral-900 hover:underline mt-1 dark:text-neutral-50"
                  >
                    create a new agent
                  </Link>
                </div>
              ) : (
                displayedMessages.map((msg, idx) => {
                  // animate only the newest bubble (the fresh reply or the
                  // optimistic user bubble); history is static.
                  const isNew =
                    (pendingMessage !== null &&
                      idx === displayedMessages.length - 1) ||
                    (pendingMessage === null &&
                      idx === displayedMessages.length - 1 &&
                      msg.role === "agent");
                  const key =
                    pendingMessage !== null &&
                    idx === displayedMessages.length - 1
                      ? `pending-${sendSeq}`
                      : idx;
                  return msg.role === "agent" ? (
                    <motion.div
                      key={key}
                      {...(isNew ? bubbleMotion : { initial: false })}
                      className="group flex flex-col items-start gap-1"
                    >
                      <div className="max-w-[99%] lg:max-w-[95%] min-w-0 rounded-2xl tracking-[-0.018em] px-4 text-sm text-neutral-800 wrap-break-words dark:text-neutral-100">
                        <Markdown content={msg.content} />
                      </div>
                      {msg.toolsUsed.length > 0 && (
                        <div className="flex items-center gap-2 px-2">
                          <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                            {toolLine(msg.toolsUsed)}
                          </span>
                        </div>
                      )}
                      {!locked && (
                        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-out group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]">
                          <div className="min-h-0 overflow-hidden">
                            <div className="flex items-center gap-1 py-1">
                              <MessageActionCopy
                                value={plainTextFromMarkdown(msg.content)}
                                label="Copy message text"
                              />
                              {idx > 0 &&
                                displayedMessages[idx - 1].role === "user" && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleRetry(
                                        displayedMessages[idx - 1].content,
                                      )
                                    }
                                    disabled={isGenerating}
                                    aria-label="Retry this answer"
                                    title="Retry this answer"
                                    className={`${actionButton} ${
                                      isGenerating
                                        ? "opacity-40 cursor-not-allowed"
                                        : ""
                                    }`}
                                  >
                                    <RefreshCw className="size-3.5" />
                                  </button>
                                )}
                            </div>
                          </div>
                        </div>
                      )}
                      {msg.attestationId !== null &&
                        msg.attestationId !== undefined && (
                          <div className="flex items-center pl-2 pr-1">
                            <CopyButton
                              value={msg.attestationId}
                              label="Copy attestation id"
                              className="text-[10px]"
                            >
                              <span className="font-mono">
                                attestation: {msg.attestationId.slice(0, 6)}...
                                {msg.attestationId.slice(-4)}
                              </span>
                            </CopyButton>
                          </div>
                        )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key={key}
                      {...(isNew ? bubbleMotion : { initial: false })}
                      className="group flex flex-col items-end justify-end gap-1"
                    >
                      <div className="max-w-[95%] bg-neutral-900 rounded-2xl tracking-[-0.016em] px-4 py-3 text-sm text-white whitespace-pre-wrap dark:bg-white dark:text-black">
                        {msg.content}
                      </div>
                      {!locked && (
                        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-out group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]">
                          <div className="min-h-0 overflow-hidden">
                            <div className="flex items-center gap-1 py-1">
                              <MessageActionCopy
                                value={msg.content}
                                label="Copy message text"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  );
                })
              )}

              {!locked && isGenerating && (
                <div className="flex items-start w-fit justify-center gap-1 bg-black/5 rounded-full px-4 py-2 text-sm text-neutral-800 tracking-tight dark:bg-white/10 dark:text-neutral-100">
                  {searchOrb(20)}
                </div>
              )}

              {sendError && (
                <div className="flex flex-col items-center gap-1.5 px-2">
                  <p className="text-xs text-rose-600 font-medium dark:text-rose-400">
                    {sendError}
                  </p>
                  {pendingMessage === null && message.trim().length > 0 && (
                    <button
                      onClick={() => void handleSend()}
                      className="text-[11px] font-medium text-neutral-600 hover:text-neutral-900 transition-colors dark:text-neutral-400 dark:hover:text-neutral-100"
                    >
                      retry send
                    </button>
                  )}
                </div>
              )}

              {/* bottom sentinel drives the scroll-into-view */}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Composer — shrink-0 keeps it pinned; it never shares scroll with the
          transcript above. */}
      <div className="w-full flex flex-col items-center gap-3 shrink-0 px-4 pb-4 pt-2">
        <div className="w-full max-w-4xl bg-white rounded-3xl shadow-xs border border-neutral-200 p-4 flex flex-col relative z-20 transition-all duration-200 dark:bg-neutral-900 dark:border-neutral-800">
          <textarea
            ref={composerRef}
            disabled={locked || isGenerating || loadError !== null}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setSendError(null);
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void handleSend();
              }
            }}
            className="w-full flex-1 bg-transparent text-md text-neutral-900 tracking-[-0.016em] placeholder-neutral-500 outline-none resize-none disabled:opacity-50 dark:text-neutral-50"
            placeholder={
              locked
                ? "session expired"
                : isGenerating
                ? "waiting for agent response..."
                : `Message ${displayName}...`
            }
          ></textarea>

          <div className="flex justify-between items-end mt-4 pt-2 relative">
            <span className="text-xs font-mono text-neutral-400">
              openai/gpt-oss-20b via groq
            </span>

            <div className="flex items-center gap-3">
              {!isGenerating && !locked ? (
                <button
                  onClick={() => void handleSend()}
                  disabled={!hasText || messages === null}
                  className={`p-2 rounded-full transition-all duration-300 ease-out ${
                    hasText && messages !== null
                      ? "bg-neutral-900 text-white hover:scale-102 active:scale-98 dark:bg-white dark:text-black"
                      : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/10"
                  }`}
                >
                  <ArrowUp className="size-5" />
                </button>
              ) : isGenerating ? (
                <button
                  disabled
                  className="p-3 flex items-center justify-center rounded-full bg-neutral-100 text-white transition-all duration-300 ease-out dark:bg-white/10"
                >
                  <div className="size-4 rounded-sm bg-black" />
                </button>
              ) : (
                <button
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-neutral-100 text-neutral-500 cursor-not-allowed dark:bg-white/10 dark:text-neutral-400"
                  disabled
                >
                  locked
                </button>
              )}
            </div>
          </div>
        </div>

        <h1 className="text-sm font-medium tracking-tight text-center text-neutral-500 dark:text-neutral-400">
          Artificial Intelligence is subject to make mistakes. Verify
          information before using it.
        </h1>
      </div>
    </div>
  );
}
