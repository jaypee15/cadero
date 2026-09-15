export type AgentName = "claude" | "opencode";

interface PatternDefinition {
  pattern: RegExp;
  /**
   * The keystrokes that accept this prompt, when it differs from the default
   * approval string. Selection dialogs accept the preselected option with
   * Enter; text prompts take "y\r".
   */
  approveInput?: string;
}

const CLAUDE_PATTERNS: PatternDefinition[] = [
  { pattern: /Do you want to (make|proceed|run|execute)[^\n?]*\?[^\n]*/i },
  { pattern: /\[(y\/N|Y\/n|yes\/no)\]\s*$/i },
  { pattern: /Press Enter to continue[^\n]*/i },
  { pattern: /Allow[^\n?]*\?[^\n]*/i },
  {
    // Claude Code's first-run workspace trust dialog: Enter accepts the
    // preselected "Yes, I trust this folder"; Escape declines. Matching the
    // full "Quick safety check" line first keeps the extracted context the
    // workspace path (the line above the question).
    pattern: /Quick safety check:[^\n]*/i,
    approveInput: "\r",
  },
  {
    pattern: /Is this a project you created or one you trust\?[^\n]*/i,
    approveInput: "\r",
  },
];

const OPENCODE_PATTERNS: PatternDefinition[] = [
  { pattern: /waiting for (your )?input[^\n]*/i },
  { pattern: /\[Y\/n\][^\n]*/i },
];

export interface InterceptHit {
  prompt: string;
  command: string;
  /** Keystrokes that accept this prompt (defaults to the approval string). */
  approveInput?: string;
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
  for (const { pattern, approveInput } of patterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const prompt = trim500(match[0]);
      const command = extractCommand(text, match.index) || prompt;
      return { prompt, command, approveInput, end: match.index + match[0].length };
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
  return { prompt: hit.prompt, command: hit.command, approveInput: hit.approveInput };
}

export function isSafeCommand(command: string, safeCommands: string[]): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return safeCommands.some((safe) => safe.replace(/\s+/g, " ").trim() === normalized);
}
