import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    await writeText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard copy is not supported in this environment");
  }
  await navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    try {
      const text = await readText();
      return text || "";
    } catch {
      // fallback to navigator if available
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      const text = await navigator.clipboard.readText();
      return text || "";
    } catch {
      return "";
    }
  }
  return "";
}

