export function redactForLog(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "[redacted]";
  }
  const roomId =
    "room_id" in value && typeof value.room_id === "string" ? value.room_id : "unknown";
  return `dropped frame in ${roomId} [body redacted]`;
}
