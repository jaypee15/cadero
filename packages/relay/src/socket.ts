import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { RawData } from "ws";
import { EncryptedEnvelopeSchema } from "@cadence/protocol";
import { redactForLog } from "./logging.js";
import { createRoomStore } from "./rooms.js";

export type VerifyUser = (token: string) => Promise<string>;

function framesChannel(roomId: string): string {
  return `cadence:frames:${roomId}`;
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
  }
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
          void processMessage(raw);
        } else {
          pending.push(raw);
        }
      });

      socket.on("close", () => {
        resolveReady();
        leaveRoom(roomId, member);
        void subscriber?.quit().catch(() => {});
        publisher?.disconnect();
        store.disconnect();
      });

      try {
        await verifyUser(token);
      } catch {
        socket.close(4401, "unauthorized");
        return;
      }
      if (!(await store.roomExists(roomId))) {
        socket.close(4404, "unknown room");
        return;
      }

      subscriber = new Redis(redisUrl);
      publisher = new Redis(redisUrl);
      await subscriber.subscribe(framesChannel(roomId));
      subscriber.on("message", (_channel, message) => {
        if (socket.readyState === 1) {
          socket.send(message);
        }
      });

      async function publishEnvelope(envelope: { room_id: string }): Promise<void> {
        const members = roomMembers.get(roomId);
        if (members) {
          await Promise.all([...members].map((m) => m.ready));
        }
        await publisher!.publish(framesChannel(roomId), JSON.stringify(envelope));
      }

      processMessage = async (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          request.log.warn(redactForLog({ room_id: roomId }));
          return;
        }
        const envelope = EncryptedEnvelopeSchema.safeParse(parsed);
        if (!envelope.success || envelope.data.room_id !== roomId) {
          request.log.warn(redactForLog(parsed));
          return;
        }
        await publishEnvelope(envelope.data);
        await store.touchRoom(roomId);
      };
      for (const raw of pending.splice(0)) {
        void processMessage(raw);
      }

      resolveReady();
    },
  );
}
