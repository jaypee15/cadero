import { describe, expect, it } from "vitest";
import { createRoomStore } from "../src/rooms.js";
import { pairRoom, verifyGitHubUser } from "../src/auth.js";

const redisUrl = "redis://127.0.0.1:6379";

function fakeGitHub(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("auth", () => {
  it("returns the GitHub login for a valid token", async () => {
    const fetchImpl = fakeGitHub(200, { login: "octocat" });
    await expect(verifyGitHubUser("valid-token", fetchImpl)).resolves.toBe("octocat");
  });

  it("rejects an invalid token", async () => {
    const fetchImpl = fakeGitHub(401, {});
    await expect(verifyGitHubUser("bad-token", fetchImpl)).rejects.toThrow(
      "GitHub auth failed",
    );
  });

  it("pairs an authenticated user to a fresh room", async () => {
    const fetchImpl = fakeGitHub(200, { login: "octocat" });
    const store = createRoomStore(redisUrl);
    const { room_id } = await pairRoom(store, "valid-token", fetchImpl);
    expect(room_id).toMatch(/^room_[0-9a-f]{16}$/);
    expect(await store.roomExists(room_id)).toBe(true);
    store.disconnect();
  });
});
