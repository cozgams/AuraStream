#!/usr/bin/env node
/**
 * Synchronizes Android source files (MainActivity, AuraDownloadService, AndroidManifest, file_paths)
 * into the generated Android project directory.
 * Ensures local builds and CI release builds preserve native background services and permissions.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "android-src");
const genApp = join(root, "src-tauri", "gen", "android", "app", "src", "main");

if (!existsSync(src)) {
  console.log(`[android-src] Skipped: missing ${src}`);
  process.exit(0);
}
if (!existsSync(genApp)) {
  console.log("[android-src] Skipped: gen/android directory not yet initialized");
  process.exit(0);
}

// 1. Copy MainActivity.kt and AuraDownloadService.kt
const javaDest = join(genApp, "java", "com", "aurastream", "app");
mkdirSync(javaDest, { recursive: true });
cpSync(join(src, "MainActivity.kt"), join(javaDest, "MainActivity.kt"), { force: true });
cpSync(join(src, "AuraDownloadService.kt"), join(javaDest, "AuraDownloadService.kt"), { force: true });

// 2. Copy AndroidManifest.xml
cpSync(join(src, "AndroidManifest.xml"), join(genApp, "AndroidManifest.xml"), { force: true });

// 3. Copy file_paths.xml
const xmlDest = join(genApp, "res", "xml");
mkdirSync(xmlDest, { recursive: true });
cpSync(join(src, "file_paths.xml"), join(xmlDest, "file_paths.xml"), { force: true });

console.log("[android-src] Android source files synchronized successfully ->", genApp);
