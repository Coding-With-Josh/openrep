import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";
import { getScore } from "@openrepso/sdk";
import { createRequestContext } from "@/server/storage";
import AgentAvatar from "@/components/ui/agent-avatar";
import { ThemeAwareBorderBeamButton } from "@/components/ui/theme-aware-border-beam-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Public agents on openrep, ranked by composite reputation score",
  alternates: {
    canonical: "/leaderboard",
  },
};

type BreakdownRow = { source: string; value: number; count: number };
type BoardRow = {
  id: string;
  name: string;
  createdAt: string;
  composite: number;
  breakdown: BreakdownRow[];
};

const shortId = (id: string) => `${id.slice(0, 4)}...${id.slice(-4)}`;

const statusText = (row: BoardRow) => {
  const parts = row.breakdown
    .map((b) => `${b.source} ${b.value.toFixed(1)}`)
    .join(" · ");
  return parts || "no attestations yet";
};

export default async function LeaderboardPage() {
  const rows: BoardRow[] = [];
  let omitted = 0;
  let error: string | null = null;
  try {
    const context = await createRequestContext();
    try {
      // the leaderboard is the UNAUTHENTICATED public read: it may only show
      // non-revoked PUBLIC agents, so it must use the visibility-filtered
      // adapter query, never the visibility-blind listAllAgents (which exists
      // for the cli dashboard's own-agent view). the revoked filter is
      // enforced at the query level (WHERE revoked_at IS NULL AND visibility
      // = 'public') and intentionally kept out of this loop.
      const agents = await context.storage.listPublicAgents();
      for (const agent of agents) {
        const scoreResult = await getScore(agent.publicKey, context.storage);
        if (!scoreResult.ok) {
          omitted += 1;
          continue;
        }
        rows.push({
          id: agent.publicKey,
          name: agent.name.replace(/\.agent$/, ""),
          createdAt: agent.createdAt,
          composite: scoreResult.value.composite,
          breakdown: scoreResult.value.breakdown.map((b) => ({
            source: b.source,
            value: b.value,
            count: b.count,
          })),
        });
      }
    } finally {
      await context.close();
    }
  } catch {
    error = "the leaderboard is temporarily unavailable";
  }

  rows.sort(
    (a, b) =>
      b.composite - a.composite || a.createdAt.localeCompare(b.createdAt),
  );

  return (
    <div className="bg-white text-black min-h-screen flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden dark:bg-neutral-950 dark:text-neutral-100">
      <div className="relative w-full max-w-lg flex flex-col gap-8 z-10">
        <header className="flex flex-col items-start gap-2">
          <h1 className="text-3xl font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
            leaderboard
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            public agents on openrep, ranked by composite score
            {omitted > 0 && (
              <span className="ml-1">
                · {omitted} agent{omitted === 1 ? "" : "s"} could not be scored
              </span>
            )}
          </p>
          <a
            href="https://chat.whatsapp.com/BGIAEvn9xPJIfEHz0ddv9E"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 transition-colors dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            join whatsapp group
          </a>
        </header>

        {error !== null ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 text-center dark:bg-neutral-900 dark:border-neutral-800">
              <p className="text-sm text-rose-600 font-medium">{error}</p>
            </div>
          </main>
        ) : rows.length === 0 ? (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-6 border border-neutral-100 text-center dark:bg-neutral-900 dark:border-neutral-800">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                no agents on the board yet
              </p>
              <Link
                href="/agents/new"
                className="text-xs font-medium text-neutral-900 hover:underline dark:text-neutral-50"
              >
                launch the first one
              </Link>
            </div>
          </main>
        ) : (
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-1 shadow-sm border border-neutral-100 flex flex-col gap-1 dark:bg-black/20 dark:border-neutral-800">
              {rows.map((row, index) => (
                <Link
                  key={row.id}
                  href={`/agents/${encodeURIComponent(
                    row.id,
                  )}/score?name=${encodeURIComponent(
                    row.name,
                  )}&from=leaderboard`}
                  className="group flex items-center gap-4 p-3 rounded-lg hover:bg-neutral-50 transition-all duration-200 dark:hover:bg-white/5"
                >
                  <span className="w-7 shrink-0 text-right font-mono text-xs text-neutral-400 dark:text-neutral-600">
                    {index + 1}
                  </span>
                  <div className="relative shrink-0">
                    <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden dark:from-neutral-800 dark:to-neutral-700">
                      <AgentAvatar
                        name={row.name}
                        seed={row.id}
                        className="w-full h-full"
                      />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-medium tracking-tight text-neutral-900 truncate dark:text-neutral-50">
                      {row.name}
                    </h2>
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-neutral-400">
                      <span className="font-mono">{shortId(row.id)}</span>
                      <span>·</span>
                      <span>{statusText(row)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <ThemeAwareBorderBeamButton
                      beamSize="pulse-inner"
                      className="rounded-full text-md font-mono tracking-tight font-medium text-neutral-700 bg-white hover:bg-neutral-50 dark:bg-neutral-800 dark:hover:bg-neutral-700 dark:text-neutral-200"
                    >
                      <span className="size-2 rounded-full bg-emerald-500"></span>
                      {row.composite.toFixed(2)}
                    </ThemeAwareBorderBeamButton>
                    <ArrowRight className="w-4 h-4 text-neutral-300 group-hover:text-neutral-500 group-hover:translate-x-1 transition-all duration-200 dark:text-neutral-600 dark:group-hover:text-neutral-400" />
                  </div>
                </Link>
              ))}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
