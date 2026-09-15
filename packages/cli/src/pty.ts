import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import * as pty from "node-pty";

export interface PtySession {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(input: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyOptions {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

function resolveOnPath(command: string): string | null {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function createPtySession(opts: PtyOptions): PtySession {
  if (!resolveOnPath(opts.command)) {
    throw new Error(
      `agent '${opts.command}' failed to start; is it installed and on PATH?`,
    );
  }

  let proc: pty.IPty;
  try {
    proc = pty.spawn(opts.command, opts.args ?? [], {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "3",
        CADERO_ACTIVE: "true",
      } as { [key: string]: string },
    });
  } catch {
    throw new Error(
      `agent '${opts.command}' failed to start; is it installed and on PATH?`,
    );
  }

  const dataCbs: Array<(chunk: string) => void> = [];
  const exitCbs: Array<(code: number) => void> = [];
  proc.onData((chunk) => {
    for (const cb of dataCbs) cb(chunk);
  });
  proc.onExit(({ exitCode }) => {
    for (const cb of exitCbs) cb(exitCode);
  });

  return {
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    write(input) {
      proc.write(input);
    },
    resize(cols, rows) {
      proc.resize(cols, rows);
    },
    kill() {
      proc.kill();
    },
  };
}
