import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CaderoRcSchema = z.object({
  safeCommands: z.array(z.string().min(1)).max(100).default([]),
});

export interface CaderoConfig {
  safeCommands: string[];
}

export async function loadConfig(cwd: string): Promise<CaderoConfig> {
  const path = join(cwd, ".caderorc");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { safeCommands: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`.caderorc is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CaderoRcSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`.caderorc is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}
