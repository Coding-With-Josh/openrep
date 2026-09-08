"use client";

import { Lock, Plus, ArrowRight, Check, CloudUpload } from "lucide-react";
import Link from "next/link";
import React, { useState } from "react";
import { useSession } from "next-auth/react";
import { AnimatePresence } from "motion/react";
import { ThinkingOrb } from "thinking-orbs";
import { BorderBeamButton } from "@/components/ui/border-beam-button";
import { SignInModal } from "@/components/auth/sign-in-modal";
import AgentAvatar from "@/components/ui/agent-avatar";
import { useGuestSession } from "@/lib/session";
import { cachedFetch, invalidateCachePrefix, useCachedData } from "@/lib/client-cache";
import { useTheme } from "next-themes";

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

type AgentRow = {
  manifest: AgentManifest;
  score: AgentScore;
  sessionStatus: "active" | "expired";
};

const shortId = (id: string) => `${id.slice(0, 4)}...${id.slice(-4)}`;

const agentStatusText = (row: AgentRow) => {
  const parts = row.score.breakdown
    .map((b) => `${b.source} ${b.value.toFixed(1)}`)
    .join(" · ");
  return parts || "no attestations yet";
};

const Page = () => {
  const { data: session, status } = useSession();
  const { theme } = useTheme();
  const {
    ready: sessionReady,
    error: sessionError,
    session: guest,
  } = useGuestSession();
  const [localEmail, setLocalEmail] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  // set synchronously by the modal's sign-out handler, before next-auth
  // client state settles, so the identity key flips on this very render and
  // the stale list is dropped instead of lingering until the session refetch.
  const [signedOut, setSignedOut] = useState(false);

  const isSignedIn = !signedOut && (status === "authenticated" || localEmail !== null);
  // the signedOut flag also gates the email shown in the account modal, so a
  // sign-out never leaves the signed-in branch visible while next-auth state
  // is still catching up.
  const signedInEmail = signedOut ? null : session?.user?.email ?? localEmail;

  // the cache key must mirror the identity the server will authorize for the
  // request: the account id when signed in, the guest id when not. the
  // signedOut flag makes a sign-out flip the key synchronously, and the
  // previous identity's cached rows become unreachable, so the list refetches
  // instead of re-painting them. while the account id is not yet known the
  // key is null, which skips the fetch rather than guessing an identity.
  const signedIn = !signedOut && (status === "authenticated" || localEmail !== null);
  const effectiveUserId = signedIn
    ? session?.user?.id && session.user.id.length > 0
      ? session.user.id
      : null
    : guest?.userId ?? null;
  const cacheKey =
    sessionReady && effectiveUserId !== null ? `agents:${effectiveUserId}` : null;
  const {
    data: agents,
    error: loadError,
    reload,
  } = useCachedData<AgentRow[]>(cacheKey, () =>
    cachedFetch<AgentRow[]>("/api/agents"),
  );

  const handleSignedIn = (email: string) => {
    setLocalEmail(email);
    setSignedOut(false);
  };

  const handleSignedOut = () => {
    setLocalEmail(null);
    setSignedOut(true);
    // purge every agents list cache so the next identity's list comes from
    // the server, never from a cache the previous identity wrote.
    invalidateCachePrefix("agents:");
  };

  return (
    <div className="bg-white text-black min-h-screen flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden dark:bg-neutral-950 dark:text-neutral-100">
      <div className="relative w-full max-w-lg flex flex-col gap-8 z-10">
        <header className="flex flex-col items-start gap-2">
          <h1 className="text-3xl font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
            your agents
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {sessionError ? (
              <span className="text-rose-600 dark:text-rose-400">
                {sessionError}
              </span>
            ) : sessionReady ? (
              <span>
                session ready ·{" "}
                {isSignedIn
                  ? "signed in, synced to your account"
                  : "saved locally on this device"}
              </span>
            ) : (
              <span>starting a session…</span>
            )}
          </p>

          <div className="mt-4 flex items-center gap-2">
            <Link href="/agents/new">
              <button className="flex items-center gap-2 bg-neutral-900 text-white text-sm font-medium px-4 py-2 rounded-full hover:scale-102 transition-all duration-200 active:scale-98 dark:bg-white dark:text-black">
                <Plus className="w-4 h-4" strokeWidth={2.5} />
                new agent
              </button>
            </Link>
            {isSignedIn ? (
              <button
                onClick={() => setShowSignIn(true)}
                className="flex items-center gap-2 bg-neutral-50 text-neutral-700 text-sm font-medium px-4 py-2 rounded-full hover:scale-102 transition-all duration-200 active:scale-98 dark:bg-white/10 dark:text-neutral-200"
              >
                <Check className="w-4 h-4" strokeWidth={2.5} />
                signed in
              </button>
            ) : (
              <button
                onClick={() => setShowSignIn(true)}
                className="flex items-center gap-2 bg-black/5 text-neutral-700 text-sm font-medium px-4 py-2 rounded-full hover:scale-102 transition-all duration-200 active:scale-98 dark:bg-white/10 dark:text-neutral-200"
              >
                <CloudUpload className="w-4 h-4" strokeWidth={2.5} />
                sign in to save
              </button>
            )}
          </div>
        </header>

        {loadError && agents === null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 text-center dark:bg-neutral-900 dark:border-neutral-800">
              <p className="text-sm text-rose-600 font-medium">{loadError}</p>
              <button
                onClick={reload}
                className="mt-3 text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                retry
              </button>
            </div>
          </main>
        ) : agents === null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 flex items-center justify-center gap-2.5 text-sm text-neutral-500 dark:bg-neutral-900 dark:border-neutral-800 dark:text-neutral-400">
              <ThinkingOrb state="searching" size={20} />
              searching your agents
            </div>
          </main>
        ) : agents.length === 0 ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 text-center flex flex-col items-center gap-2 dark:bg-neutral-900 dark:border-neutral-800">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                no agents yet
              </p>
              <Link
                href="/agents/new"
                className="text-xs font-medium text-neutral-900 hover:underline dark:text-neutral-50"
              >
                create your first one
              </Link>
            </div>
          </main>
        ) : (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-1 shadow-sm border border-neutral-100 flex flex-col gap-1 dark:bg-black/20 dark:border-neutral-800">
              {agents.map((row) => {
                const name = row.manifest.name.replace(/\.agent$/, "");
                const id = row.manifest.publicKey;
                return (
                  <Link
                    key={id}
                    href={`/agents/${encodeURIComponent(
                      id,
                    )}?name=${encodeURIComponent(name)}`}
                    className="group flex items-center gap-4 p-3 rounded-lg hover:bg-neutral-50 transition-all duration-200 dark:hover:bg-white/5"
                  >
                    <div className="relative shrink-0">
                      <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden dark:from-neutral-800 dark:to-neutral-700">
                        <AgentAvatar
                          name={name}
                          seed={id}
                          className="w-full h-full"
                        />
                      </div>
                      <span
                        className={`absolute bottom-0 right-0 size-3 border-2 border-white rounded-full ${
                          row.sessionStatus === "active"
                            ? "bg-emerald-400"
                            : "bg-neutral-300"
                        }`}
                      ></span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-sm font-medium tracking-tight text-neutral-900 truncate dark:text-neutral-50">
                        {name}
                      </h2>
                      <div className="flex items-center gap-1.5 mt-1 text-xs text-neutral-400">
                        <span className="font-mono">{shortId(id)}</span>
                        <span>·</span>
                        <span>{agentStatusText(row)}</span>
                        {row.sessionStatus === "expired" && (
                          <span className="ml-1 flex items-center gap-1 bg-neutral-100 px-1.5 py-0.5 rounded-full text-neutral-500 text-[10px] font-medium dark:bg-white/10 dark:text-neutral-400">
                            <Lock className="w-2.5 h-2.5" strokeWidth={3} />
                            expired
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Link
                        href={`/agents/${encodeURIComponent(
                          id,
                        )}/score?name=${encodeURIComponent(name)}`}
                        className="ml-auto shrink-0"
                      >
                        <BorderBeamButton
                          beamSize="pulse-inner"
                          theme={theme === "dark" ? "dark" : "light"}
                          className="rounded-full text-md font-mono tracking-tight font-medium text-neutral-700 bg-white hover:bg-neutral-50 dark:bg-neutral-800 dark:hover:bg-neutral-700 dark:text-neutral-200"
                        >
                          <span className="size-2 rounded-full bg-emerald-500"></span>
                          {row.score.composite.toFixed(2)}
                        </BorderBeamButton>
                      </Link>
                      <ArrowRight className="w-4 h-4 text-neutral-300 group-hover:text-neutral-500 group-hover:translate-x-1 transition-all duration-200 dark:text-neutral-600 dark:group-hover:text-neutral-400" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </main>
        )}
      </div>

      <AnimatePresence>
        {showSignIn && (
          <SignInModal
            signedInEmail={signedInEmail}
            onSignedIn={handleSignedIn}
            onSignedOut={handleSignedOut}
            onClose={() => setShowSignIn(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Page;
