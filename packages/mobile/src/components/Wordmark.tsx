export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const box = size === "lg" ? "h-10 w-10" : "h-7 w-7";
  const text = size === "lg" ? "text-2xl" : "text-lg";
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={`grid ${box} place-items-center rounded-lg bg-surface-3 font-mono text-accent ring-1 ring-line`}
      >
        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="M4 3.5 8 8l-4 4.5M9 12.5h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={`${text} font-semibold tracking-tight text-ink`}>Cadero</span>
    </span>
  );
}
