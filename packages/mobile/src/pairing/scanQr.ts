import jsQR from "jsqr";
import { parsePairingPayload, type ParsedPairing } from "@cadence/protocol";

export function decodeQrFromImageData(imageData: ImageData): ParsedPairing {
  const result = jsQR(imageData.data, imageData.width, imageData.height);
  if (!result || !result.data) {
    throw new Error("no QR code found");
  }
  return parsePairingPayload(result.data);
}
