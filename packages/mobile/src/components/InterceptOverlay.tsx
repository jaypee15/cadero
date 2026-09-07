"use client";

import type { InterceptState } from "../state/sessionState.js";

export function InterceptOverlay({
  intercept,
  busy,
  onDecision,
}: {
  intercept: InterceptState;
  busy: boolean;
  onDecision(decision: "APPROVE" | "DENY"): void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/80 p-4 pb-8">
      <div className="w-full rounded-2xl bg-slate-800 p-5 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-400">
          Action required — {intercept.agent}
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-sm text-slate-100">
          {intercept.command}
        </pre>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("APPROVE")}
            className="rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("DENY")}
            className="rounded-xl bg-rose-600 px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
