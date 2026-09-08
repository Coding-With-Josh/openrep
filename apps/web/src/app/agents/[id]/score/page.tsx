"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, BadgeCheck, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { BorderBeamButton } from "@/components/ui/border-beam-button";
import { CopyButton } from "@/components/ui/copy-button";
import AgentAvatar from "@/components/ui/agent-avatar";
import { useGuestSession } from "@/lib/session";

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
type ApiError = { error?: { code?: string; message?: string } };

const shortId = (id: string) => `${id.slice(0, 4)}...${id.slice(-4)}`;

const Page = () => {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // display name rides the query string from the chat/list pages so the
  // header renders instantly; the manifest fetch below is the deep-link
  // fallback and still drives the ledger and verification state.
  const searchParams = useSearchParams();
  const queryName = searchParams.get("name");
  const { ready: sessionReady } = useGuestSession();

  const [manifest, setManifest] = useState<AgentManifest | null>(null);
  const [manifestValid, setManifestValid] = useState<boolean | null>(null);
  const [score, setScore] = useState<AgentScore | null>(null);
  const [attestations, setAttestations] = useState<
    { attestation: Attestation; verdict: { valid: boolean; reason: string } }[] | null
  >(null);
  const [verifiedCount, setVerifiedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionReady || id === undefined) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(id)}/score`);
        const body: {
          manifest: AgentManifest;
          manifestVerdict: { valid: boolean; reason: string };
          score: AgentScore;
          attestations: { attestation: Attestation; verdict: { valid: boolean; reason: string } }[];
          verifiedCount: number;
          totalCount: number;
        } | ApiError = await res.json();
        if (!res.ok) {
          if (!cancelled) {
            setLoadError(
              (body as ApiError).error?.message ?? "could not load this score",
            );
          }
          return;
        }
        const ok = body as {
          manifest: AgentManifest;
          manifestVerdict: { valid: boolean; reason: string };
          score: AgentScore;
          attestations: { attestation: Attestation; verdict: { valid: boolean; reason: string } }[];
          verifiedCount: number;
          totalCount: number;
        };
        if (!cancelled) {
          setManifest(ok.manifest);
          setManifestValid(ok.manifestVerdict.valid);
          setScore(ok.score);
          setAttestations(ok.attestations);
          setVerifiedCount(ok.verifiedCount);
          setTotalCount(ok.totalCount);
        }
      } catch {
        if (!cancelled) setLoadError("could not reach the server, check your connection");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionReady, id]);

  const name =
    queryName ??
    manifest?.name.replace(/\.agent$/, "") ??
    (id !== undefined ? shortId(id) : "agent");
  const composite = score?.composite ?? 0;
  const maxBreakdown = Math.max(
    1,
    ...(score?.breakdown.map((b) => b.value) ?? [1]),
  );

  const retry = useCallback(() => {
    setLoadError(null);
    setManifest(null);
    setScore(null);
    setAttestations(null);
  }, []);

  return (
    <div className="bg-white text-black min-h-screen flex flex-col items-center px-4 py-6 relative overflow-hidden">
      <div className="relative w-full max-w-2xl flex flex-col gap-4 z-10">
        <header className="flex items-center gap-4 w-full py-3">
          <Link
            href={`/agents/${encodeURIComponent(id ?? "")}?name=${encodeURIComponent(name)}`}
            className="p-2 rounded-full text-neutral-600 hover:text-neutral-800 transition-all duration-200 hover:scale-102 active:scale-98"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>

          <div className="flex-1 flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden">
              <AgentAvatar name={name} className="w-full h-full" />
            </div>
            <div className="flex flex-col items-start gap-0.5 min-w-0">
              <h1 className="text-sm font-medium tracking-tight text-neutral-900 truncate">
                {name}
              </h1>
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
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
              theme="light"
              className="rounded-full text-md font-mono tracking-tight font-medium text-neutral-700 bg-transparent hover:bg-neutral-50"
            >
              <span
                className={`size-2 rounded-full ${
                  manifestValid === null
                    ? "bg-neutral-300"
                    : manifestValid
                    ? "bg-emerald-500"
                    : "bg-rose-500"
                }`}
              ></span>
              score {score !== null ? composite.toFixed(2) : "—"}
            </BorderBeamButton>
          </Link>
        </header>

        {loadError ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50">
            <div className="bg-white rounded-xl p-6 text-center border border-neutral-100">
              <p className="text-sm text-rose-600 font-medium">{loadError}</p>
              <button
                onClick={retry}
                className="mt-3 text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                retry
              </button>
            </div>
          </main>
        ) : manifest === null || score === null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50">
            <div className="bg-white rounded-xl p-6 text-center text-sm text-neutral-500 border border-neutral-100">
              loading…
            </div>
          </main>
        ) : (
          <main className="flex flex-col gap-4">
            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-md font-medium tracking-tight text-neutral-400">
                  composite score
                </p>
                <p className="text-5xl font-medium tracking-[-0.03em] text-neutral-900 mt-1">
                  {composite.toFixed(2)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    manifestValid ? "text-emerald-700" : "text-rose-600"
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
                  <span className="font-mono">openrep verify --agent {shortId(id ?? "")}</span>
                </CopyButton>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-col gap-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-md font-medium tracking-tight text-neutral-900">
                  score breakdown
                </h2>
                {score.computedAt && (
                  <p className="font-mono text-[10px] text-neutral-400">
                    computed {score.computedAt.slice(0, 10)} {score.computedAt.slice(11, 19)}
                  </p>
                )}
              </div>
              {score.breakdown.length === 0 ? (
                <p className="text-sm text-neutral-400">no attestations yet</p>
              ) : (
                score.breakdown.map((row) => (
                  <div key={row.source} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-neutral-700">{row.source}</span>
                      <div className="flex items-baseline gap-3">
                        <span className="font-mono text-sm text-neutral-900">
                          {row.value.toFixed(2)}
                        </span>
                        <span className="text-xs text-neutral-400">
                          {row.count} attestation{row.count === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-neutral-100">
                      <div
                        className="h-full rounded-full bg-neutral-900 transition-all duration-200"
                        style={{
                          width: `${Math.min(100, (row.value / maxBreakdown) * 100)}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-col gap-2">
              <div className="flex items-baseline justify-between pb-1">
                <h2 className="text-md font-medium tracking-tight text-neutral-900">
                  attestation ledger
                </h2>
                <p className="text-xs text-neutral-400">newest first</p>
              </div>
              {attestations === null || attestations.length === 0 ? (
                <p className="text-sm text-neutral-400 py-3 text-center">
                  no attestations on this ledger yet
                </p>
              ) : (
                attestations.map(({ attestation, verdict }, idx) => (
                  <div
                    key={attestation.id}
                    className={`flex items-start gap-3 px-1 py-3 ${idx > 0 ? "border-t border-neutral-100" : ""}`}
                  >
                    <div className="flex flex-col items-center gap-1 pt-0.5">
                      {verdict.valid ? (
                        <BadgeCheck className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-rose-600" />
                      )}
                      <span
                        className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                          verdict.valid
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-rose-50 text-rose-700"
                        }`}
                      >
                        {verdict.valid ? "verified" : "invalid"}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium tracking-tight text-neutral-900 truncate">
                          {attestation.task}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-neutral-400">
                          {attestation.timestamp.slice(11, 19)}
                        </span>
                      </div>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        {attestation.output}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span
                          className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                            attestation.source === "native"
                              ? "bg-neutral-100 text-neutral-600"
                              : "bg-blue-50 text-blue-700"
                          }`}
                        >
                          {attestation.source}
                        </span>
                        {attestation.toolsUsed.map((tool) => (
                          <span
                            key={tool.tool}
                            className="font-mono text-[10px] text-neutral-400"
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