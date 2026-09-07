import type { RoomStore } from "./rooms.js";

interface GitHubUserResponse {
  login?: unknown;
}

export async function verifyGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cadence-relay",
    },
  });
  if (!res.ok) {
    throw new Error("GitHub auth failed");
  }
  const body = (await res.json()) as GitHubUserResponse;
  if (typeof body.login !== "string" || body.login.length === 0) {
    throw new Error("GitHub auth failed");
  }
  return body.login;
}

export async function pairRoom(
  store: RoomStore,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ room_id: string }> {
  await verifyGitHubUser(accessToken, fetchImpl);
  const room_id = await store.createRoom();
  return { room_id };
}
