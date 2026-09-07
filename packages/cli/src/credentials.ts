import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CADENCE_DIR_DEFAULT = join(homedir(), ".cadence");

export interface Credentials {
  githubToken: string;
}

function credentialsPath(dir: string): string {
  return join(dir, "credentials.json");
}

export async function saveCredentials(
  dir: string,
  creds: Credentials,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(credentialsPath(dir), JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  // Enforce even when the file already existed (write mode is ignored then).
  await chmod0600(credentialsPath(dir));
}

async function chmod0600(path: string): Promise<void> {
  const info = await stat(path);
  if ((info.mode & 0o777) !== 0o600) {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o600);
  }
}

export async function loadCredentials(dir: string): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(dir), "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("githubToken" in parsed) ||
    typeof (parsed as { githubToken: unknown }).githubToken !== "string"
  ) {
    throw new Error(`invalid credentials file at ${credentialsPath(dir)}`);
  }
  return parsed as Credentials;
}
