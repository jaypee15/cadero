import * as jsQRns from "jsqr";
import { parsePairingPayload, type ParsedPairing } from "@cadero/protocol";

type JsQR = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

const jsQR: JsQR =
  (jsQRns as unknown as { default?: JsQR }).default ??
  (jsQRns as unknown as JsQR);

export function decodeQrFromImageData(imageData: ImageData): ParsedPairing {
  const result = jsQR(imageData.data, imageData.width, imageData.height);
  if (!result || !result.data) {
    throw new Error("no QR code found");
  }
  return parsePairingPayload(result.data);
}
