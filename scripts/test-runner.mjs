import { spawnSync } from "node:child_process";
import fs from "node:fs";

if (!process.env.BROWSER_EXECUTABLE) {
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    process.env.BROWSER_EXECUTABLE = found;
  }
}

const suites = [
  { name: "iOS Icon Catalog", script: "scripts/test-ios-icons.mjs" },
  { name: "Channel Pagination", script: "scripts/test-channel-pagination.mjs" },
  { name: "Storage Migration & Theme Adaptation", script: "scripts/test-storage-migration.mjs" },
  { name: "Diagnostic Copy & IPC", script: "scripts/test-diagnostic-copy.mjs" },
  { name: "Network Settings & Proxy Policy", script: "scripts/test-network-settings.mjs" },
  { name: "Line Selection & Auto Switch", script: "scripts/test-line-selection.mjs" },
  { name: "Mobile Viewport Layout", script: "scripts/test-mobile-layout.mjs" },
  { name: "Offline & Download Enhancements", script: "scripts/test-download-enhancements.mjs" },
  { name: "Theme Accents & Media Session", script: "scripts/test-accent-and-mediasession.mjs" },
];

console.log("=== RUNNING AURASTREAM TEST RUNNER ===");
console.log(`Browser Executable: ${process.env.BROWSER_EXECUTABLE}\n`);

let failed = 0;
for (const { name, script } of suites) {
  process.stdout.write(`• Running ${name} (${script})... `);
  const start = Date.now();
  const res = spawnSync("node", [script], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
  });
  const dur = ((Date.now() - start) / 1000).toFixed(1);
  if (res.status === 0) {
    console.log(`PASS (${dur}s)`);
  } else {
    console.log(`FAIL (${dur}s)`);
    console.error(res.stdout || res.stderr);
    failed++;
  }
}

console.log(`\n=== RESULTS: ${suites.length - failed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
