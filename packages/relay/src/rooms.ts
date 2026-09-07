import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";

export const ROOM_TTL_SECONDS = 14400;

function roomKey(roomId: string): string {
  return `cadence:room:${roomId}`;
}

export interface RoomStore {
  createRoom(): Promise<string>;
  roomExists(roomId: string): Promise<boolean>;
  touchRoom(roomId: string): Promise<void>;
  disconnect(): void;
}

export function createRoomStore(redisUrl: string): RoomStore {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", () => {
    // Callers surface failures through rejected commands; connection errors
    // stay silent so redis-down does not spam stderr.
  });

  return {
    async createRoom(): Promise<string> {
      const roomId = `room_${randomBytes(8).toString("hex")}`;
      await redis.set(roomKey(roomId), "1", "EX", ROOM_TTL_SECONDS);
      return roomId;
    },

    async roomExists(roomId: string): Promise<boolean> {
      const found = await redis.exists(roomKey(roomId));
      return found === 1;
    },

    async touchRoom(roomId: string): Promise<void> {
      await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
    },

    disconnect(): void {
      redis.disconnect();
    },
  };
}
