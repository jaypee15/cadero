// packages/mobile/src/state/sessionStore.ts
import { importSessionKey, type WireEvent } from "@cadero/protocol";
import { MobileSocket, type MobileSocketOptions } from "../realtime/socket";
import { readStoredToken } from "../app/oauth";
import {
  GAP_MARKER,
  initialSessionState,
  reduceSession,
  type InterceptState,
  type SessionPhase,
  type SessionState,
} from "./sessionState";

export interface SocketLike {
  connect(): Promise<void>;
  send(event: WireEvent): Promise<void>;
  close(): Promise<void>;
}

export type SocketFactory = (opts: MobileSocketOptions) => SocketLike;

export interface PairingInput {
  relay: string;
  room: string;
  key: string;
}

export interface SessionView {
  roomId: string;
  relayUrl: string;
  label: string;
  phase: SessionPhase;
  intercept: InterceptState | null;
  gapped: boolean;
  chunkCount: number;
  closedReason?: string;
  terminal: string;
}

export interface SessionSnapshot {
  sessions: readonly SessionView[];
  activeId: string | null;
}

export interface SessionStoreOptions {
  socketFactory?: SocketFactory;
  storage?: Pick<Storage, "getItem" | "setItem">;
  terminalLimit?: number;
  persistTerminalLimit?: number;
}

interface PersistedSession {
  roomId: string;
  relayUrl: string;
  key: string;
  terminal: string;
  phase: SessionPhase;
  closedReason?: string;
}

interface SessionRuntime {
  roomId: string;
  relayUrl: string;
  label: string;
  key: string;
  state: SessionState;
  terminal: string;
  socket: SocketLike | null;
}

export const SESSIONS_STORAGE_KEY = "cadero_sessions_v1";

const DEFAULT_TERMINAL_LIMIT = 256_000;
const DEFAULT_PERSIST_TERMINAL_LIMIT = 32_000;

