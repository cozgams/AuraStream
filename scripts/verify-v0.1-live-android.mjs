import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function run() {
  console.log("Connecting to live Android WebView over CDP at http://127.0.0.1:9222...");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  console.log("Page URL:", page.url(), "Title:", await page.title());

  // Wait for React to mount
  await page.waitForTimeout(2000);

  // 1. Verify Version Display
  console.log("Checking version tag on UI...");
  const versionBadge = page.locator("text=v0.1.0").first();
  const hasVersion = await versionBadge.isVisible({ timeout: 4000 }).catch(() => false);
  console.log("Version v0.1.0 badge visible on Home:", hasVersion);

  await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_01_home.png") });

  // 2. Click a drama card to enter Feed / Player
  console.log("Navigating into drama player...");
  const dramaCard = page.locator(".ios-media-card, [data-video-id], .cursor-pointer").first();
  if (await dramaCard.isVisible({ timeout: 4000 }).catch(() => false)) {
    await dramaCard.click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_02_player.png") });

  // 3. Open Subtitle Sheet (CC)
  console.log("Opening CC / Subtitle Sheet...");
  const ccButton = page.locator("button:has-text('CC'), [aria-label*='ubtitle'], [data-testid='subtitle-btn']").first();
  if (await ccButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ccButton.click();
    await page.waitForTimeout(1500);
    console.log("CC Sheet opened!");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_03_subtitle_sheet.png") });

    // Close Subtitle sheet
    const closeBtn = page.locator("button:has-text('Done'), button:has-text('✕')").first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  // 4. Open Download Choice Sheet
  console.log("Opening Download Choice Sheet...");
  const downloadButton = page.locator("button:has-text('Download'), button[aria-label*='ownload']").first();
  if (await downloadButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await downloadButton.click();
    await page.waitForTimeout(1500);
    console.log("Download Choice Sheet opened!");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_04_download_choice_sheet.png") });

    // Inspect elements inside DownloadChoiceSheet
    const sheetTitle = await page.locator("h3:has-text('Download Episode')").isVisible({ timeout: 2000 }).catch(() => false);
    const quickStrip = await page.locator("text=Quick Episode Select").isVisible({ timeout: 2000 }).catch(() => false);
    const fullSeason = await page.locator("text=Download Full Season").isVisible({ timeout: 2000 }).catch(() => false);
    const storageMeter = await page.locator("text=Free Device Storage").isVisible({ timeout: 2000 }).catch(() => false);

    console.log("DownloadSheet Elements:", {
      sheetTitle,
      quickStrip,
      fullSeason,
      storageMeter
    });

    // Close download choice sheet
    const closeSheet = page.locator("button:has-text('✕'), button[aria-label='Close']").first();
    if (await closeSheet.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeSheet.click();
      await page.waitForTimeout(1000);
    }
  }

  // 5. Navigate to Downloads Tab
  console.log("Navigating to Downloads Tab...");
  const downloadsNav = page.locator("button:has-text('Downloads'), a:has-text('Downloads')").first();
  if (await downloadsNav.isVisible({ timeout: 3000 }).catch(() => false)) {
    await downloadsNav.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_05_downloads_tab.png") });
  }

  // 6. Navigate to Settings Tab
  console.log("Navigating to Settings Tab...");
  const settingsNav = page.locator("button:has-text('Settings'), a:has-text('Settings')").first();
  if (await settingsNav.isVisible({ timeout: 3000 }).catch(() => false)) {
    await settingsNav.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_06_settings_tab.png") });

    // Verify Settings shows version
    const versionInSettings = await page.locator("text=0.1.0").first().isVisible({ timeout: 2000 }).catch(() => false);
    console.log("Version 0.1.0 in Settings:", versionInSettings);
  }

  console.log("All live checks complete!");
  await browser.close();
}

run().catch((err) => {
  console.error("Error running test:", err);
  process.exit(1);
});
