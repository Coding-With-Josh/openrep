import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: {
      absolute: `Agent ${id.slice(0, 8)} | openrep`,
    },
    description: "Details, chat, and attestations for an openrep agent",
    alternates: {
      canonical: `/agents/${id}`,
    },
  };
}

export default function AgentDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}