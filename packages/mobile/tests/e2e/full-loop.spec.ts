// packages/mobile/tests/e2e/full-loop.spec.ts
// The spec's contract test: pair → live terminal → prompt → intercept →
// approve → continuation, in a real browser against the real stack.
// The single CLI session (and its line-oriented stub agent) comes from
// global setup; tests run serially and in order (workers: 1).
import { expect, test, type Page } from "@playwright/test";

const E2E_TOKEN = process.env.CADENCE_E2E_TOKEN as string;
const PAYLOAD = process.env.CADENCE_E2E_PAYLOAD as string;

// Track the room transport in the page: the pairing UI renders the prompt
// input while the socket is still connecting, and a prompt sent into a
// not-yet-open socket is dropped by design (no offline queue). Gate the
// send on the transport being open.
const TRACK_ROOM_WS = `
  window.__roomWsOpen = false;
  const OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    if (String(url).includes("/v1/stream")) {
      ws.addEventListener("open", () => { window.__roomWsOpen = true; });
      ws.addEventListener("close", () => { window.__roomWsOpen = false; });
    }
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  window.WebSocket = PatchedWS;
`;

async function pair(page: Page): Promise<void> {
  await page.addInitScript(TRACK_ROOM_WS);
  await page.goto(`/?token-not-used#token=${E2E_TOKEN}`);
  await page.getByPlaceholder(/paste the pairing payload/i).fill(PAYLOAD);
  await page.getByRole("button", { name: /pair manually/i }).click();
  await page.waitForFunction(() => (window as { __roomWsOpen?: boolean }).__roomWsOpen === true, undefined, {
    timeout: 30000,
  });
  const prompt = page.getByPlaceholder(/prompt the agent/i);
  await expect(prompt).toBeVisible({ timeout: 30000 });
}

// xterm's DOM renderer can split one row across per-character spans; assert
// on the concatenated user-visible text rather than any single span.
async function expectTerminalText(page: Page, marker: string, timeout: number): Promise<void> {
  await expect(async () => {
    const text = await page.evaluate(() => {
      const rows = document.querySelector(".xterm-rows");
      const value = rows ? (rows as HTMLElement).innerText : document.body.innerText;
      return value.replace(/\s+/g, " ");
    });
    expect(text).toContain(marker);
  }).toPass({ timeout });
}

test("pair, watch terminal, prompt the agent", async ({ page }) => {
  await pair(page);
  const prompt = page.getByPlaceholder(/prompt the agent/i);
  await prompt.fill("say hi");
  await prompt.press("Enter");
  await expectTerminalText(page, "ECHO:say hi", 30000);
});

test("intercept overlay approves a dangerous command", async ({ page }) => {
  await pair(page);
  const prompt = page.getByPlaceholder(/prompt the agent/i);
  await prompt.fill("danger");
  await prompt.press("Enter");
  await expect(page.getByRole("button", { name: /approve/i })).toBeVisible({ timeout: 30000 });
  await expect(page.locator("pre").filter({ hasText: "rm -rf ./dist" })).toBeVisible();
  await page.getByRole("button", { name: /approve/i }).click();
  await expectTerminalText(page, "APPROVED-RESULT", 30000);
});
