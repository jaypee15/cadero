"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface TerminalApi {
  write(chunk: string): void;
  fit(): void;
  dispose(): void;
}

export function TerminalView({ onReady }: { onReady(api: TerminalApi): void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new XTerm({
        cursorBlink: true,
        allowProposedApi: true,
        theme: { background: "#0f172a" },
      });
      const fitAddon = new Fit();
      term.loadAddon(fitAddon);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;
      const refit = () => fitAddon.fit();
      observer = new ResizeObserver(refit);
      observer.observe(hostRef.current);
      onReady({
        write: (chunk) => term.write(chunk),
        fit: () => fitAddon.fit(),
        dispose: () => {
          observer?.disconnect();
          term.dispose();
        },
      });
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      termRef.current?.dispose();
    };
  }, [onReady]);

  return <div ref={hostRef} className="h-full w-full" />;
}
