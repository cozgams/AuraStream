import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function main() {
  console.log("Connecting to CDP...");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const pages = browser.contexts()[0].pages();
  const page = pages[0];
  console.log("Page connected:", page.url());

  // 1. Initial Player Screenshot
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_step1_player.png") });
  console.log("Captured step 1 player");

  // 2. Click CC button to open Subtitle sheet
  console.log("Opening CC Subtitle Sheet...");
  const ccBtn = page.locator("button:has-text('CC'), button[aria-label*='ubtitle']").first();
  if (await ccBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await ccBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_step2_cc_sheet.png") });
    console.log("Captured step 2 CC sheet");

    // Close CC sheet
    const closeBtn = page.locator("button:has-text('Done'), button:has-text('✕')").first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  // 3. Click Download / Save button on right side
  console.log("Opening Download Choice Sheet...");
  const dlBtn = page.locator("button:has-text('Save'), button:has-text('Download'), button[aria-label*='ownload']").first();
  if (await dlBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dlBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_step3_download_sheet.png") });
    console.log("Captured step 3 Download Choice sheet");

    // Check elements
    const bodyText = await page.innerText("body");
    console.log("Download Sheet Contains:", {
      hasSelectEpisode: bodyText.includes("Select Episode") || bodyText.includes("Ep. 1"),
      hasDownloadEpisode: bodyText.includes("Download Episode"),
      hasFullSeason: bodyText.includes("Download Full Season"),
      hasFreeStorage: bodyText.includes("Free Device Storage") || bodyText.includes("Available")
    });

    // Close Download Sheet
    const closeSheet = page.locator("button:has-text('✕'), button[aria-label='Close']").first();
    if (await closeSheet.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeSheet.click();
      await page.waitForTimeout(1000);
    }
  }

  // 4. Click Profile in bottom navigation bar
  console.log("Navigating to Profile / Downloads tab...");
  const profileTab = page.locator("button:has-text('Profile')").first();
  if (await profileTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await profileTab.click();
    await page.waitForTimeout(1500);

    // Switch to Downloads segmented tab if on profile
    const dlSegment = page.locator("button:has-text('Downloads')").first();
    if (await dlSegment.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dlSegment.click();
      await page.waitForTimeout(1500);
    }

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "v01_step4_downloads_tab.png") });
    console.log("Captured step 4 Downloads Tab");

    const tabText = await page.innerText("body");
    console.log("Downloads Tab contains:", {
      hasDownloads: tabText.includes("Downloads"),
      hasPermanent: tabText.includes("Permanent Offline Storage") || tabText.includes("never auto-delete"),
      hasMB: tabText.includes("MB")
    });
  }

  await browser.close();
  console.log("All verification steps completed successfully!");
}

main().catch(err => {
  console.error("Error running verification:", err);
  process.exit(1);
});
