import { describe, expect, it } from "vitest";
import { runMain } from "../src/main.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("main entrypoint", () => {
  it("rejects with a clear error when REDIS_URL is unset", async () => {
    await expect(runMain({ env: {} })).rejects.toThrow(/REDIS_URL/);
  });

  it("rejects when redis is unreachable", async () => {
    await expect(
      runMain({ env: { REDIS_URL: "redis://127.0.0.1:6390" } }),
    ).rejects.toThrow(/unreachable/i);
  }, 15000);

  it("listens and returns the bound port", async () => {
    const { app, port } = await runMain({ env: { REDIS_URL: redisUrl, PORT: "0" } });
    expect(port).toBeGreaterThan(0);
    await app.close();
  });
});
