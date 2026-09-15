// packages/mobile/src/app/CaderoApp.tsx
"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { importSessionKey, parsePairingPayload } from "@cadero/protocol";
import {
  GAP_MARKER,
  initialSessionState,
  reduceSession,
  type SessionAction,
  type SessionState,
} from "../state/sessionState";
import { decodeQrFromImageData } from "../pairing/scanQr";
import { createCameraScanner, type CameraScanner } from "../pairing/camera";
import { MobileSocket } from "../realtime/socket";
import { TerminalView, type TerminalApi } from "../components/TerminalView";
import { InterceptOverlay } from "../components/InterceptOverlay";
import { PromptInput } from "../components/PromptInput";
import { GapBanner } from "../components/GapBanner";
import { readOAuthTokenFromHash, loginUrl } from "./oauth";

export function CaderoApp() {
  const [state, dispatch] = useReducer(reduceSession, initialSessionState);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const socketRef = useRef<MobileSocket | null>(null);
  const termRef = useRef<TerminalApi | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<CameraScanner | undefined>(undefined);
  const startingRef = useRef(false);
  const [manualPayload, setManualPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const tokenRef = useRef<string | null>(null);

  // Latest-state mirror so socket callbacks can refuse to resurrect a closed
  // session (a late CONNECTED/EVENT/GAP after CLOSED must be ignored).
  const stateRef = useRef<SessionState>(state);
  stateRef.current = state;

  const dispatchIfOpen = useCallback((action: SessionAction) => {
    if (
      stateRef.current.phase === "closed" &&
      (action.type === "CONNECTED" || action.type === "EVENT" || action.type === "GAP")
    ) {
      return;
    }
    dispatch(action);
  }, []);

  // Stable identity: an inline arrow here would re-run TerminalView's
  // effect on every dispatch and tear the xterm instance down repeatedly.
  const handleTerminalReady = useCallback((api: TerminalApi) => {
    termRef.current = api;
  }, []);

  const startSession = useCallback(
    async (parsed: { relay: string; room: string; key: string }) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        scannerRef.current?.stop();
        scannerRef.current = undefined;
        const sessionKey = await importSessionKey(parsed.key);
        const token = tokenRef.current ?? readOAuthTokenFromHash();
        if (token) tokenRef.current = token;
        if (!token) {
          setError(
            `No session token. Open ${loginUrl(parsed.relay)} to sign in with GitHub first.`,
          );
          return;
        }
        dispatch({ type: "PAIR_SCANNED" });
        const socket = new MobileSocket({
          relayUrl: parsed.relay,
          roomId: parsed.room,
          token,
          sessionKey,
          onEvent: (event) => {
            if (event.event === "TERMINAL_DATA") {
              termRef.current?.write(event.payload.chunk);
            }
            dispatchIfOpen({ type: "EVENT", event });
          },
          onGap: () => {
            termRef.current?.write(GAP_MARKER);
            dispatchIfOpen({ type: "GAP" });
          },
          onClosed: (code, reason) => dispatch({ type: "CLOSED", code, reason }),
          onFatal: () =>
            dispatch({
              type: "FATAL",
              message: "Session key rejected — pairing mismatch. Rescan the QR.",
            }),
        });
        void socketRef.current?.close();
        socketRef.current = socket;
        await socket.connect();
        // Everything the agent emitted before this join is unrecoverable
        // (the relay replays nothing), so set the expectation in the feed.
        termRef.current?.write(
          "\n[connected to the live session — output from here on; earlier output is not replayed]\n",
        );
        dispatchIfOpen({ type: "CONNECTED" });
      } catch (err) {
        setError(err instanceof Error ? err.message : "pairing failed");
      } finally {
        startingRef.current = false;
      }
    },
    [dispatchIfOpen],
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
      const socket = socketRef.current;
      if (!socket || !state.intercept) return;
      setResolving(true);
      try {
        await socket.send({
          event: "RESOLVE_INTERCEPT",
          meta: { session_id: state.intercept.id.split(":")[0] ?? "sess" },
          payload: { decision, input_payload: null },
        });
        dispatch({ type: "RESOLVED" });
      } catch {
        dispatchIfOpen({ type: "GAP" });
      } finally {
        setResolving(false);
      }
    },
    [state.intercept, dispatchIfOpen],
  );

  const sendPrompt = useCallback(async (prompt: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      await socket.send({
        event: "EXECUTE_AGENT_PROMPT",
        meta: { session_id: "mobile" },
        payload: { prompt },
      });
    } catch {
      dispatchIfOpen({ type: "GAP" });
    }
  }, [dispatchIfOpen]);

  useEffect(() => {
    // Consume the OAuth callback's token (if any) once on mount so the
    // pairing screen can show the signed-in state; it stays memory-only
    // and is handed to the socket when pairing completes.
    const token = readOAuthTokenFromHash();
    if (token) {
      tokenRef.current = token;
      setSignedIn(true);
    }
  }, []);

  useEffect(() => {
    return () => {
      void socketRef.current?.close();
      scannerRef.current?.stop();
      scannerRef.current = undefined;
    };
  }, []);
  if (state.phase === "closed") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">Session closed</p>
        <p className="text-sm text-slate-400">{state.closedReason ?? "The session ended."}</p>
      </main>
    );
  }

  if (state.phase === "need-pairing") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-xl font-semibold">Pair with your desktop</h1>
        <p className="text-sm text-slate-400">
          1. Sign in with GitHub (once per device) · 2. Scan the QR
        </p>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        {signedIn ? (
          <p className="text-sm font-medium text-emerald-400">Signed in with GitHub ✓</p>
        ) : (
          <a
            href={`${window.location.origin}/v1/oauth/login`}
            className="rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white"
          >
            Sign in with GitHub
          </a>
        )}
        <video ref={videoRef} className="h-64 w-64 rounded-2xl bg-slate-800" muted playsInline />
        <button
          type="button"
          onClick={() => void scanViaCamera()}
          disabled={scanning}
          className="rounded-xl bg-sky-600 px-6 py-3 font-semibold text-white disabled:opacity-40"
        >
          {scanning ? "Scanning…" : "Scan QR code"}
        </button>
        <div className="w-full max-w-sm">
          <textarea
            value={manualPayload}
            onChange={(event) => setManualPayload(event.target.value)}
            placeholder="…or paste the pairing payload"
            className="h-20 w-full rounded-xl bg-slate-950 p-3 font-mono text-xs text-slate-300"
          />
          <button
            type="button"
            onClick={importManual}
            className="mt-2 w-full rounded-xl bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100"
          >
            Pair manually
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col bg-slate-900">
      <GapBanner visible={state.gapped} />
      <div className="relative min-h-0 flex-1">
        <TerminalView onReady={handleTerminalReady} />
        {state.intercept && (
          <InterceptOverlay
            intercept={state.intercept}
            busy={resolving}
            onDecision={(d) => void decide(d)}
          />
        )}
      </div>
      <PromptInput
        disabled={state.intercept !== null || state.phase !== "live"}
        onSend={(p) => void sendPrompt(p)}
      />
    </main>
  );
}
