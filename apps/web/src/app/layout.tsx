import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenRep",
  description: "Platform-agnostic reputation layer for AI agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
