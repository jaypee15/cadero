import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/main.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`unexpected fetch: ${String(input)}`);
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
}

describe("runCli", () => {
  it("login runs the device flow and saves credentials", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const lines: string[] = [];
    const code = await runCli(["login"], {
      caderoDir: dir,
      env: { CADERO_GITHUB_CLIENT_ID: "cid-test" },
      fetchImpl: fakeFetch({
        "https://github.com/login/device/code": {
          status: 200,
          body: {
            device_code: "dev",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 10,
          },
        },
        "https://github.com/login/oauth/access_token": {
          status: 200,
          body: { access_token: "tok123" },
        },
      }),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("ABCD-1234");
    const { loadCredentials } = await import("../src/credentials.js");
    expect(await loadCredentials(dir)).toEqual({ githubToken: "tok123" });
  });

  it("login without CADERO_GITHUB_CLIENT_ID exits 1 with guidance", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const errs: string[] = [];
    const code = await runCli(["login"], {
      caderoDir: dir,
      env: {},
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("CADERO_GITHUB_CLIENT_ID");
  });

  it("login uses CADERO_GITHUB_CLIENT_ID from env", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const lines: string[] = [];
    const code = await runCli(["login"], {
      caderoDir: dir,
      env: { CADERO_GITHUB_CLIENT_ID: "cid-env" },
      fetchImpl: fakeFetch({
        "https://github.com/login/device/code": {
          status: 200,
          body: {
            device_code: "dev",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 10,
          },
        },
        "https://github.com/login/oauth/access_token": {
          status: 200,
          body: { access_token: "tok123" },
        },
      }),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(await (await import("../src/credentials.js")).loadCredentials(dir)).toEqual({
      githubToken: "tok123",
    });
  });

  it("start without credentials exits 1 with guidance", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const errs: string[] = [];
    const code = await runCli(["start", "--relay-url", "https://r.example.com"], {
      caderoDir: dir,
      stderr: (line) => errs.push(line),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("cadero login");
  });

  it("start defaults to the deployed relay when none is given", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ githubToken: "tok" }));
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      throw new Error("stop at pair");
    }) as unknown as typeof fetch;
    await expect(runCli(["start"], { caderoDir: dir, env: {}, fetchImpl })).rejects.toThrow(
      "stop at pair",
    );
    expect(urls[0]).toContain("https://cadero.dev/v1/pair");
  });

  it("start prefers CADERO_RELAY_URL over the default", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ githubToken: "tok" }));
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      throw new Error("stop");
    }) as unknown as typeof fetch;
    await expect(
      runCli(["start"], {
        caderoDir: dir,
        env: { CADERO_RELAY_URL: "https://relay.example.com" },
        fetchImpl,
      }),
    ).rejects.toThrow("stop");
    expect(urls[0]).toContain("https://relay.example.com/v1/pair");
  });

  it("start prefers --relay-url over everything", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ githubToken: "tok" }));
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      throw new Error("stop");
    }) as unknown as typeof fetch;
    await expect(
      runCli(["start", "--relay-url", "http://127.0.0.1:1"], {
        caderoDir: dir,
        env: { CADERO_RELAY_URL: "https://relay.example.com" },
        fetchImpl,
      }),
    ).rejects.toThrow("stop");
    expect(urls[0]).toContain("http://127.0.0.1:1/v1/pair");
  });

  it("start with an invalid CADERO_MIRROR_GRACE_MS exits 1 before pairing", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ githubToken: "tok" }));
    const errs: string[] = [];
    const code = await runCli(["start", "--relay-url", "https://r.example.com"], {
      caderoDir: dir,
      env: { CADERO_MIRROR_GRACE_MS: "banana" },
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("CADERO_MIRROR_GRACE_MS");
  });

  it("help exits 0 and prints usage", async () => {
    const out: string[] = [];
    const code = await runCli(["--help"], { stdout: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("cadero login");
  });
});
