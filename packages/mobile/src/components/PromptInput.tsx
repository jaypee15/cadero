"use client";

import { useState } from "react";

export function PromptInput({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend(prompt: string): void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setValue("");
  };
  return (
    <div className="flex items-center gap-2 border-t border-slate-700 bg-slate-800 p-3">
      <input
        type="text"
        placeholder="Prompt the agent…"
        disabled={disabled}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        className="min-w-0 flex-1 rounded-xl bg-slate-950 px-4 py-3 text-base text-slate-100 disabled:opacity-40"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="rounded-xl bg-sky-600 px-4 py-3 font-semibold text-white disabled:opacity-40"
      >
        Send
      </button>
    </div>
  );
}
