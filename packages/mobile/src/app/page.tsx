import Link from "next/link";
import { HashForward } from "./HashForward";
import { Wordmark } from "../components/Wordmark";

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-1 p-6">
      <span className="font-mono text-sm text-accent">{n}</span>
      <h3 className="mt-3 font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <HashForward />
      <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6">
        <header className="flex items-center justify-between py-6">
          <Wordmark />
          <Link
            href="/app"
            className="rounded-xl bg-surface-3 px-4 py-2 text-sm font-medium text-ink ring-1 ring-line transition hover:bg-surface-2"
          >
            Open the app
          </Link>
        </header>

        <section className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Your AI agents,
            <span className="text-accent"> in your pocket</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
            Run Claude Code, OpenCode, or Codex on your dev machine — then watch
            the live terminal, send prompts, and approve or deny every action
            from your phone.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/app"
              className="rounded-xl bg-accent-dim px-6 py-3 font-semibold text-surface-0 transition hover:bg-accent"
            >
              Get started
            </Link>
            <a
              href="https://github.com/jaypee15/cadence"
              className="inline-flex items-center gap-2 rounded-xl bg-surface-3 px-6 py-3 font-medium text-ink ring-1 ring-line transition hover:bg-surface-2"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 text-amber-400" aria-hidden="true">
                <path d="M8 .8a.8.8 0 0 1 .74.5l1.62 3.93 4.25.34a.8.8 0 0 1 .46 1.4l-3.23 2.77.98 4.15a.8.8 0 0 1-1.2.87L8 11.87l-3.48 2.07a.8.8 0 0 1-1.2-.87l.98-4.15L1.3 6.29a.8.8 0 0 1 .46-1.41l4.25-.34L7.5.98A.8.8 0 0 1 8 .8Z" />
              </svg>
              Star on GitHub
            </a>
          </div>
          <div className="pointer-events-none mt-14 w-full max-w-md rounded-t-3xl border border-b-0 border-line bg-surface-1 p-4 text-left shadow-2xl">
            <div className="rounded-xl bg-surface-0 p-4 font-mono text-xs leading-relaxed text-ink-muted">
              <p>
                <span className="text-ink-faint">$</span>{" "}
                <span className="text-ink">cadero start --agent claude</span>
              </p>
              <p className="mt-2 text-accent">▐ claude · cadence</p>
              <p className="mt-1">▸ wants to run: rm -rf ./dist</p>
              <p className="mt-1 flex items-center gap-2">
                <span className="rounded-md bg-accent-dim/20 px-2 py-0.5 text-accent">
                  Approve
                </span>
                <span className="rounded-md bg-surface-3 px-2 py-0.5">Deny</span>
                <span className="text-ink-faint">— from your phone</span>
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 pb-16 sm:grid-cols-3">
          <Step
            n="01"
            title="Start a session"
            body="cadero start spawns your agent in its own room and prints a QR. Run one per project — the phone keeps them all connected."
          />
          <Step
            n="02"
            title="Scan the QR with your phone"
            body="Open the PWA on your phone and scan the terminal QR with its built-in scanner. Keys are shared directly between your devices — the relay only ever sees ciphertext."
          />
          <Step
            n="03"
            title="Stay in control"
            body="Live terminal, prompts, and an approve/deny dialog for every command the agent wants to run. Miss nothing on the go."
          />
        </section>

        <section className="rounded-2xl border border-line bg-surface-1 p-6 text-sm leading-relaxed text-ink-muted">
          <h2 className="font-semibold text-ink">Security model</h2>
          <p className="mt-2">
            Zero-knowledge relay: a per-session AES-GCM-256 key is generated on
            your machine and handed to your phone exclusively via the terminal
            QR — the relay sees only room ids and ciphertext. The daemon never
            executes shell commands from the network: your phone sends
            high-level intents, the daemon validates them and feeds your
            agent's stdin.
          </p>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-6 text-xs text-ink-faint">
          <span>© 2026 Cadero</span>
          <a
            href="https://github.com/jaypee15/cadence"
            className="inline-flex items-center gap-1.5 transition hover:text-ink"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 text-amber-400" aria-hidden="true">
              <path d="M8 .8a.8.8 0 0 1 .74.5l1.62 3.93 4.25.34a.8.8 0 0 1 .46 1.4l-3.23 2.77.98 4.15a.8.8 0 0 1-1.2.87L8 11.87l-3.48 2.07a.8.8 0 0 1-1.2-.87l.98-4.15L1.3 6.29a.8.8 0 0 1 .46-1.41l4.25-.34L7.5.98A.8.8 0 0 1 8 .8Z" />
            </svg>
            Star the repo
          </a>
          <span className="font-mono">MIT License</span>
        </footer>
      </main>
    </>
  );
}
