import { describe, expect, it, vi } from "vitest";
import { pollForAccessToken, requestDeviceCode } from "../src/ghDevice.js";

function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("requestDeviceCode", () => {
  it("returns the device code bundle", async () => {
    const fetchImpl = jsonFetch({
      "https://github.com/login/device/code": {
        device_code: "dev123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      },
    });
    const res = await requestDeviceCode(fetchImpl);
    expect(res.user_code).toBe("ABCD-1234");
    expect(res.interval).toBe(5);
  });
});

describe("pollForAccessToken", () => {
  it("waits through pending then returns the token", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const body =
        calls === 1 ? { error: "authorization_pending" } : { access_token: "tok123" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const token = await pollForAccessToken(fetchImpl, "dev123", {
      interval: 1,
      expiresIn: 30,
    });
    expect(token).toBe("tok123");
    expect(calls).toBe(2);
  });

  it("slows down by 5 seconds on slow_down", async () => {
    const sleep = vi.fn();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const body =
        calls === 1 ? { error: "slow_down" } : { access_token: "tok" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    // inject sleep via opts for testability
    const token = await pollForAccessToken(fetchImpl, "dev123", {
      interval: 1,
      expiresIn: 30,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });
    expect(token).toBe("tok");
    expect(sleep).toHaveBeenCalledWith(6000);
  });

  it("throws when the device code expires", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      pollForAccessToken(fetchImpl, "dev123", {
        interval: 1,
        expiresIn: 2,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("device code expired");
  });
});
