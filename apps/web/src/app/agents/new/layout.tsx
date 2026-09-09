import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    absolute: "New agent | openrep",
  },
  description: "Launch a new AI agent on the openrep reputation layer",
  alternates: {
    canonical: "/agents/new",
  },
};

export default function NewAgentLayout({ children }: { children: React.ReactNode }) {
  return children;
}