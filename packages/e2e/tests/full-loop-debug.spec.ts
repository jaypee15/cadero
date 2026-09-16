// TEMP: phone-side diagnostic — pairs with ?debug=1 and dumps the app's
// debug status element, which counts received frames without logging content.
import { expect, test } from "@playwright/test";

const TOKEN = process.env.CADERO_E2E_TOKEN as string;
const PAYLOAD = process.env.CADERO_E2E_PAYLOAD_OPENCODE as string;

test("opencode debug status", async ({ page }) => {
  await page.goto(`/app?debug=1#token=${TOKEN}`);
  await page.getByRole("button", { name: /advanced.*paste the pairing payload/i }).click();
  await page.getByPlaceholder(/paste the pairing payload/i).fill(PAYLOAD);
  await page.getByRole("button", { name: /pair manually/i }).click();
  await page.waitForTimeout(25000);
  const status = await page.evaluate(() => {
    const el = document.querySelector("[data-debug-status]");
    return el ? (el as HTMLElement).innerText : "no debug element";
  });
  console.log("[debug-status]", status);
});
