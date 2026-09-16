import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Cadero — control your AI coding agents from your phone",
    template: "%s — Cadero",
  },
  description:
    "Run Claude Code, OpenCode, or Codex on your dev machine; watch the live terminal, send prompts, and approve or deny every action from your phone. Zero-knowledge relay, keys never leave your devices.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09090f",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-surface-0 text-ink">{children}</body>
    </html>
  );
}
