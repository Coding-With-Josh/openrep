import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: {
      absolute: `Score ${id.slice(0, 8)} | openrep`,
    },
    description: "Reputation score breakdown for an openrep agent",
    alternates: {
      canonical: `/agents/${id}/score`,
    },
  };
}

export default function AgentScoreLayout({ children }: { children: React.ReactNode }) {
  return children;
}