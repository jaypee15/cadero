// packages/mobile/src/app/CaderoApp.tsx
"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parsePairingPayload } from "@cadero/protocol";
import { decodeQrFromImageData } from "../pairing/scanQr";
import { createCameraScanner, type CameraScanner } from "../pairing/camera";
import {
  defaultSessionStore,
  type SessionStore,
} from "../state/sessionStore";
import { TerminalView, type TerminalApi } from "../components/TerminalView";
import { InterceptOverlay } from "../components/InterceptOverlay";
import { PromptInput } from "../components/PromptInput";
import { GapBanner } from "../components/GapBanner";
import { Wordmark } from "../components/Wordmark";
import {
  clearPairingStash,
  readOAuthTokenFromHash,
  readPairingFromHash,
  readPairingStash,
  readStoredToken,
  storeToken,
  loginUrl,
} from "./oauth";

export function CaderoApp({ store = defaultSessionStore }: { store?: SessionStore } = {}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const active =
    snapshot.sessions.find((s) => s.roomId === snapshot.activeId) ?? null;
  const activePhase = active?.phase ?? "need-pairing";
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const termRef = useRef<TerminalApi | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<CameraScanner | undefined>(undefined);
  const startingRef = useRef(false);
  const [manualPayload, setManualPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const tokenRef = useRef<string | null>(null);

  // Refill the shared terminal from the active room's buffer. Runs on every
  // active-session change and again once the xterm instance is ready (the
  // dynamic import below mounts asynchronously).
  const refillRef = useRef<() => void>(() => {});
  refillRef.current = () => {
    const api = termRef.current;
    if (!api || !active) return;
    api.clear();
    api.write(active.terminal);
  };
  useEffect(() => {
    refillRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.activeId]);

  const handleTerminalReady = useCallback(
    (api: TerminalApi) => {
      termRef.current = api;
      store.setSink((chunk) => api.write(chunk));
      refillRef.current();
    },
    [store],
  );

  // Latest phone terminal dimensions, sent to each room on join/gap and
  // whenever the viewport refits (rotation, keyboard). Trailing-debounced.
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleTerminalResize = useCallback(
    (dims: { cols: number; rows: number }) => {
      store.setTermDims(dims);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        void store.sendResize().catch(() => {
          /* resize frames dropped during a reconnect gap are harmless */
        });
      }, 300);
    },
    [store],
  );

  const startSession = useCallback(
    async (parsed: { relay: string; room: string; key: string }) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        scannerRef.current?.stop();
        scannerRef.current = undefined;
        const token = tokenRef.current ?? readOAuthTokenFromHash() ?? readStoredToken();
        if (token) {
          tokenRef.current = token;
          storeToken(token);
          setSignedIn(true);
        }
        if (!token) {
          setError(
            `No session token. Open ${loginUrl(parsed.relay)} to sign in with GitHub first.`,
          );
          return;
        }
        await store.addSession(parsed, token);
        setError(null);
        setPairingOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "pairing failed");
      } finally {
        startingRef.current = false;
      }
    },
    [store],
  );

  const scanViaCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setScanning(true);
    const scanner = createCameraScanner(video);
    scannerRef.current = scanner;
    try {
      await scanner.start((imageData) => {
        try {
          const parsed = decodeQrFromImageData(imageData);
          scanner.stop();
          setScanning(false);
          void startSession(parsed);
        } catch {
          /* frame without a readable QR: keep scanning */
        }
      });
    } catch {
      setScanning(false);
      setError("camera unavailable");
    }
  }, [startSession]);

  const importManual = useCallback(() => {
    try {
      void startSession(parsePairingPayload(manualPayload.trim()));
    } catch {
      setError("invalid pairing payload");
    }
  }, [manualPayload, startSession]);

  const decide = useCallback(
    async (decision: "APPROVE" | "DENY") => {
      if (!active?.intercept) return;
      setResolving(true);
      try {
        await store.resolve(decision);
      } finally {
        setResolving(false);
      }
    },
    [active, store],
  );

  const sendPrompt = useCallback(
    async (prompt: string) => {
      await store.sendPrompt(prompt);
    },
    [store],
  );

  useEffect(() => {
    // Consume the OAuth callback's token (if any) once on mount so the
    // pairing screen can show the signed-in state, then reconnect any
    // previously paired sessions.
    readPairingFromHash();
    const token = readOAuthTokenFromHash() ?? readStoredToken();
    if (token) {
      tokenRef.current = token;
      storeToken(token);
      setSignedIn(true);
    }
    // Deep-link pairing: a #pair= payload stashed on load auto-imports as
    // soon as a token is available (natively scanned QR → sign-in → live).
    const stashed = readPairingStash();
    if (stashed && tokenRef.current) {
      clearPairingStash();
      try {
        void startSession(parsePairingPayload(stashed));
      } catch {
        setError("invalid pairing payload in deep link");
      }
      return;
    }
    void store.restore();
  }, [store, startSession]);

  useEffect(() => {
    return () => {
      scannerRef.current?.stop();
      scannerRef.current = undefined;
    };
  }, []);
  // The terminal layer is ALWAYS mounted: the phone's terminal dimensions
  // must be known before any socket joins, so the resize is the first frame
  // the CLI sees and the agent never draws at the wrong width. While pairing
  // or closed it is invisible but still sized to the real viewport.
  const live = activePhase === "live" || activePhase === "connecting";
  const showPairing = snapshot.sessions.length === 0 || pairingOpen;
  const debug = new URLSearchParams(window.location.search).has("debug");

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const pairingPanel = (
    <main className="fixed inset-0 z-30 flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface-0 px-6 py-10">
      <div className="flex w-full max-w-sm items-center justify-between">
        <Wordmark />
        {snapshot.sessions.length > 0 && (
          <button
            type="button"
            onClick={() => setPairingOpen(false)}
            className="rounded-xl bg-surface-3 px-3 py-2 text-xs font-medium text-ink-muted ring-1 ring-line"
          >
            Back to sessions
          </button>
        )}
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface-1 p-6">
        <h1 className="text-lg font-semibold text-ink">Pair with your desktop</h1>
        <ol className="mt-4 space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <span
              className={
                "grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-xs " +
                (signedIn ? "bg-accent-dim text-surface-0" : "bg-surface-3 text-ink-muted")
              }
            >
              {signedIn ? "✓" : "1"}
            </span>
            {signedIn ? (
              <span className="text-sm font-medium text-accent">Signed in with GitHub</span>
            ) : (
              <a
                href={`${window.location.origin}/v1/oauth/login`}
                className="text-sm font-medium text-ink underline decoration-line underline-offset-4"
              >
                Sign in with GitHub
              </a>
            )}
          </li>
          <li className="flex items-start gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-3 font-mono text-xs text-ink-muted">
              2
            </span>
            <span className="pt-1 text-sm text-ink-muted">Scan the QR from the terminal</span>
          </li>
        </ol>
        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

        <div className="mt-5 overflow-hidden rounded-2xl bg-surface-3 ring-1 ring-line">
          <video ref={videoRef} className="h-64 w-full bg-surface-0" muted playsInline />
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-ink-faint">
              {scanning ? "Looking for a QR…" : "Camera ready"}
            </span>
            <button
              type="button"
              onClick={() => void scanViaCamera()}
              disabled={scanning}
              className="rounded-xl bg-accent-dim px-4 py-2 text-sm font-semibold text-surface-0 disabled:opacity-40"
            >
              {scanning ? "Scanning…" : "Scan QR code"}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="mt-4 text-xs font-medium text-ink-faint underline underline-offset-4"
        >
          {advancedOpen ? "Hide" : "Advanced"} — paste the pairing payload
        </button>
        {advancedOpen && (
          <div className="mt-2">
            <textarea
              value={manualPayload}
              onChange={(event) => setManualPayload(event.target.value)}
              placeholder="paste the pairing payload (cadero://p?r=…&m=…&k=…)"
              className="h-20 w-full rounded-xl bg-surface-0 p-3 font-mono text-xs text-ink-muted ring-1 ring-line"
            />
            <button
              type="button"
              onClick={importManual}
              className="mt-2 w-full rounded-xl bg-surface-3 px-4 py-2 text-sm font-medium text-ink ring-1 ring-line"
            >
              Pair manually
            </button>
          </div>
        )}
      </div>
    </main>
  );

  return (
    <>
      <div
        className={
          live
            ? "flex h-dvh flex-col bg-surface-0"
            : "fixed inset-0 opacity-0 pointer-events-none"
        }
      >
        {snapshot.sessions.length > 0 && (
          <div
            role="tablist"
            className="flex items-center gap-1 overflow-x-auto border-b border-line bg-surface-1 px-2 py-1.5"
          >
            {snapshot.sessions.map((s) => (
              <div key={s.roomId} className="flex items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={s.roomId === snapshot.activeId}
                  data-testid={`tab-${s.roomId}`}
                  onClick={() => store.setActive(s.roomId)}
                  className={
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition " +
                    (s.roomId === snapshot.activeId
                      ? "bg-surface-3 text-ink ring-1 ring-line"
                      : "text-ink-faint")
                  }
                >
                  <span className="whitespace-nowrap">{s.label}</span>
                  {s.intercept && (
                    <span
                      data-pending="true"
                      aria-label="pending approval"
                      className="inline-block h-2 w-2 rounded-full bg-amber-400"
                    />
                  )}
                  {s.phase === "closed" && (
                    <span className="text-[10px] text-ink-faint">ended</span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${s.label}`}
                  onClick={() => store.removeSession(s.roomId)}
                  className="ml-0.5 rounded-lg px-1.5 py-1.5 text-xs text-ink-faint"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              aria-label="Pair a new session"
              onClick={() => setPairingOpen(true)}
              className="ml-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold text-accent"
            >
              + Pair
            </button>
          </div>
        )}
        <GapBanner visible={active?.gapped ?? false} />
        <div className="relative min-h-0 flex-1">
          <TerminalView onReady={handleTerminalReady} onResize={handleTerminalResize} />
          {activePhase === "closed" && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-surface-0 p-6 text-center">
              <p className="text-lg font-semibold text-ink">Session closed</p>
              <p className="max-w-sm text-sm text-ink-muted">
                {active?.closedReason ?? "The session ended."}
              </p>
              <button
                type="button"
                onClick={() => setPairingOpen(true)}
                className="rounded-xl bg-surface-3 px-5 py-2.5 text-sm font-semibold text-ink ring-1 ring-line"
              >
                Pair another session
              </button>
            </div>
          )}
          {active?.intercept && (
            <InterceptOverlay
              intercept={active.intercept}
              busy={resolving}
              onDecision={(d) => void decide(d)}
            />
          )}
        </div>
        <PromptInput
          disabled={active?.intercept !== null || activePhase !== "live"}
          onSend={(p) => void sendPrompt(p)}
        />
        {debug && (
          <div
            data-debug-status="true"
            className="border-t border-line bg-surface-1 px-3 py-1 text-center font-mono text-[10px] text-ink-faint"
          >
            frames: {active?.chunkCount ?? 0} · phase: {activePhase} · gapped:{" "}
            {String(active?.gapped ?? false)}
            {active?.intercept ? " · intercept pending" : ""}
          </div>
        )}
      </div>
      {showPairing && pairingPanel}
    </>
  );
}
