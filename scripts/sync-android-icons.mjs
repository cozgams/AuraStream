#!/usr/bin/env node
/**
 * Synchronizes Android launcher icons into the generated Android project directory.
 * Ensures release builds use AuraStream brand icons.
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "icons", "android");
const dest = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");

if (!existsSync(src)) {
  console.log(`[icons] Skipped: missing ${src}`);
  process.exit(0);
}
if (!existsSync(dest)) {
  console.log("[icons] Skipped: gen/android directory not yet initialized");
  process.exit(0);
}

cpSync(src, dest, { recursive: true, force: true });
console.log(`[icons] Android icons synchronized -> ${dest}`);
