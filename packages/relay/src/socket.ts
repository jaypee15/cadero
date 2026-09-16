import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { RawData } from "ws";
import { EncryptedEnvelopeSchema } from "@cadero/protocol";
import { redactForLog } from "./logging.js";
import { createRoomStore } from "./rooms.js";

export type VerifyUser = (token: string) => Promise<string>;

function framesChannel(roomId: string): string {
  return `cadero:frames:${roomId}`;
}

interface RoomMember {
  ready: Promise<void>;
  resolveReady: () => void;
}

// Redis pub/sub only delivers to subscribers that are already subscribed, so
// members of a room are tracked here with a promise that resolves once their
// Redis subscription is confirmed. A publish then waits on that promise for
// every member present when the frame arrived, which guarantees fanout to
// sockets connected before the frame was sent.
//
// ── Horizontal-scaling design note (do not remove before any scaling work) ──
// This map is PROCESS-LOCAL by design. With a single relay process, "a member
// has joined" is observable synchronously and the readiness promise above is
// exact: publish() waits precisely for the members it can see. With N relay
// instances behind a load balancer, member state lives in other processes and
// this promise waits on nothing — frames published before a member's Redis
// subscription lands are silently lost (the phone shows a GAP banner).
// A Redis-based scheme would need, per room: an origin/epoch stamp written to
// Redis when a member joins (e.g. hash `cadero:members:<roomId>` with
// `<originId> -> <epochMs>`), each publish tagging the frame with the
// publisher's originId + epoch, and the subscriber path ordering frames by
// epoch before socket delivery — plus a goroutine-style sweeper removing
// stale epochs. Do NOT implement this casually: getting it wrong silently
// drops phone frames, which the staleness detector only notices after 45s.
const roomMembers = new Map<string, Set<RoomMember>>();

function joinRoom(roomId: string, member: RoomMember): void {
  let members = roomMembers.get(roomId);
  if (!members) {
    members = new Set();
    roomMembers.set(roomId, members);
  }
  members.add(member);
}

function leaveRoom(roomId: string, member: RoomMember): void {
  const members = roomMembers.get(roomId);
  if (!members) {
    return;
  }
  members.delete(member);
  if (members.size === 0) {
    roomMembers.delete(roomId);
    lastSeenSeq.delete(roomId);
  }
}

// Replay detection: (roomId -> sender -> last accepted seq). A frame whose
// seq does not ADVANCE beyond the last accepted one for its sender is a
// captured-frame replay and is dropped before fanout. The sender id is a
// random per-socket-instance value stamped by the encrypting peer; the relay
// never needs to interpret it, only group by it.
const lastSeenSeq = new Map<string, Map<string, number>>();

function shouldAcceptFrame(roomId: string, sender: string, seq: number): boolean {
  let perSender = lastSeenSeq.get(roomId);
  if (!perSender) {
    perSender = new Map();
    lastSeenSeq.set(roomId, perSender);
  }
  const last = perSender.get(sender);
  if (last !== undefined && seq <= last) {
    return false;
  }
  perSender.set(sender, seq);
  return true;
}

export function registerStreamRoute(
  app: FastifyInstance,
  redisUrl: string,
  verifyUser: VerifyUser,
): void {
  app.get<{ Querystring: { room_id?: string; token?: string } }>(
    "/v1/stream",
    { websocket: true },
    async (socket, request) => {
      const roomId = request.query.room_id ?? "";
      const token = request.query.token ?? "";
      const store = createRoomStore(redisUrl);
      console.log(`[relay-trace] join room=${roomId} t=${Date.now() % 100000}`);

      // Frames can arrive as soon as the upgrade completes, before the async
      // setup below finishes, so the listener is attached synchronously and
      // early frames are queued until the route is ready to process them.
      const pending: RawData[] = [];
      let processMessage: ((raw: RawData) => Promise<void>) | null = null;

      let subscriber: Redis | null = null;
      let publisher: Redis | null = null;

      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const member: RoomMember = { ready, resolveReady };
      joinRoom(roomId, member);

      socket.on("message", (raw) => {
        if (processMessage) {
          void processMessage(raw).catch(() => {
            request.log.warn(redactForLog({ room_id: roomId }));
          });
        } else {
          pending.push(raw);
        }
      });

      socket.on("close", (code, reason) => {
        console.log(`[relay-trace] close room=${roomId} code=${code} origin=${originId.slice(0, 6)} t=${Date.now() % 100000}`);
        resolveReady();
        leaveRoom(roomId, member);
        void subscriber?.quit().catch(() => {});
        publisher?.disconnect();
        store.disconnect();
      });

      let originId = "";
      try {
        await verifyUser(token);
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }

      try {
        if (!(await store.roomExists(roomId))) {
          socket.close(4404, "unknown room");
          return;
        }

        subscriber = new Redis(redisUrl);
        publisher = new Redis(redisUrl);
        subscriber.on("error", () => {});
        publisher.on("error", () => {});
        originId = randomBytes(16).toString("hex");
        await subscriber.subscribe(framesChannel(roomId));
      } catch {
        request.log.warn(`join failed, redis unavailable in room ${roomId}`);
        resolveReady();
        leaveRoom(roomId, member);
        subscriber?.disconnect();
        publisher?.disconnect();
        store.disconnect();
        socket.close(4403, "redis unavailable");
        return;
      }

      subscriber.on("message", (_channel, message) => {
        let parsed: { from?: string; frame?: string };
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        if (parsed.from === originId || typeof parsed.frame !== "string") {
          return;
        }
        console.log(`[relay-trace] fanout room=${roomId} t=${Date.now() % 100000}`);
        if (socket.readyState === 1) {
          socket.send(parsed.frame);
        }
      });

      async function publishEnvelope(envelope: { room_id: string }): Promise<void> {
        const members = roomMembers.get(roomId);
        if (members) {
          await Promise.all([...members].map((m) => m.ready));
        }
        const wrapper = JSON.stringify({ from: originId, frame: JSON.stringify(envelope) });
        await publisher!.publish(framesChannel(roomId), wrapper);
      }

      processMessage = async (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          request.log.warn(redactForLog({ room_id: roomId }));
          return;
        }
        const fromPrefix = typeof (parsed as { from?: unknown }).from === "string" ? String((parsed as { from?: unknown }).from).slice(0, 6) : "?";
        const size = JSON.stringify(parsed).length;
        console.log(`[relay-trace] inbound room=${roomId} from=${fromPrefix} origin=${originId.slice(0, 6)} size=${size} t=${Date.now() % 100000}`);
        const envelope = EncryptedEnvelopeSchema.safeParse(parsed);
        if (!envelope.success || envelope.data.room_id !== roomId) {
          request.log.warn(redactForLog(parsed));
          return;
        }
        // Replay gate: no sender/seq header, or a non-advancing seq for this
        // sender, means the frame is dropped before it can be fanned out.
        const { sender, seq } = envelope.data;
        if (
          sender === undefined ||
          seq === undefined ||
          !shouldAcceptFrame(roomId, sender, seq)
        ) {
          request.log.warn(redactForLog(envelope.data));
          return;
        }
        // A transient redis failure must not reject out of an un-awaited
        // promise (which would crash the process). Drop the frame; the
        // socket stays alive and non-routing while redis is down.
        try {
          await publishEnvelope(envelope.data);
          await store.touchRoom(roomId);
        } catch {
          request.log.warn(redactForLog(envelope.data));
          return;
        }
      };
      for (const raw of pending.splice(0)) {
        void processMessage(raw).catch(() => {
          request.log.warn(redactForLog({ room_id: roomId }));
        });
      }

      resolveReady();
    },
  );
}
