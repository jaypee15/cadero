// packages/e2e/tests/camera-scan.spec.ts
// Covers the camera pairing path: a fake getUserMedia stream (a canvas that
// renders a QR encoding the real pairing payload) feeds the PWA's jsQR
// scanner, completing pairing without the manual paste fallback.
import { expect, test } from "@playwright/test";
import QRCode from "qrcode";

const E2E_TOKEN = process.env.CADERO_E2E_TOKEN as string;
const PAYLOAD = process.env.CADERO_E2E_PAYLOAD as string;

test("camera scan pairs and goes live", async ({ page }) => {
  const qrDataUrl = await QRCode.toDataURL(PAYLOAD, {
    width: 640,
    margin: 2,
    errorCorrectionLevel: "low",
  });
  await page.addInitScript((dataUrl: string) => {
    const canvasStream = async (): Promise<MediaStream> =>
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 640;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          resolve(canvas.captureStream(25) as unknown as MediaStream);
        };
        img.src = dataUrl;
      });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...navigator.mediaDevices,
        getUserMedia: canvasStream,
      },
    });
  }, qrDataUrl);

  await page.goto(`/app?token-not-used#token=${E2E_TOKEN}`);
  await page.getByRole("button", { name: /scan qr code/i }).click();
  // The scanner decodes the faked camera frames and pairs automatically; the
  // prompt input only enables once the session is live.
  await expect(page.getByPlaceholder(/prompt the agent/i)).toBeVisible({
    timeout: 30000,
  });
});
