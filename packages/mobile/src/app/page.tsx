// packages/mobile/src/app/page.tsx
"use client";

import dynamic from "next/dynamic";

const CadenceApp = dynamic(() => import("./CadenceApp").then((m) => m.CadenceApp), {
  ssr: false,
  loading: () => <main className="p-6 text-slate-400">Loading…</main>,
});

export default function Home() {
  return <CadenceApp />;
}
