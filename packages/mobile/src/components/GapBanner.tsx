"use client";

export function GapBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950">
      Connection lost — output during the gap was not captured
    </div>
  );
}
