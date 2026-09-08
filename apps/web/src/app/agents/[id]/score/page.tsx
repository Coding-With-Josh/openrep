"use client";

import { ArrowLeft, BadgeCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ThinkingOrb } from "thinking-orbs";
import { BorderBeamButton } from "@/components/ui/border-beam-button";
import { CopyButton } from "@/components/ui/copy-button";
import { MarkdownPlain } from "@/components/ui/markdown";
import AgentAvatar from "@/components/ui/agent-avatar";
import { useGuestSession } from "@/lib/session";
import { cachedFetch, useCachedData } from "@/lib/client-cache";

type ToolCall = { tool: string; input?: unknown; output?: unknown };
type AgentScore = {
  agentId: string;
  composite: number;
  breakdown: { source: string; value: number; count: number; lastUpdated: string }[];
  computedAt: string;
};
type AgentManifest = {
  name: string;
  publicKey: string;
  ownerPublicKey: string;
  memoryPointer: string | null;
  permissions: string[];
  createdAt: string;
  manifestVersion: number;
  signature: string;
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
type ScoreBody = {
  manifest: AgentManifest;
  manifestVerdict: { valid: boolean; reason: string };
  score: AgentScore;
  attestations: { attestation: Attestation; verdict: { valid: boolean; reason: string } }[];
  verifiedCount: number;
  totalCount: number;
};

const shortId = (id: string) => `${id.slice(0, 4)}...${id.slice(-4)}`;

const Page = () => {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // display name rides the query string from the chat/list pages so the
  // header renders instantly; the manifest fetch below is the deep-link
  // fallback and still drives the ledger and verification state.
  const searchParams = useSearchParams();
  const queryName = searchParams.get("name");
  const { ready: sessionReady, session: guest } = useGuestSession();

  // the score card is keyed by the server-confirmed session userId so a
  // reload paints the cached copy instantly and revalidates in the background.
  const cacheKey = sessionReady && guest !== null && id !== undefined
    ? `scorecard:${guest.userId}:${id}`
    : null;
  const {
    data: body,
    error: loadError,
    reload,
  } = useCachedData<ScoreBody>(
    cacheKey,
    () => cachedFetch<ScoreBody>(`/api/agents/${encodeURIComponent(id ?? "")}/score`),
  );

  const manifest = body?.manifest ?? null;
  const manifestValid = body?.manifestVerdict.valid ?? null;
  const score = body?.score ?? null;
  const attestations = body?.attestations ?? null;
  const verifiedCount = body?.verifiedCount ?? 0;
  const totalCount = body?.totalCount ?? 0;

  const name =
    queryName ??
    manifest?.name.replace(/\.agent$/, "") ??
    (id !== undefined ? shortId(id) : "agent");
  const composite = score?.composite ?? 0;
  const maxBreakdown = Math.max(
    1,
    ...(score?.breakdown.map((b) => b.value) ?? [1]),
  );

  return (
    <div className="bg-white text-black min-h-screen flex flex-col items-center px-4 py-6 relative overflow-hidden dark:bg-neutral-950 dark:text-neutral-100">
      <div className="relative w-full max-w-2xl flex flex-col gap-4 z-10">
        <header className="flex items-center gap-4 w-full py-3">
          <Link
            href={`/agents/${encodeURIComponent(id ?? "")}?name=${encodeURIComponent(name)}`}
            className="p-2 rounded-full text-neutral-600 hover:text-neutral-800 transition-all duration-200 hover:scale-102 active:scale-98 dark:text-neutral-400 dark:hover:text-neutral-50"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>

          <div className="flex-1 flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden dark:from-neutral-800 dark:to-neutral-700">
              <AgentAvatar name={name} seed={id ?? undefined} className="w-full h-full" />
            </div>
            <div className="flex flex-col items-start gap-0.5 min-w-0">
              <h1 className="text-sm font-medium tracking-tight text-neutral-900 truncate dark:text-neutral-50">
                {name}
              </h1>
              <div className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                <CopyButton value={id ?? ""} label="Copy agent id" className="text-xs">
                  <span className="font-mono">{shortId(id ?? "")}</span>
                </CopyButton>
              </div>
            </div>
          </div>

          <Link
            href={`/agents/${encodeURIComponent(id ?? "")}/score?name=${encodeURIComponent(name)}`}
            className="ml-auto shrink-0"
          >
            <BorderBeamButton
              beamSize="pulse-inner"
              className="rounded-full text-md font-mono tracking-tight font-medium text-neutral-700 bg-transparent hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <span
                className={`size-2 rounded-full ${
                  manifestValid === null
                    ? "bg-neutral-300 dark:bg-neutral-700"
                    : manifestValid
                    ? "bg-emerald-500"
                    : "bg-rose-500"
                }`}
              ></span>
              score {score !== null ? composite.toFixed(2) : "…"}
            </BorderBeamButton>
          </Link>
        </header>

        {loadError && body === null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-neutral-900/70 dark:ring-neutral-800/50">
            <div className="bg-white rounded-xl p-6 text-center border border-neutral-100 dark:bg-neutral-900 dark:border-neutral-800">
              <p className="text-sm text-rose-600 font-medium dark:text-rose-400">{loadError}</p>
              <button
                onClick={reload}
                className="mt-3 text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors dark:text-neutral-400 dark:hover:text-neutral-50"
              >
                retry
              </button>
            </div>
          </main>
        ) : body === null || manifest === null || score === null || attestations === null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-neutral-900/70 dark:ring-neutral-800/50">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 flex items-center justify-center gap-2.5 text-sm text-neutral-500 dark:bg-neutral-900 dark:border-neutral-800 dark:text-neutral-400">
              <ThinkingOrb state="searching" size={20} />
              loading score
            </div>
          </main>
        ) : (
          <main className="flex flex-col gap-4">
            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between dark:bg-neutral-900 dark:border-neutral-800">
              <div>
                <p className="text-md font-medium tracking-tight text-neutral-400 dark:text-neutral-500">
                  composite score
                </p>
                <p className="text-5xl font-medium tracking-[-0.03em] text-neutral-900 mt-1 dark:text-neutral-50">
                  {composite.toFixed(2)}
                </p>
              </div>
              <div className="flex flex-col items-start gap-1 sm:items-end">
                <div
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    manifestValid ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  <BadgeCheck className="w-4 h-4" />
                  {manifestValid
                    ? `verify passed: ${verifiedCount}/${totalCount}`
                    : "manifest verification failed"}
                </div>
                <CopyButton
                  value={`openrep verify --agent ${id ?? ""}`}
                  label="Copy verify command"
                  className="text-[10px]"
                >
                  <span className="font-mono dark:text-neutral-400">openrep verify --agent {shortId(id ?? "")}</span>
                </CopyButton>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-col gap-4 dark:bg-neutral-900 dark:border-neutral-800">
              <div className="flex items-baseline justify-between">
                <h2 className="text-md font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
                  score breakdown
                </h2>
                {score.computedAt && (
                  <p className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                    computed {score.computedAt.slice(0, 10)} {score.computedAt.slice(11, 19)}
                  </p>
                )}
              </div>
              {score.breakdown.length === 0 ? (
                <p className="text-sm text-neutral-400 dark:text-neutral-500">no attestations yet</p>
              ) : (
                score.breakdown.map((row) => (
                  <div key={row.source} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{row.source}</span>
                      <div className="flex items-baseline gap-3">
                        <span className="font-mono text-sm text-neutral-900 dark:text-neutral-50">
                          {row.value.toFixed(2)}
                        </span>
                        <span className="text-xs text-neutral-400 dark:text-neutral-500">
                          {row.count} attestation{row.count === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-neutral-900 transition-all duration-200 dark:bg-neutral-100"
                        style={{
                          width: `${Math.min(100, (row.value / maxBreakdown) * 100)}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-col gap-2 dark:bg-neutral-900 dark:border-neutral-800">
              <div className="flex items-baseline justify-between pb-1">
                <h2 className="text-md font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
                  attestation ledger
                </h2>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">newest first</p>
              </div>
              {attestations === null || attestations.length === 0 ? (
                <p className="text-sm text-neutral-400 py-3 text-center dark:text-neutral-500">
                  no attestations on this ledger yet
                </p>
              ) : (
                attestations.map(({ attestation, verdict }, idx) => (
                  <div
                    key={attestation.id}
                    className={`flex items-start gap-3 px-1 py-3 ${idx > 0 ? "border-t border-neutral-100 dark:border-neutral-800" : ""}`}
                  >
                    <div className="flex flex-col items-center gap-1 pt-0.5">
                      {verdict.valid ? (
                        <BadgeCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                      )}
                      <span
                        className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                          verdict.valid
                            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                            : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
                        }`}
                      >
                        {verdict.valid ? "verified" : "invalid"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium tracking-tight text-neutral-900 truncate dark:text-neutral-50">
                          {attestation.task}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
                          {attestation.timestamp.slice(11, 19)}
                        </span>
                      </div>
                      <div
                        className="text-xs text-neutral-500 mt-0.5 line-clamp-2 dark:text-neutral-400"
                        title={attestation.output}
                      >
                        <MarkdownPlain content={attestation.output} />
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            attestation.source === "native"
                              ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                              : "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400"
                          }`}
                        >
                          {attestation.source}
                        </span>
                        {attestation.toolsUsed.map((tool) => (
                          <span
                            key={tool.tool}
                            className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500"
                          >
                            {tool.tool}
                          </span>
                        ))}
                      </div>
                    </div>
                    <CopyButton
                      value={attestation.id}
                      label="Copy attestation id"
                      className="-mt-1 text-[10px]"
                    />
                  </div>
                ))
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
};

export default Page;