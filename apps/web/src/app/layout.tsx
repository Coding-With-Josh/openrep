import type { Metadata } from "next";
import { Geist_Mono, Google_Sans_Flex } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import {
  GeistPixelSquare,
  GeistPixelGrid,
  GeistPixelCircle,
  GeistPixelTriangle,
  GeistPixelLine,
} from "geist/font/pixel";
import localFont from "next/font/local";
import "./globals.css";
import Menu from "@/components/ui/menu-button";
import { SessionProvider } from "@/components/auth/session-provider";
import { ThemeProvider } from "next-themes";

export const metadata: Metadata = {
  title: "openrep - represent and repute",
  description: "Platform-agnostic reputation layer for AI agents",
};

// const sans = localFont({
//   src: "../../assets/font/Founders Grotesk Text/Founders Grotesk Text.ttf",
//   weight: "400",
//   display: "swap",
//   variable: "--font-founders-grotesk",
// });

const sans = Google_Sans_Flex({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-sans",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`
    ${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable}
    ${GeistPixelGrid.variable} ${GeistPixelCircle.variable} ${GeistPixelTriangle.variable}
    ${GeistPixelLine.variable} ${sans.variable} ${mono.variable}
    `}
    >
      <body className="font-sans">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <SessionProvider>{children}</SessionProvider>
        <Menu />
        </ThemeProvider>
      </body>
    </html>
  );
}
