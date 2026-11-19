#!/usr/bin/env node
/**
 * Sets project version across package.json, tauri.conf.json, Cargo.toml, and Cargo.lock,
 * computing the corresponding Android versionCode.
 *
 * Usage:
 *   node scripts/set-version.mjs 2.1.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let raw = (process.argv[2] || "").trim();
if (!raw) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch[+build]>");
  process.exit(1);
}

// Normalize "0.1" -> "0.1.0"
if (/^\d+\.\d+$/.test(raw)) {
  raw = `${raw}.0`;
}

const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw);
if (!m) {
  console.error(`Invalid version format: ${raw} (expected 2.1.0 or similar)`);
  process.exit(1);
}

const [, major, minor, patch] = m.map(Number);
if (minor > 999 || patch > 999) {
  console.error("minor / patch exceeds 999");
  process.exit(1);
}
// Ensure versionCode is always > 2001000 so Android OS never rejects the update as a downgrade
const versionCode = 3_000_000 + major * 10_000 + minor * 100 + patch;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function update(rel, fn) {
  const p = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(json);
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${rel} -> ${json.version}${json.bundle?.android?.versionCode ? ` (versionCode ${json.bundle.android.versionCode})` : ""}`);
}

update("package.json", (j) => {
  j.version = raw;
});

update("src-tauri/tauri.conf.json", (j) => {
  j.version = raw;
  j.bundle = j.bundle ?? {};
  j.bundle.android = { ...(j.bundle.android ?? {}), versionCode };
});

const CARGO_PKG = "hghubx";

function setCargoToml(rel) {
  const p = path.join(root, rel);
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let done = false;
  const out = lines.map((line) => {
    if (!done && /^version\s*=\s*"/.test(line)) {
      done = true;
      return line.replace(/^version\s*=\s*"[^"]*"/, `version = "${raw}"`);
    }
    return line;
  });
  if (!done) throw new Error(`${rel} missing version = "..."`);
  fs.writeFileSync(p, out.join("\n"));
  console.log(`  ${rel} -> ${raw}`);
}

function setCargoLock(rel, pkgName) {
  const p = path.join(root, rel);
  const blocks = fs.readFileSync(p, "utf8").split("[[package]]");
  let done = false;
  const out = blocks.map((block) => {
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block);
    if (!name || name[1] !== pkgName) return block;
    done = true;
    return block.replace(/(^\s*version\s*=\s*)"[^"]*"/m, `$1"${raw}"`);
  });
  if (!done) throw new Error(`${rel} missing package ${pkgName}`);
  fs.writeFileSync(p, out.join("[[package]]"));
  console.log(`  ${rel} -> ${raw} (${pkgName})`);
}

setCargoToml("src-tauri/Cargo.toml");
setCargoLock("src-tauri/Cargo.lock", CARGO_PKG);

console.log(`versionName=${raw}  versionCode=${versionCode}`);
