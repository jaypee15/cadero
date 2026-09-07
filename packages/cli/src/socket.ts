import WebSocket from "ws";
import {
  decryptEnvelope,
  encryptEnvelope,
  EnvelopeError,
  type EncryptedEnvelope,
  type WireEvent,
} from "@cadence/protocol";

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export interface CadenceSocketOptions {
  relayUrl: string;
  roomId: string;
  token: string;
  sessionKey: CryptoKey;
  sessionId: string;
  onClose?: (code: number, reason: string) => void;
  onFatal?: (error: EnvelopeError) => void;
}

export class CadenceSocket {
  private readonly opts: CadenceSocketOptions;
  private ws: WebSocket | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private closedByUser = false;
  private reconnectDisabled = false;
  private eventHandler: ((event: WireEvent) => void) | undefined;
  private connecting: Promise<void> | undefined;

  constructor(opts: CadenceSocketOptions) {
    this.opts = opts;
  }

  onEvent(handler: (event: WireEvent) => void): void {
    this.eventHandler = handler;
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
      const ws = new WebSocket(this.streamUrl());
      this.ws = ws;
      ws.on("open", () => {
        settled = true;
        this.backoffMs = BASE_BACKOFF_MS;
        resolve();
      });
      ws.on("message", (data) => this.handleRaw(data.toString()));
      ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
      ws.on("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("relay connection failed"));
        }
        // open sockets: the close event follows; reconnect lives in handleClose
      });
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private handleRaw(raw: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return; // transport garbage: drop silently
    }
    void decryptEnvelope(this.opts.sessionKey, envelope as EncryptedEnvelope)
      .then((event) => this.eventHandler?.(event))
      .catch((err: unknown) => {
        if (err instanceof EnvelopeError && err.reason === "decryption_failed") {
          // Wrong key is fatal: the pairing is broken. Surface, never hide.
          this.reconnectDisabled = true;
          this.opts.onFatal?.(err);
          this.ws?.close();
          return;
        }
        // invalid_event / malformed_envelope: drop the frame
      });
  }

  private handleClose(code: number, reason: string): void {
    if (code === 4401 || code === 4404) {
      this.reconnectDisabled = true;
      this.opts.onClose?.(code, reason);
      return;
    }
    if (this.closedByUser || this.reconnectDisabled) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.closedByUser || this.reconnectDisabled) return;
      void this.connect().catch(() => {
        // connection refused: the close handler already scheduled the next retry
      });
    }, delay);
  }

  async send(event: WireEvent): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("socket is not open; frame dropped (no offline queue)");
    }
    const stamped: WireEvent = {
      ...event,
      meta: {
        ...event.meta,
        session_id: event.meta.session_id ?? this.opts.sessionId,
        timestamp: event.meta.timestamp ?? Math.floor(Date.now() / 1000),
      },
    };
    const envelope = await encryptEnvelope(this.opts.roomId, this.opts.sessionKey, stamped);
    ws.send(JSON.stringify(envelope));
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
