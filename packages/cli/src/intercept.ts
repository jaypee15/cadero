export type AgentName = "claude" | "opencode";

const CLAUDE_PATTERNS: RegExp[] = [
  /Do you want to (make|proceed|run|execute)[^\n?]*\?[^\n]*/i,
  /\[(y\/N|Y\/n|yes\/no)\]\s*$/i,
  /Press Enter to continue[^\n]*/i,
  /Allow[^\n?]*\?[^\n]*/i,
];

const OPENCODE_PATTERNS: RegExp[] = [
  /waiting for (your )?input[^\n]*/i,
  /\[Y\/n\][^\n]*/i,
];

export interface InterceptHit {
  prompt: string;
  command: string;
}

function trim500(value: string): string {
  return value.trim().slice(0, 500);
}

function extractCommand(chunk: string, promptStartIndex: number): string {
  const before = chunk.slice(0, promptStartIndex);
  const lines = before.split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].length > 0) return trim500(lines[i]);
  }
  return "";
}

export interface InterceptMatch extends InterceptHit {
  /** Index just past the matched prompt within the scanned text. */
  end: number;
}

export function findIntercept(
  agent: AgentName,
  text: string,
): InterceptMatch | null {
  const patterns = agent === "claude" ? CLAUDE_PATTERNS : OPENCODE_PATTERNS;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const prompt = trim500(match[0]);
      const command = extractCommand(text, match.index) || prompt;
      return { prompt, command, end: match.index + match[0].length };
    }
  }
  return null;
}

export function detectIntercept(
  agent: AgentName,
  chunk: string,
): InterceptHit | null {
  const hit = findIntercept(agent, chunk);
  if (!hit) return null;
  return { prompt: hit.prompt, command: hit.command };
}

export function isSafeCommand(command: string, safeCommands: string[]): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return safeCommands.some((safe) => safe.replace(/\s+/g, " ").trim() === normalized);
}
