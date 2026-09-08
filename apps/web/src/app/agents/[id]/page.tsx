"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, Lock } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { BorderBeamButton } from "@/components/ui/border-beam-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CopyButton } from "@/components/ui/copy-button";
import AgentAvatar from "@/components/ui/agent-avatar";
import { useGuestSession } from "@/lib/session";
import { cachedFetch, useCachedData } from "@/lib/client-cache";

type ToolCall = { tool: string; input?: unknown; output?: unknown };
type ChatMessage = {
  role: "user" | "agent";
  content: string;
  toolsUsed: ToolCall[];
  timestamp: string;
};
type AgentScore = {
  agentId: string;
  composite: number;
  breakdown: { source: string; value: number; count: number; lastUpdated: string }[];
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

export default function ChatInterface() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const queryName = searchParams.get("name");
  const { ready: sessionReady, session: guest } = useGuestSession();

  const [name, setName] = useState<string | null>(queryName ?? null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [lastAttestationId, setLastAttestationId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transcriptKey = sessionReady && guest !== null && id !== undefined
    ? `chat:${guest.userId}:${id}`
    : null;
  const scoreKey = sessionReady && guest !== null && id !== undefined
    ? `score:${guest.userId}:${id}`
    : null;

  const {
    data: transcriptData,
    error: transcriptError,
    locked: transcriptLocked,
    commit: commitTranscript,
  } = useCachedData<{ agentId: string; messages: ChatMessage[] }>(
    transcriptKey,
    () => cachedFetch<{ agentId: string; messages: ChatMessage[] }>(`/api/agents/${encodeURIComponent(id ?? "")}/chat`),
  );

  const {
    data: scoreData,
    error: scoreError,
    commit: commitScore,
  } = useCachedData<{ manifest?: { name: string }; score?: AgentScore }>(
    scoreKey,
    () => cachedFetch<{ manifest?: { name: string }; score?: AgentScore }>(`/api/agents/${encodeURIComponent(id ?? "")}/score`),
  );

  const locked = transcriptLocked;
  const loadError = transcriptError ?? scoreError;

  // sync name from score manifest when no query name was provided (deep link)
  useEffect(() => {
    if (scoreData?.manifest?.name && name === null) {
      setName(scoreData.manifest.name.replace(/\.agent$/, ""));
    }
  }, [scoreData, name]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    scrollToBottom();
  }, [transcriptData, isGenerating, scrollToBottom]);

  const hasText = message.trim().length > 0;

  const handleSend = async () => {
    const text = message.trim();
    if (!hasText || locked || isGenerating || id === undefined) return;
    setMessage("");
    setSendError(null);
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
          setLocked(true);
          setSendError("this agent's session expired, create a new agent to continue");
        } else {
          setSendError(
            (body as ApiError).error?.message ?? "the agent could not run, try again",
          );
        }
        return;
      }
      const okBody = body as {
        chatSession: { messages: ChatMessage[] };
        score: AgentScore;
        scoreDelta: number;
        attestation: Attestation;
      };
      commitTranscript({ agentId: id, messages: okBody.chatSession.messages });
      commitScore({ manifest: { name: `${(name ?? id.slice(0, 8))}.agent` }, score: okBody.score });
      setLastAttestationId(okBody.attestation.id);
    } catch {
      setSendError("could not reach the server, check your connection");
    } finally {
      setIsGenerating(false);
    }
  };

  const displayName = name ?? (id !== undefined ? id.slice(0, 8) : "agent");
  const scoreDelta = scoreData?.score !== undefined && scoreData.score !== null && scoreData.score.composite > 0
    ? `+${scoreData.score.composite.toFixed(2)}`
    : "+0.00";

  const messages = transcriptData?.messages ?? null;

  return (
    <div className="h-screen bg-white flex flex-col items-center font-sans relative overflow-hidden">
      {/* Header Bar */}
      <header className="flex items-center gap-4 w-full px-4 py-3 z-20">
        <Link
          href="/agents"
          className="p-2 rounded-full hover text-neutral-600 hover:text-neutral-800 transition-all duration-200 hover:scale-102 active:scale-98"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>

        <div className="flex-1 flex items-center gap-3 min-w-0">
          <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden">
            <AgentAvatar name={displayName} className="w-full h-full" />
          </div>
          <div className="flex flex-col items-start gap-0.5 min-w-0">
            <h1 className="text-sm font-medium tracking-tight text-neutral-900 truncate">
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
                <span className="flex items-center gap-1 bg-neutral-100 px-1.5 py-0.5 rounded-full text-neutral-500 text-[10px] font-medium">
                  <Lock className="w-2.5 h-2.5" strokeWidth={3} /> expired
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Live Score Chip */}
        <Link
          href={`/agents/${encodeURIComponent(id ?? "")}/score?name=${encodeURIComponent(displayName)}`}
          className="ml-auto shrink-0"
        >
          <BorderBeamButton
            beamSize="pulse-inner"
            theme="light"
            className="cursor-pointer rounded-full text-md font-mono tracking-tight font-medium text-neutral-700 bg-transparent hover:bg-neutral-50"
          >
            <span className="size-2 rounded-full bg-emerald-500"></span>
            score {scoreData?.score !== undefined && scoreData.score !== null ? scoreData.score.composite.toFixed(2) : "—"}
            {scoreData?.score !== undefined && scoreData.score !== null && scoreData.score.composite > 0 && (
              <span className="text-emerald-600 text-sm font-semibold ml-2">
                {scoreDelta}
              </span>
            )}
          </BorderBeamButton>
        </Link>
      </header>

      {/* Transcript */}
      <div className="relative w-full max-w-3xl flex flex-col gap-4 z-10 h-[80vh] p-4 mt-6">
        <ScrollArea className="flex-1 min-h-0">
          <div ref={scrollRef} className="flex flex-col gap-3 py-4 pr-3 min-h-full">
            {loadError ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-6 gap-3">
                <p className="text-sm font-medium text-rose-600">{loadError}</p>
                <Link
                  href="/agents"
                  className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
                >
                  back to your agents
                </Link>
              </div>
            ) : messages === null && !locked ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
                <div className="flex items-center gap-2 text-sm text-neutral-500">
                  <ThinkingOrb state="searching" size={64} theme="light" color="black" />
                  {/* loading transcript */}
                </div>
              </div>
            ) : locked ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-6 gap-3">
                <p className="text-sm font-medium text-neutral-700">
                  this agent's signing key expired after inactivity
                </p>
                <p className="text-xs text-neutral-500">
                  create a new agent to continue.
                </p>
                <Link
                  href="/agents/new"
                  className="text-xs font-medium text-neutral-900 hover:underline mt-1"
                >
                  create a new agent
                </Link>
              </div>
            ) : messages !== null && messages.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-6">
                <p className="text-sm font-medium text-neutral-700">
                  say hello to get started
                </p>
                <p className="text-xs text-neutral-500 mt-1">
                  your first message becomes this agent's first attestation
                </p>
              </div>
            ) : (
              messages !== null &&
              messages.map((msg, idx) =>
                msg.role === "agent" ? (
                  <div
                    key={idx}
                    className="flex flex-col items-start gap-1"
                  >
                    <div className="max-w-[85%] bg-neutral-100 rounded-2xl tracking-[-0.018em] px-4 py-3 text-sm text-neutral-800 whitespace-pre-wrap">
                      {msg.content}
                    </div>
                    {msg.toolsUsed.length > 0 && (
                      <div className="flex items-center gap-2 px-2">
                        <span className="flex items-center gap-1.5 text-xs text-neutral-500">
                          {toolLine(msg.toolsUsed)}
                        </span>
                      </div>
                    )}
                    {idx === messages.length - 1 && lastAttestationId !== null && (
                      <div className="flex items-center pl-2 pr-1">
                        <CopyButton
                          value={lastAttestationId}
                          label="Copy attestation id"
                          className="text-[10px]"
                        >
                          <span className="font-mono">
                            attestation: {lastAttestationId.slice(0, 6)}...
                            {lastAttestationId.slice(-4)}
                          </span>
                        </CopyButton>
                      </div>
                    )}
                  </div>
                ) : (
                  <div key={idx} className="flex justify-end">
                    <div className="max-w-[85%] bg-neutral-900 rounded-2xl tracking-[-0.016em] px-4 py-3 text-sm text-white whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                ),
              )
            )}

            {!locked && isGenerating && (
              <div className="flex items-start w-fit justify-center gap-1 bg-black/5 rounded-full px-4 py-2 text-sm text-neutral-800 tracking-tight">
                <ThinkingOrb state="searching" size={20} theme="light" />
                <h1 className="font-medium">thinking</h1>
              </div>
            )}

            {sendError && (
              <div className="flex justify-center px-2">
                <p className="text-xs text-rose-600 font-medium">{sendError}</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Composer */}
      <div className="flex flex-col items-center justify-center max-w-full gap-4 scale-92 mb-6">
        <div className="w-4xl bg-white rounded-3xl shadow-xs border border-neutral-200 p-5 min-h-35 flex flex-col relative z-20 transition-all duration-200">
          <textarea
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
            className="w-full flex-1 bg-transparent text-xl text-neutral-900 tracking-[-0.016em] placeholder-neutral-500 outline-none resize-none disabled:opacity-50"
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
                  disabled={!hasText}
                  className={`p-2 rounded-full transition-all duration-300 ease-out ${
                    hasText
                      ? "bg-neutral-900 text-white hover:scale-102 active:scale-98"
                      : "text-neutral-600 hover:bg-neutral-100"
                  }`}
                >
                  <ArrowUp className="size-5" />
                </button>
              ) : isGenerating ? (
                <button
                  disabled
                  className="p-3 flex items-center justify-center rounded-full bg-neutral-100 text-white transition-all duration-300 ease-out"
                >
                  <div className="size-4 rounded-sm bg-black" />
                </button>
              ) : (
                <button
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-neutral-100 text-neutral-500 cursor-not-allowed"
                  disabled
                >
                  locked
                </button>
              )}
            </div>
          </div>
        </div>

        <h1 className="text-sm font-medium tracking-tight text-center text-neutral-500">
          Artificial Intelligence is subject to make mistakes. Verify
          information before using it.
        </h1>
      </div>
    </div>
  );
}