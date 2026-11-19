import { getCurrentWindow } from "@tauri-apps/api/window";

const MAP: [string, string][] = [
  ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
  ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
];

/** Frameless window resize handles (Windows/Linux). */
export default function ResizeHandles() {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) {
    return null;
  }
  let win: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    win = getCurrentWindow();
  } catch {
    return null;
  }
  if (!win) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[70]">
      {MAP.map(([edge, dir]) => (
        <div key={edge}
          className={`win-resize win-resize-${edge} pointer-events-auto`}
          onPointerDown={(e) => {
            e.preventDefault();
            // ResizeDirection passed as string
            (win?.startResizeDragging as unknown as (d: string) => Promise<void>)?.(dir).catch(() => {});
          }}
        />
      ))}
    </div>
  );
}