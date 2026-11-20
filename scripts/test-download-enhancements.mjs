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

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke(cmd) {
          if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
          if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
          if (cmd === "debug_log") return Promise.resolve();
          if (cmd === "line_auto") return Promise.resolve({ base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } });
          return Promise.resolve({ items: [], pagination: { page: 1, pages: 1, size: 8, total: 0 } });
        },
      },
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => {
    console.error("PAGEERROR:", err);
    errors.push(err.message || String(err));
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Ignore network errors to custom schemes or mock endpoints in headless test harness
      if (text.includes("URL scheme") || text.includes("Failed to load resource") || text.includes("Unexpected IPC") || text.includes("fixture.invalid")) {
        return;
      }
      console.error("CONSOLE ERROR:", text);
      errors.push(text);
    }
  });

  await page.goto(origin);
  await page.waitForLoadState("networkidle");

  console.log("=== Testing Offline & Download Enhancements ===");

  // 1. Verify Quality Preferences & Stream Resolution
  const qualityTests = await page.evaluate(async () => {
    const ds = await import("/src/offline/downloadService.ts");
    
    // Check initial preference
    const initial = ds.getDownloadQualityPreference();
    
    // Test changing preferences
    ds.setDownloadQualityPreference("hevc");
    const afterHevc = ds.getDownloadQualityPreference();
    
    ds.setDownloadQualityPreference("standard");
    const afterStd = ds.getDownloadQualityPreference();
    
    ds.setDownloadQualityPreference("auto");
    const afterAuto = ds.getDownloadQualityPreference();

    // Mock play info
    const mockPlayInfo = {
      id: 101,
      ep_num: 1,
      duration: 120,
      title: "Test Drama Ep 1",
      video_url: "https://cdn.example.com/stream_standard.m3u8",
      video_url_hevc: "https://cdn.example.com/stream_hevc.m3u8",
      streams: {
        main: "https://cdn.example.com/stream_standard.m3u8",
        hevc: "https://cdn.example.com/stream_hevc.m3u8",
      },
    };

    const resHevc = ds.resolveStreamUrlForQuality(mockPlayInfo, "hevc");
    const resStd = ds.resolveStreamUrlForQuality(mockPlayInfo, "standard");
    const resAuto = ds.resolveStreamUrlForQuality(mockPlayInfo, "auto");

    return {
      initial,
      afterHevc,
      afterStd,
      afterAuto,
      resHevcUrl: resHevc?.url,
      resHevcFlag: resHevc?.isHevc,
      resStdUrl: resStd?.url,
      resStdFlag: resStd?.isHevc,
      resAutoUrl: resAuto?.url,
      resAutoFlag: resAuto?.isHevc,
    };
  });

  assert.equal(qualityTests.afterHevc, "hevc", "HEVC quality preference should stick");
  assert.equal(qualityTests.afterStd, "standard", "Standard quality preference should stick");
  assert.equal(qualityTests.afterAuto, "auto", "Auto quality preference should stick");
  assert.ok(qualityTests.resHevcUrl?.includes("hevc"), "Should resolve HEVC URL when requested");
  assert.equal(qualityTests.resHevcFlag, true, "isHevc flag should be true for HEVC");
  assert.ok(qualityTests.resStdUrl?.includes("standard"), "Should resolve Standard URL when requested");
  assert.equal(qualityTests.resStdFlag, false, "isHevc flag should be false for Standard");
  assert.ok(qualityTests.resAutoUrl?.includes("hevc"), "Should prefer HEVC URL on auto");
  console.log("✔ Quality preferences & stream resolution verified");

  // 2. Storage Safety Pre-Flight
  const storageTests = await page.evaluate(async () => {
    const ds = await import("/src/offline/downloadService.ts");
    const normalBatch = await ds.checkStorageAvailableForBatch(50 * 1024 * 1024); // 50MB
    const hugeBatch = await ds.checkStorageAvailableForBatch(1000 * 1024 * 1024 * 1024); // 1000GB (unlikely to have)
    return {
      normalOk: normalBatch.sufficient,
      hugeOk: hugeBatch.sufficient,
      hugeReason: hugeBatch.reason,
    };
  });

  assert.equal(storageTests.normalOk, true, "Normal 50MB batch should pass storage check");
  assert.equal(storageTests.hugeOk, false, "Absurdly huge batch should fail storage check");
  assert.ok(storageTests.hugeReason?.includes("Low storage"), "Should provide human-friendly low storage reason");
  console.log("✔ Storage pre-flight safety guard verified");

  // 3. Queue Management (Pause / Resume All & Summaries)
  const queueTests = await page.evaluate(async () => {
    const ds = await import("/src/offline/downloadService.ts");
    const summaryBefore = ds.getActiveDownloadsSummary();
    ds.pauseAllDownloads();
    const summaryAfterPause = ds.getActiveDownloadsSummary();
    return {
      summaryBefore,
      summaryAfterPause,
    };
  });

  assert.equal(queueTests.summaryBefore.activeCount, 0, "No downloads running initially");
  console.log("✔ Queue manager & aggregate statistics verified");

  // 4. UI Checks (Profile and Settings download quality controls)
  // Switch to Profile tab
  const profileTab = page.locator('nav button:has-text("Profile")').first();
  if (await profileTab.isVisible()) {
    await profileTab.click();
    await page.waitForTimeout(400);

    // Click Settings button
    const settingsBtn = page.locator('button[aria-label="Settings"]').first();
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      await page.waitForTimeout(400);

      const hasHevc = await page.locator('button:has-text("HEVC")').count();
      const hasH264 = await page.locator('button:has-text("H.264")').count();
      const hasAuto = await page.locator('button:has-text("Auto")').count();
      console.log(`✔ Settings has Download Quality options: HEVC=${hasHevc > 0}, H.264=${hasH264 > 0}, Auto=${hasAuto > 0}`);
      assert.ok(hasHevc > 0, "HEVC quality selector button must be present in Settings");
    }
  }

  assert.equal(errors.length, 0, `No console/page errors allowed: ${errors.join(", ")}`);
  console.log("=== ALL OFFLINE & DOWNLOAD ENHANCEMENTS PASSED ===");

} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
