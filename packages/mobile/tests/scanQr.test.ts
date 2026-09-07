import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { decodeQrFromImageData } from "../src/pairing/scanQr.js";
import { parsePairingPayload } from "@cadence/protocol";

async function qrImageData(payload: string): Promise<ImageData> {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const quiet = 4;
  const total = size + quiet * 2;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!qr.modules.data[y * size + x]) continue;
      const i = ((y + quiet) * total + (x + quiet)) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    }
  }
  return { data, width: total, height: total } as ImageData;
}

const PAYLOAD =
  "cadence://pair?v=1&relay=https%3A%2F%2Frelay.example.com&room=room_abc123def4567890&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("decodeQrFromImageData", () => {
  it("decodes a generated pairing QR into a parsed payload", async () => {
    const image = await qrImageData(PAYLOAD);
    const parsed = decodeQrFromImageData(image);
    expect(parsed.room).toBe("room_abc123def4567890");
    expect(parsed.relay).toBe("https://relay.example.com");
  });

  it("throws when no QR is present", () => {
    const blank = {
      data: new Uint8ClampedArray(200 * 200 * 4).fill(255),
      width: 200,
      height: 200,
    } as ImageData;
    expect(() => decodeQrFromImageData(blank)).toThrow("no QR code found");
  });

  it("surfaces parsePairingPayload errors verbatim", async () => {
    const image = await qrImageData("https://example.com/not-cadence");
    expect(() => decodeQrFromImageData(image)).toThrow(
      "not a cadence pairing payload",
    );
  });
});

describe("parsePairingPayload integration", () => {
  it("round-trips through parse", async () => {
    const image = await qrImageData(PAYLOAD);
    const text = (() => {
      // decodeQr returns ParsedPairing already; assert the contract holds
      const parsed = decodeQrFromImageData(image);
      return parsePairingPayload(
        `cadence://pair?v=1&relay=${encodeURIComponent(parsed.relay)}&room=${encodeURIComponent(parsed.room)}&key=${parsed.key}`,
      );
    })();
    expect(text).toEqual(decodeQrFromImageData(image));
  });
});
