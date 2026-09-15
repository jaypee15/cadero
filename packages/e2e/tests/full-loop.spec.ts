// packages/mobile/tests/e2e/full-loop.spec.ts
// The spec's contract test: pair → live terminal → prompt → intercept →
// approve → continuation, in a real browser against the real stack.
// The single CLI session (and its line-oriented stub agent) comes from
// global setup; tests run serially and in order (workers: 1).
import { expect, test, type Page } from "@playwright/test";

const E2E_TOKEN = process.env.CADERO_E2E_TOKEN as string;
const PAYLOAD = process.env.CADERO_E2E_PAYLOAD as string;

async function pair(page: Page): Promise<void> {
  await page.goto(`/?token-not-used#token=${E2E_TOKEN}`);
  await page.getByPlaceholder(/paste the pairing payload/i).fill(PAYLOAD);
  await page.getByRole("button", { name: /pair manually/i }).click();
  const prompt = page.getByPlaceholder(/prompt the agent/i);
  // The prompt input only enables once the session is live; fill and the
  // visibility assertion below auto-wait for that.
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
  // Regression guard: the xterm stylesheet must be applied (the keyboard
  // helper textarea is moved off-screen and hidden by xterm.css). Missing
  // xterm.css renders it as a visible default textarea and breaks layout —
  // invisible output on a real device even though the DOM has the text.
  await expect(async () => {
    const styled = await page.evaluate(() => {
      const helper = document.querySelector<HTMLElement>(".xterm-helper-textarea");
      if (!helper) return false;
      const cs = getComputedStyle(helper);
      return cs.position === "absolute" && cs.opacity === "0";
    });
    expect(styled).toBe(true);
  }).toPass({ timeout: 15000 });
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
