import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
let vite, browser;
const errors = [];

try {
  vite = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || "/usr/bin/chromium",
  });

  const page = await browser.newPage({
    viewport: { width: 412, height: 915 },
  });

  page.on("pageerror", (err) => {
    console.error("PAGEERROR:", err);
    errors.push(err.message || String(err));
  });

  await page.goto(origin);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);

  console.log("=== Verifying 2-Button Download Choice & Clean UI ===");

  // 1. Click a video to open Feed/Player
  const card = page.locator('.ios-media-card, [data-video-id], .group').first();
  if (await card.isVisible()) {
    await card.click();
    await page.waitForTimeout(1000);
  }

  // 2. Verify duplicate "⚡ Offline" badge is REMOVED from next to Details button
  const offlineBadge = page.locator('span:has-text("⚡ Offline")');
  const offlineBadgeCount = await offlineBadge.count();
  console.log("Duplicate ⚡ Offline badge count in feed:", offlineBadgeCount);
  assert.equal(offlineBadgeCount, 0, "Duplicate ⚡ Offline badge must not be present beside Details button");

  // 3. Verify no fake procedural subtitles
  const fakeSubZh = page.locator('text="区区林家，也敢在太岁头上动土？"');
  const fakeSubEn = page.locator('text="A trivial family like the Lins dares to cross us?"');
  assert.equal(await fakeSubZh.count(), 0, "Fake Chinese procedural dialogue must not be rendered");
  assert.equal(await fakeSubEn.count(), 0, "Fake English procedural dialogue must not be rendered");
  console.log("✔ Fake procedural subtitles verified completely removed");

  // 4. Find the Download/Save button on the right vertical action bar
  const downloadBtn = page.locator('button[aria-label="Offline Download"]').first();
  assert.ok(await downloadBtn.isVisible(), "Download button on right action bar must be visible");

  // 5. Tap the Download button
  await downloadBtn.click();
  await page.waitForTimeout(500);

  // 6. Verify Download Choice Sheet opens with 2 buttons: Single & Batch
  const choiceSheet = page.locator('[aria-label="Offline Downloads"]');
  assert.ok(await choiceSheet.isVisible(), "Offline Downloads choice sheet must be visible");

  const singleDownloadBtn = choiceSheet.locator('button:has-text("Download Episode"), button:has-text("Episode")').first();
  const batchDownloadBtn = choiceSheet.locator('button:has-text("Batch Download (Full Season)"), button:has-text("Full Season")').first();

  assert.ok(await singleDownloadBtn.isVisible(), "Button 1: Single Download must be visible");
  assert.ok(await batchDownloadBtn.isVisible(), "Button 2: Batch Download (Full Season) must be visible");
  console.log("✔ 2-Button Download Choice Sheet (Single & Batch) verified visible");

  // Take screenshot of the 2-button choice sheet
  await page.screenshot({
    path: "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_v2.1_download_choice_sheet.png",
  });
  console.log("✔ Screenshot captured: aurastream_v2.1_download_choice_sheet.png");

  // 7. Click Batch Download (Full Season) button
  await batchDownloadBtn.click();
  await page.waitForTimeout(500);

  // 8. Verify BatchDownloadSheet opens
  const batchSheet = page.locator('button:has-text("Download Selected"), button:has-text("Clear"), text="Batch Download"').first();
  assert.ok(await batchSheet.isVisible(), "Batch Download full series sheet must open after tapping Button 2");
  console.log("✔ Full Session Batch Downloader opens successfully from choice button");

  await page.screenshot({
    path: "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_v2.1_batch_sheet_opened.png",
  });
  console.log("✔ Screenshot captured: aurastream_v2.1_batch_sheet_opened.png");

  console.log("\nALL VERIFICATIONS PASSED SUCCESSFULLY!");
} catch (e) {
  console.error("Test failed:", e);
  process.exit(1);
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
