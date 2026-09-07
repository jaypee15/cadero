import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CadenceRcSchema = z.object({
  safeCommands: z.array(z.string().min(1)).max(100).default([]),
});

export interface CadenceConfig {
  safeCommands: string[];
}

export async function loadConfig(cwd: string): Promise<CadenceConfig> {
  const path = join(cwd, ".cadencerc");
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
    throw new Error(`.cadencerc is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CadenceRcSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`.cadencerc is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}
