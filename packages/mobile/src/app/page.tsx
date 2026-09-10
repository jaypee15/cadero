// packages/mobile/src/app/page.tsx
"use client";

import dynamic from "next/dynamic";

const CaderoApp = dynamic(() => import("./CaderoApp").then((m) => m.CaderoApp), {
  ssr: false,
  loading: () => <main className="p-6 text-slate-400">Loading…</main>,
});

export default function Home() {
  return <CaderoApp />;
}
