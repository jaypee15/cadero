"use client";

import dynamic from "next/dynamic";

const CaderoApp = dynamic(() => import("../CaderoApp").then((m) => m.CaderoApp), {
  ssr: false,
  loading: () => <main className="p-6 text-ink-muted">Loading…</main>,
});

export default function AppPage() {
  return <CaderoApp />;
}
