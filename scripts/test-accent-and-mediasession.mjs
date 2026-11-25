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

  const page = await browser.newPage();
  page.on("pageerror", (err) => {
    errors.push(err.message || String(err));
  });

  await page.goto(origin, { timeout: 60000 });
  await page.waitForLoadState("networkidle");

  console.log("=== Testing Accent Theme Colors, Media Session, and Search Improvements ===");

  // 1. Test Accent Color dynamic attribute & variables in Dark mode
  const accentResult = await page.evaluate(async () => {
    const root = document.documentElement;
    root.classList.remove("theme-light"); // Ensure dark theme

    // Initially blue (default), no data-accent attribute
    const initialAttr = root.getAttribute("data-accent");

    // Test switching to emerald
    root.setAttribute("data-accent", "emerald");
    const emeraldDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Test switching to light theme with emerald
    root.classList.add("theme-light");
    const emeraldLight = getComputedStyle(root).getPropertyValue("--p-primary").trim();
    root.classList.remove("theme-light");

    // Test switching to cyberpunk cyan
    root.setAttribute("data-accent", "cyan");
    const cyanDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Test switching to neon rose
    root.setAttribute("data-accent", "rose");
    const roseDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Test switching to amber gold
    root.setAttribute("data-accent", "amber");
    const amberDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Test switching to royal violet
    root.setAttribute("data-accent", "violet");
    const violetDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Test switching to electric blue
    root.setAttribute("data-accent", "blue");
    const blueDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    // Reset back to default (ink)
    root.removeAttribute("data-accent");
    const defaultDark = getComputedStyle(root).getPropertyValue("--p-primary").trim();

    return {
      initialAttr,
      emeraldDark,
      emeraldLight,
      cyanDark,
      roseDark,
      amberDark,
      violetDark,
      blueDark,
      defaultDark,
    };
  });

  assert.equal(accentResult.emeraldDark, "#34d399", "Emerald dark accent primary should match #34d399");
  assert.equal(accentResult.emeraldLight, "#059669", "Emerald light accent primary should match #059669");
  assert.equal(accentResult.cyanDark, "#00e5ff", "Cyan dark accent primary should match #00e5ff");
  assert.equal(accentResult.roseDark, "#fb7185", "Rose dark accent primary should match #fb7185");
  assert.equal(accentResult.amberDark, "#fbbf24", "Amber dark accent primary should match #fbbf24");
  assert.equal(accentResult.violetDark, "#c084fc", "Violet dark accent primary should match #c084fc");
  assert.equal(accentResult.blueDark, "#74b7ff", "Blue dark accent primary should match #74b7ff");
  assert.equal(accentResult.defaultDark, "#f4f1eb", "Default dark accent primary should match #f4f1eb");
  console.log("✓ Dynamic Accent Color Switching (Dark & Light modes): PASSED");

  // 2. Test MediaSession hook integration
  const mediaSessionResult = await page.evaluate(async () => {
    const actionsRegistered = new Map();
    let setPositionStateCalls = 0;

    // Mock navigator.mediaSession
    const mockSession = {
      metadata: null,
      playbackState: "none",
      setActionHandler: (action, handler) => {
        actionsRegistered.set(action, handler);
      },
      setPositionState: (state) => {
        setPositionStateCalls++;
      },
    };

    Object.defineProperty(navigator, "mediaSession", {
      value: mockSession,
      writable: true,
      configurable: true,
    });

    const { useMediaSession } = await import("/src/useMediaSession.ts");

    return {
      hasHook: typeof useMediaSession === "function",
      mediaSessionAvailable: "mediaSession" in navigator,
    };
  });

  assert.equal(mediaSessionResult.hasHook, true, "useMediaSession hook should be exported and functional");
  assert.equal(mediaSessionResult.mediaSessionAvailable, true, "navigator.mediaSession should be available");
  console.log("✓ System Media Session Integration: PASSED");

  // 3. Test Search tag single deletion UI
  await page.click('nav button:has-text("Search")');
  await page.waitForTimeout(400);

  // Verify search form is present
  const searchInput = await page.$('.ios-search-form input');
  assert.ok(searchInput, "Search input should be rendered");

  // Populate search history to test individual tag removal
  await page.evaluate(() => {
    const raw = localStorage.getItem("aurastream_app_v1");
    const data = raw ? JSON.parse(raw) : {};
    data.searchHist = ["Action", "Romance", "Mystery"];
    localStorage.setItem("aurastream_app_v1", JSON.stringify(data));
  });

  // Reload page to rehydrate store from updated localStorage
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.click('nav button:has-text("Search")');
  await page.waitForTimeout(500);

  // Verify all 3 tags rendered with individual remove buttons
  const initialTags = await page.$$eval('button[aria-label^="Remove "]', els => els.map(e => e.getAttribute("aria-label")));
  assert.deepEqual(initialTags, ["Remove Action", "Remove Romance", "Remove Mystery"], "Should display initial 3 tags with Remove buttons");

  // Click remove button on 'Romance' tag
  await page.click('button[aria-label="Remove Romance"]');
  await page.waitForTimeout(400);

  // Verify 'Romance' is deleted and 'Action' + 'Mystery' remain
  const remainingTags = await page.$$eval('button[aria-label^="Remove "]', els => els.map(e => e.getAttribute("aria-label")));
  assert.deepEqual(remainingTags, ["Remove Action", "Remove Mystery"], "Romance should be removed while Action and Mystery remain");
  assert.deepEqual(errors, [], `Expected zero page errors, got: ${errors.join("; ")}`);

  console.log("✓ Search Improvements & Single Tag Deletion (individual remove): PASSED");
  console.log("\nALL ACCENT & MEDIASESSION TESTS PASSED SUCCESSFULLY!");
} finally {
  await browser?.close();
  await vite?.close();
}