export interface SessionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionSnapshot;
  restore(): Promise<void>;
  addSession(parsed: PairingInput, token: string): Promise<void>;
  removeSession(roomId: string): void;
  setActive(roomId: string): void;
  setTermDims(dims: { cols: number; rows: number } | undefined): void;
  setSink(write: ((chunk: string) => void) | null): void;
  sendResize(): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  resolve(decision: "APPROVE" | "DENY"): Promise<void>;
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const socketFactory = options.socketFactory ?? ((opts) => new MobileSocket(opts));
  const terminalLimit = options.terminalLimit ?? DEFAULT_TERMINAL_LIMIT;
  const persistTerminalLimit = options.persistTerminalLimit ?? DEFAULT_PERSIST_TERMINAL_LIMIT;

  const runtimes = new Map<string, SessionRuntime>();
  const listeners = new Set<() => void>();
  let activeId: string | null = null;
  let snapshotCache: SessionSnapshot = { sessions: [], activeId: null };
  let restored = false;
  let termDims: { cols: number; rows: number } | undefined;
  let hasPersisted = false;
  let sink: ((chunk: string) => void) | null = null;

  function emit(chunk: string): void {
    // Called only for the ACTIVE session's frames, synchronously in the
    // socket callback, so the terminal stays ordered with the buffer.
    if (sink) sink(chunk);
  }

  function isActive(roomId: string): boolean {
    return activeId === roomId && sink !== null;
  }

  function storage(): Pick<Storage, "getItem" | "setItem"> | null {
    if (options.storage) return options.storage;
    try {
      return globalThis.sessionStorage;
    } catch {
      return null;
    }
  }

  function persist(): void {
    const store = storage();
    if (!store) return;
    try {
      const list: PersistedSession[] = [...runtimes.values()].map((rt) => ({
        roomId: rt.roomId,
        relayUrl: rt.relayUrl,
        key: rt.key,
        terminal: rt.terminal.slice(-persistTerminalLimit),
        phase: rt.state.phase,
        ...(rt.state.closedReason !== undefined ? { closedReason: rt.state.closedReason } : {}),
      }));
      store.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(list));
      hasPersisted = true;
    } catch {
      /* storage unavailable (private mode): sessions stay memory-only */
    }
  }

  function commit(): void {
    snapshotCache = {
      sessions: [...runtimes.values()].map((rt) => ({
        roomId: rt.roomId,
        relayUrl: rt.relayUrl,
        label: rt.label,
        phase: rt.state.phase,
        intercept: rt.state.intercept,
        gapped: rt.state.gapped,
        chunkCount: rt.state.chunkCount,
        ...(rt.state.closedReason !== undefined ? { closedReason: rt.state.closedReason } : {}),
        terminal: rt.terminal,
      })),
      activeId,
    };
    // Persist only once there is content to write (or we have persisted
    // before, so removals also land): an eager write at construction would
    // clobber the persisted sessions with an empty list before restore()
    // ever had a chance to read them back.
    if (runtimes.size > 0 || hasPersisted) persist();
    for (const listener of listeners) listener();
  }

  function appendTerminal(rt: SessionRuntime, chunk: string): void {
    rt.terminal += chunk;
    if (rt.terminal.length > terminalLimit) {
      rt.terminal = rt.terminal.slice(-terminalLimit);
    }
  }

  function sendResize(rt: SessionRuntime): void {
    if (!termDims || !rt.socket) return;
    void rt.socket
      .send({
        event: "TERMINAL_RESIZE",
        meta: { session_id: "mobile" },
        payload: termDims,
      })
      .catch(() => {
        /* resize frames dropped during a reconnect gap are harmless */
      });
  }

  function makeSocketHandlers(roomId: string): Pick<
    MobileSocketOptions,
    "onEvent" | "onGap" | "onClosed" | "onFatal"
  > {
    return {
      onEvent: (event: WireEvent) => handleEvent(roomId, event),
      onGap: () => handleGap(roomId),
      onClosed: (code, reason) => handleClosed(roomId, code, reason),
      onFatal: () => handleFatal(roomId),
    };
  }

  function runtimeFor(roomId: string): SessionRuntime | undefined {
    const rt = runtimes.get(roomId);
    if (!rt || rt.state.phase === "closed") return undefined;
    return rt;
  }

  function handleEvent(roomId: string, event: WireEvent): void {
    const rt = runtimeFor(roomId);
    if (!rt) return;
    console.log("[e2e-trace] received", event.event);
    if (event.event === "SESSION_ENDED") {
      rt.state = reduceSession(rt.state, { type: "EVENT", event });
      void rt.socket?.close();
      commit();
      return;
    }
    if (event.event === "TERMINAL_DATA") {
      appendTerminal(rt, event.payload.chunk);
      if (isActive(roomId)) emit(event.payload.chunk);
    }
    rt.state = reduceSession(rt.state, { type: "EVENT", event });
    commit();
  }

  function handleGap(roomId: string): void {
    const rt = runtimeFor(roomId);
    if (!rt) return;
    console.log("[e2e-trace] GAP fired");
    appendTerminal(rt, GAP_MARKER);
    if (isActive(roomId)) emit(GAP_MARKER);
    rt.state = reduceSession(rt.state, { type: "GAP" });
    // Re-assert the viewport after a reconnect gap: a resize frame lost while
    // the relay was down must not leave the agent drawing at stale dimensions.
    sendResize(rt);
    commit();
  }

  function handleClosed(roomId: string, code: number, reason: string): void {
    const rt = runtimeFor(roomId);
    if (!rt) return;
    rt.state = reduceSession(rt.state, { type: "CLOSED", code, reason });
    commit();
  }

  function handleFatal(roomId: string): void {
    const rt = runtimeFor(roomId);
    if (!rt) return;
    rt.state = reduceSession(rt.state, {
      type: "FATAL",
      message: "Session key rejected — pairing mismatch. Rescan the QR.",
    });
    commit();
  }

  async function connectRuntime(rt: SessionRuntime, announce: boolean): Promise<void> {
    if (!rt.socket) return;
    await rt.socket.connect();
    // The phone's terminal is now the authoritative viewport for this room.
    sendResize(rt);
    if (announce) {
      const line = `\n[connected to room ${rt.roomId} — live output from here on; earlier output is not replayed]\n`;
      appendTerminal(rt, line);
      if (isActive(rt.roomId)) emit(line);
    }
    rt.state = reduceSession(rt.state, { type: "CONNECTED" });
    commit();
  }

  const store: SessionStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return snapshotCache;
    },

    async addSession(parsed, token) {
      if (runtimes.has(parsed.room)) {
        activeId = parsed.room;
        commit();
        return;
      }
      const sessionKey = await importSessionKey(parsed.key);
      const rt: SessionRuntime = {
        roomId: parsed.room,
        relayUrl: parsed.relay,
        label: `Room ${parsed.room.slice(-4)}`,
        key: parsed.key,
        state: { ...initialSessionState, phase: "connecting" },
        terminal: "",
        socket: null,
      };
      rt.socket = socketFactory({
        relayUrl: parsed.relay,
        roomId: parsed.room,
        token,
        sessionKey,
        ...makeSocketHandlers(parsed.room),
      });
      runtimes.set(parsed.room, rt);
      activeId = parsed.room;
      commit();
      try {
        await connectRuntime(rt, true);
      } catch (err) {
        runtimes.delete(parsed.room);
        if (activeId === parsed.room) {
          const remaining = [...runtimes.keys()];
          activeId = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
        }
        commit();
        throw err;
      }
    },

    removeSession(roomId) {
      const rt = runtimes.get(roomId);
      if (!rt) return;
      void rt.socket?.close();
      runtimes.delete(roomId);
      if (activeId === roomId) {
        const remaining = [...runtimes.keys()];
        activeId = remaining.length > 0 ? remaining[remaining.length - 1]! : null;
      }
      commit();
    },

    setActive(roomId) {
      if (!runtimes.has(roomId) || activeId === roomId) return;
      activeId = roomId;
      commit();
    },

  setTermDims(dims) {
    termDims = dims;
  },

  setSink(write) {
    sink = write;
  },

  async sendResize() {
    const rt = runtimeFor(activeId ?? "");
    if (!rt) return;
    sendResize(rt);
  },

    async sendPrompt(prompt) {
      console.log("[e2e-trace] sendPrompt:", prompt);
      const rt = runtimeFor(activeId ?? "");
      if (!rt?.socket) return;
      try {
        await rt.socket.send({
          event: "EXECUTE_AGENT_PROMPT",
          meta: { session_id: "mobile" },
          payload: { prompt },
        });
      } catch {
        if (rt.state.phase !== "closed") {
          rt.state = reduceSession(rt.state, { type: "GAP" });
          commit();
        }
      }
    },

    async resolve(decision) {
      const rt = runtimeFor(activeId ?? "");
      if (!rt?.socket || !rt.state.intercept) return;
      try {
        await rt.socket.send({
          event: "RESOLVE_INTERCEPT",
          meta: { session_id: rt.state.intercept.id.split(":")[0] ?? "sess" },
          payload: { decision, input_payload: null },
        });
        rt.state = reduceSession(rt.state, { type: "RESOLVED" });
        commit();
      } catch {
        rt.state = reduceSession(rt.state, { type: "GAP" });
        commit();
      }
    },

    async restore() {
      if (restored) return;
      restored = true;
      const storageApi = storage();
      if (!storageApi) return;
      let raw: string | null = null;
      try {
        raw = storageApi.getItem(SESSIONS_STORAGE_KEY);
      } catch {
        return;
      }
      if (!raw) return;
      let list: PersistedSession[];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        list = parsed as PersistedSession[];
      } catch {
        return;
      }
      const token = readStoredToken() ?? "";
      const connects: Promise<void>[] = [];
      for (const p of list) {
        if (!p || typeof p.roomId !== "string" || typeof p.key !== "string") continue;
        if (runtimes.has(p.roomId)) continue;
        const rt: SessionRuntime = {
          roomId: p.roomId,
          relayUrl: p.relayUrl,
          label: `Room ${p.roomId.slice(-4)}`,
          key: p.key,
          state: {
            ...initialSessionState,
            phase: p.phase === "closed" ? "closed" : "connecting",
            ...(p.closedReason !== undefined ? { closedReason: p.closedReason } : {}),
          },
          terminal: typeof p.terminal === "string" ? p.terminal : "",
          socket: null,
        };
        runtimes.set(p.roomId, rt);
        if (p.phase === "closed" || !token) continue;
        try {
          const sessionKey = await importSessionKey(p.key);
          rt.socket = socketFactory({
            relayUrl: p.relayUrl,
            roomId: p.roomId,
            token,
            sessionKey,
            ...makeSocketHandlers(p.roomId),
          });
          connects.push(connectRuntime(rt, false).catch(() => {}));
        } catch {
          /* bad stored key: session stays unconnected */
        }
      }
      const first = [...runtimes.keys()];
      if (activeId === null && first.length > 0) activeId = first[0]!;
      commit();
      await Promise.all(connects);
    },
  };

  commit();
  return store;
}

// App-level singleton. Created at module load: on the server (Next SSR) the
// storage probe fails silently and the store stays empty until restore().
export const defaultSessionStore: SessionStore = createSessionStore();
