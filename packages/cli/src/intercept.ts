export type AgentName = "claude" | "opencode" | "codex";

interface PatternDefinition {
  pattern: RegExp;
  /**
   * The keystrokes that accept this prompt, when it differs from the default
   * approval string. Selection dialogs accept the preselected option with
   * Enter; text prompts take "y\r".
   */
  approveInput?: string;
  /**
   * Extracts the actionable command from the matched dialog text (the match
   * may span multiple lines for multi-line dialogs). Without one, the line
   * before the match is used.
   */
  commandPattern?: RegExp;
}

const CLAUDE_PATTERNS: PatternDefinition[] = [
  { pattern: /Do you want to (make|proceed|run|execute)[^\n?]*\?[^\n]*/i },
  { pattern: /\[(y\/N|Y\/n|yes\/no)\]\s*$/i },
  { pattern: /Press Enter to continue[^\n]*/i },
  { pattern: /Allow[^\n?]*\?[^\n]*/i },
  {
    // Claude Code's first-run workspace trust dialog is a selection list with
    // "❯ No, exit" preselected. Approval is arrow-down (to "Yes, I trust this
    // folder") then Enter, written as two keystrokes — TUIs drop input that
    // arrives in the same buffer as the arrow they redraw after.
    pattern: /Quick safety check:[^\n]*/i,
    approveInput: "\u001b[B|\r",
  },
  {
    pattern: /Is this a project you created or one you trust\?[^\n]*/i,
    approveInput: "\u001b[B|\r",
  },
];

const OPENCODE_PATTERNS: PatternDefinition[] = [
  { pattern: /waiting for (your )?input[^\n]*/i },
  { pattern: /\[Y\/n\][^\n]*/i },
  {
    // opencode's permission dialog (probe-verified 1.18.31 with
    // "permission": {"bash": "ask"}): "Permission required · Shell command ·
    // $ <cmd>" with Allow once (preselected, white) / Allow always / Reject
    // and "enter = confirm" — Enter accepts "Allow once". The command is
    // extracted from the dialog's "$ <cmd>" line.
    pattern: /Permission required[\s\S]{0,400}Allow once/i,
    commandPattern: /\$\s+([^\n]+)/,
    approveInput: "\r",
  },
];

const CODEX_PATTERNS: PatternDefinition[] = [
  {
    // Codex's first-run directory trust dialog (probe-verified 0.148.0):
    // "› 1. Yes, continue  2. No, quit  Press enter to continue" — Yes is
    // preselected, so a bare Enter accepts.
    pattern: /Do you trust the contents of this directory\?[^\n]*/i,
    approveInput: "\r",
  },
  { pattern: /Press enter to continue[^\n]*/i, approveInput: "\r" },
];

const AGENT_PATTERNS: Record<AgentName, PatternDefinition[]> = {
  claude: CLAUDE_PATTERNS,
  opencode: OPENCODE_PATTERNS,
  codex: CODEX_PATTERNS,
};

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
  const patterns = AGENT_PATTERNS[agent];
  // TUIs (claude uses Ink) position every word with absolute cursor moves
  // ("Quick\x1b[8Gsafety\x1b[15Gcheck:…"), so detection runs on a normalized
  // view: cursor movements become the spaces they visually imply, other
  // escapes are dropped.
  const normalized = text
    .replace(/\x1b\[[0-9;]*[ABCDG]/g, " ")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  for (const { pattern, approveInput, commandPattern } of patterns) {
    const match = normalized.match(pattern);
    if (match && match.index !== undefined) {
      const prompt = trim500(match[0]);
      const extracted = commandPattern ? prompt.match(commandPattern)?.[1] : undefined;
      const command = trim500(extracted ?? "") || extractCommand(normalized, match.index) || prompt;
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
