// packages/mobile/src/realtime/socket.ts
import {
  decryptEnvelope,
  encryptEnvelope,
  EnvelopeError,
  type EncryptedEnvelope,
  type WireEvent,
} from "@cadero/protocol";

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const HEARTBEAT_INTERVAL_MS = 20000;
export const STALE_AFTER_MS = 45000;

const WS_OPEN = 1;
const WS_CLOSED = 3;

export interface MobileSocketOptions {
  relayUrl: string;
  roomId: string;
  token: string;
  sessionKey: CryptoKey;
  WebSocketImpl?: typeof WebSocket;
  onEvent(event: WireEvent): void;
  onGap(): void;
  onClosed(code: number, reason: string): void;
  onFatal?(error: EnvelopeError): void;
}

export class MobileSocket {
  private opts: MobileSocketOptions;
  private ws: WebSocket | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private closedByUser = false;
  private reconnectDisabled = false;
  private hasConnectedOnce = false;
  private connecting: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private lastReceivedAt = Date.now();
  // Plaintext replay header: stable per instance, monotonic per send.
  private readonly sender = randomId();
  private nextSeq = 0;

  constructor(opts: MobileSocketOptions) {
    this.opts = opts;
  }

  // Rebindable handler for tests; production passes onEvent in opts.
  onEvent(event: WireEvent): void {
    this.opts.onEvent(event);
  }

  private streamUrl(): string {
    const url = new URL(this.opts.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/stream";
    url.searchParams.set("room_id", this.opts.roomId);
    url.searchParams.set("token", this.opts.token);
    return url.toString();
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
      const ws = new WS(this.streamUrl());
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        if (this.hasConnectedOnce) this.opts.onGap();
        this.hasConnectedOnce = true;
        this.backoffMs = BASE_BACKOFF_MS;
        this.lastReceivedAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
          void this.send({
            event: "HEARTBEAT",
            // The empty session_id sentinel: MobileSocket.send stamps a UUID
            // when session_id is falsy — a heartbeat carries no session.
            meta: { session_id: "" },
            payload: {},
          }).catch(() => {
            /* send failure on a dying socket: staleness/close path owns recovery */
          });
        }, HEARTBEAT_INTERVAL_MS);
        this.staleTimer = setInterval(() => this.maybeForceReconnect(), 5000);
        resolve();
      };
      ws.onmessage = (message) => this.handleRaw(String(message.data));
      ws.onclose = (event) => this.handleClose(event.code, event.reason);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("relay connection failed"));
        }
      };
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private handleRaw(raw: string): void {
    this.lastReceivedAt = Date.now();
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return; // transport garbage: drop
    }
    void decryptEnvelope(this.opts.sessionKey, envelope as EncryptedEnvelope)
      .then((event) => this.onEvent(event))
      .catch((err: unknown) => {
        if (err instanceof EnvelopeError && err.reason === "decryption_failed") {
          this.reconnectDisabled = true;
          this.opts.onFatal?.(err);
          this.ws?.close();
          return;
        }
        // invalid_event / malformed_envelope: drop the frame
      });
  }

  private maybeForceReconnect(): void {
    if (this.closedByUser || this.reconnectDisabled) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    if (Date.now() - this.lastReceivedAt <= STALE_AFTER_MS) return;
    ws.close(); // handleClose schedules the reconnect with backoff
  }

  private handleClose(code: number, reason: string): void {
    this.clearTimers();
    if (code === 4401 || code === 4404) {
      this.reconnectDisabled = true;
      this.opts.onClosed(code, reason);
      return;
    }
    if (this.closedByUser || this.reconnectDisabled) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.closedByUser || this.reconnectDisabled) return;
      void this.connect().catch(() => {
        /* close handler already scheduled the next retry */
      });
    }, delay);
  }

  async send(event: WireEvent): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      throw new Error("socket is not open; frame dropped (no offline queue)");
    }
    const stamped: WireEvent = {
      ...event,
      meta: {
        ...event.meta,
        session_id: event.meta.session_id || crypto.randomUUID(),
        timestamp: event.meta.timestamp ?? Math.floor(Date.now() / 1000),
      },
    };
    // Encryption is async: assign the replay header only when the frame is
    // actually placed on the wire, so seq order == wire order.
    const envelope = await encryptEnvelope(this.opts.roomId, this.opts.sessionKey, stamped);
    ws.send(
      JSON.stringify({ ...envelope, sender: this.sender, seq: this.nextSeq++ }),
    );
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    this.clearTimers();
    const ws = this.ws;
    if (!ws || ws.readyState === WS_CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = undefined;
  }
}
