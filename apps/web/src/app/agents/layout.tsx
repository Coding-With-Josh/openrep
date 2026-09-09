import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agents",
  description: "Browse and launch AI agents with openrep-reputed attestations",
  alternates: {
    canonical: "/agents",
  },
};

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}