"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalApi {
  write(chunk: string): void;
  clear(): void;
  fit(): void;
  dispose(): void;
}

export function TerminalView({
  onReady,
  onResize,
}: {
  onReady(api: TerminalApi): void;
  onResize?(dims: { cols: number; rows: number }): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

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
      const refit = () => {
        try {
          fitAddon.fit();
          if (Number.isFinite(term.cols) && Number.isFinite(term.rows)) {
            onResizeRef.current?.({ cols: term.cols, rows: term.rows });
          }
        } catch {
          /* zero-dimension container mid-layout: the observer refits on resize */
        }
      };
      observer = new ResizeObserver(refit);
      observer.observe(hostRef.current);
      onReady({
        write: (chunk) => term.write(chunk),
        clear: () => term.reset(),
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

  // overflow-hidden clips .xterm-rows so it can never spill over the Send
  // button in narrow viewports (Enter-to-submit stays the tested path).
  return <div ref={hostRef} className="relative z-0 h-full w-full overflow-hidden" />;
}
