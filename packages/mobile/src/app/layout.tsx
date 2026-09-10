import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Cadero", viewport: "width=device-width, initial-scale=1" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-900 text-slate-100 min-h-dvh">{children}</body>
    </html>
  );
}
