import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
let vite, browser;
const errors = [];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

function walkSourceFiles(dir, extRe, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, extRe, out);
    else if (extRe.test(entry.name)) out.push(full);
  }
  return out;
}

try {
  // 1. Static source checks (zero voice dubbing, repo-wide zero-emoji scan)
  for (const absPath of [
    ...walkSourceFiles(path.join(root, "src"), /\.(ts|tsx|css)$/),
    ...walkSourceFiles(path.join(root, "src-tauri/android-src"), /\.(kt|xml)$/),
  ]) {
    const content = fs.readFileSync(absPath, "utf8");
    const rel = path.relative(root, absPath);
    assert.equal(EMOJI_RE.test(content), false, `Emoji found in ${rel}`);
  }
  const uiFilesToCheck = [
    "src/components/UpdateModal.tsx",
    "src/components/LoginModal.tsx",
    "src/components/BatchDownloadSheet.tsx",
    "src/components/DownloadChoiceSheet.tsx",
    "src/components/ExportSheet.tsx",
    "src/pages/Settings.tsx",
    "src/pages/Profile.tsx",
    "src/components/Feed.tsx",
  ];
  for (const rel of uiFilesToCheck) {
    const content = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(/voiceDub/i.test(content), false, `Leftover voiceDub found in ${rel}`);
  }
  for (const removedRel of [
    "src/subtitles/voiceDubService.ts",
    "src/components/SubtitleSheet.tsx",
    "src/components/SubtitleOverlay.tsx",
    "src/subtitles/aiSubtitleService.ts",
    "src/subtitles/translator.ts",
    "src/subtitles/tsAudioExtractor.ts",
    "src/subtitles/vttParser.ts",
    "src/subtitles/types.ts",
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, removedRel)),
      false,
      `${removedRel} must be deleted`
    );
  }
  const feedSrc = fs.readFileSync(path.join(root, "src/components/Feed.tsx"), "utf8");
  assert.equal(/SubtitleOverlay|SubtitleSheet|CC Off/.test(feedSrc), false, "Feed.tsx must not render CC controls");
  for (const playerRel of ["src/components/VideoSurface.tsx", "src/components/Player.tsx"]) {
    const playerSrc = fs.readFileSync(path.join(root, playerRel), "utf8");
    assert.equal(/enableWebVTT|enableCEA708Captions|SUBTITLE_TRACKS_UPDATED/.test(playerSrc), false, `${playerRel} must disable HLS caption parsing`);
  }
  console.log("PASS: Static zero-emoji, zero-voiceDub, and complete CC removal checks passed");

  // 2. Runtime browser tests against Vite modules
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  vite = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];

  const exe = process.env.BROWSER_EXECUTABLE || ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
  browser = await chromium.launch({ headless: true, executablePath: exe });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });

  await context.addInitScript(() => {
    window.__playCalls = 0;
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        invoke(cmd) {
          if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
          if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
          if (cmd === "debug_log") return Promise.resolve();
          if (cmd === "api_play") {
            window.__playCalls++;
            return Promise.resolve({ video_url: "https://cdn.invalid/stream.m3u8" });
          }
          return Promise.resolve({ items: [], pagination: { page: 1, pages: 1, size: 8, total: 0 } });
        },
      },
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message || String(err)));
  await page.goto(origin, { timeout: 60000 });
  await page.waitForLoadState("networkidle");

  const results = await page.evaluate(async (ver) => {
    const otaMod = await import("/src/otaUpdater.ts");
    const dlMod = await import("/src/offline/downloadService.ts");
    const tmpMod = await import("/src/playback/tempCacheService.ts");
    const stMod = await import("/src/storage.ts");
    const fbMod = await import("/src/firebase.ts");
    const apiMod = await import("/src/api.ts");
    const pfMod = await import("/src/playbackFeatures.ts");
    const dtMod = await import("/src/dramaTranslator.ts");

    const translatedTitle = dtMod.formatDramaTitle("50元买断人妻");

    // E. OTA ABI asset resolution + fallback release URLs
    const rateLimitedInfo = {
      current: "0.1.29",
      latest: ver,
      tag: `v${ver}`,
      has_update: true,
      url: `https://github.com/cozgams/AuraStream/releases/tag/v${ver}`,
      asset: null,
    };
    const arm64Asset = otaMod.resolveBestUpdateAsset(rateLimitedInfo, "arm64");
    const armAsset = otaMod.resolveBestUpdateAsset(rateLimitedInfo, "arm");
    const x86Asset = otaMod.resolveBestUpdateAsset(rateLimitedInfo, "x86_64");
    const multiAssetInfo = {
      current: "0.1.54",
      latest: "0.1.55",
      tag: "v0.1.55",
      has_update: true,
      url: "https://github.com/cozgams/AuraStream/releases/tag/v0.1.55",
      asset: { name: "AuraStream_0.1.55_arm.apk", url: "https://github.com/cozgams/AuraStream/releases/download/v0.1.55/AuraStream_0.1.55_arm.apk", size: 11800000 },
      assets: [
        { name: "AuraStream_0.1.55_arm.apk", url: "https://github.com/cozgams/AuraStream/releases/download/v0.1.55/AuraStream_0.1.55_arm.apk", size: 11800000 },
        { name: "AuraStream_0.1.55_arm64.apk", url: "https://github.com/cozgams/AuraStream/releases/download/v0.1.55/AuraStream_0.1.55_arm64.apk", size: 14400000 },
        { name: "AuraStream_0.1.55_x86_64.apk", url: "https://github.com/cozgams/AuraStream/releases/download/v0.1.55/AuraStream_0.1.55_x86_64.apk", size: 15200000 },
      ],
    };
    const exactArm64Asset = otaMod.resolveBestUpdateAsset(multiAssetInfo, "arm64");

    // E2. OTA runtime state transitions & cached APK check
    const origNativeBridge = window.AuraNativeExport;
    window.AuraNativeExport = {
      isAvailable: () => true,
      beginExport: () => true,
      writeChunk: () => true,
      finishExport: () => "",
      canInstallPackages: () => true,
      startOtaDownload: () => true,
      cancelOtaDownload: () => true,
      installDownloadedApk: () => "STARTED",
      getCachedOtaApkInfo: (name) =>
        name.includes("arm64")
          ? JSON.stringify({ ready: true, filePath: `/data/cache/updates/${name}`, size: 14400000 })
          : JSON.stringify({ ready: false }),
    };
    const cachedArm64 = otaMod.getCachedOtaApk("AuraStream_0.1.57_arm64.apk", 14400000);
    otaMod.startOtaUpdateDownload(
      "https://github.com/cozgams/AuraStream/releases/download/v0.1.57/AuraStream_0.1.57_arm.apk",
      "AuraStream_0.1.57_arm.apk",
      11800000
    );
    window.dispatchEvent(
      new CustomEvent("aurastream:ota-progress", {
        detail: { status: "downloading", progress: 45, downloadedBytes: 5310000, totalBytes: 11800000, speedBytesPerSec: 1024000 },
      })
    );
    const midOtaState = otaMod.getOtaRuntimeState();
    window.dispatchEvent(
      new CustomEvent("aurastream:ota-progress", {
        detail: { status: "downloaded", progress: 100, downloadedBytes: 11800000, totalBytes: 11800000, filePath: "/data/cache/updates/AuraStream_0.1.57_arm.apk" },
      })
    );
    const readyOtaState = otaMod.getOtaRuntimeState();
    otaMod.cancelOtaUpdateDownload();
    const cancelledOtaState = otaMod.getOtaRuntimeState();
    window.AuraNativeExport = origNativeBridge;

    // F. Offline zero-internet safeguards: Smart Download defaults OFF & preloadEpisode skips downloaded ep
    const smartDefault = dlMod.isSmartDownloadEnabled();
    stMod.writeStorage(
      stMod.STORAGE_KEYS.downloads,
      JSON.stringify([
        {
          id: "55555_1",
          videoId: 55555,
          episode: 1,
          title: "Offline Test Show",
          cover: "",
          sizeBytes: 1234567,
          downloadedAt: Date.now(),
          storage: "native",
        },
      ])
    );
    const preloadedDownloaded = await tmpMod.preloadEpisode(55555, 1, { maxSegments: 3 });

    // G. Firebase & Account Vault zero-error Sign Up / Sign In / Cloud Sync / Reset
    const createdUser = await fbMod.signUpWithEmail("aaa@gmail.com", "123456", "A");
    await fbMod.saveUserDataToCloud(createdUser.uid, { favorites: [101, 202] });
    const cloudSnap = await fbMod.fetchCloudUserData(createdUser.uid);
    await fbMod.logOutFirebase();
    const signedInUser = await fbMod.signInWithEmail("aaa@gmail.com", "123456");
    let wrongPassBlocked = false;
    try {
      await fbMod.signInWithEmail("aaa@gmail.com", "wrongpass");
    } catch (e) {
      wrongPassBlocked = e?.code === "auth/wrong-password";
    }
    await fbMod.sendPasswordReset("aaa@gmail.com");
    const signedInAfterReset = await fbMod.signInWithEmail("aaa@gmail.com", "newpass123");
    await fbMod.logOutFirebase();

    let duplicateSignupBlocked = false;
    try {
      await fbMod.signUpWithEmail("aaa@gmail.com", "123456", "Dup");
    } catch (e) {
      duplicateSignupBlocked = e?.code === "auth/email-already-in-use";
    }

    // H. Fractional duration formatting & sleep timer 0s expiration notification
    const formattedDur = apiMod.dur(125.4);
    let sleepRemAtExpire = -1;
    let sleepTriggeredCount = 0;
    let scheduledTimerCb = null;
    const origSetTimeout = window.setTimeout.bind(window);
    const timerEvents = [];
    const unsubSleep = pfMod.subscribeSleepTimer((rem) => {
      timerEvents.push(rem);
    });
    try {
      window.setTimeout = ((cb, ms, ...args) => {
        if (typeof cb === "function" && Number(ms) === 15 * 60 * 1000) {
          scheduledTimerCb = () => cb(...args);
          return 999991;
        }
        return origSetTimeout(cb, ms, ...args);
      });
      pfMod.setSleepTimer("15", () => {
        sleepTriggeredCount++;
      });
      if (scheduledTimerCb) scheduledTimerCb();
      sleepRemAtExpire = timerEvents[timerEvents.length - 1] ?? -1;
    } finally {
      window.setTimeout = origSetTimeout;
      unsubSleep();
      pfMod.setSleepTimer("off");
    }

    // I. Download error sanitization (no leaked upstream URLs)
    const errTimeout = dlMod.formatDownloadError(
      "error sending request for url (https://tp7.qnlycc.cn/videos5/secret?auth_key=xyz): client error (Connect) <- operation timed out"
    );
    const errDns = dlMod.formatDownloadError("DNS resolution timed out for cdn.example");

    return {
      translatedTitle,
      arm64Url: arm64Asset?.url,
      armUrl: armAsset?.url,
      x86Url: x86Asset?.url,
      exactArm64Size: exactArm64Asset?.size,
      cachedArm64Ready: cachedArm64.ready,
      cachedArm64Path: cachedArm64.filePath,
      midOtaStage: midOtaState.stage,
      midOtaProgress: midOtaState.progress,
      readyOtaStage: readyOtaState.stage,
      cancelledOtaStage: cancelledOtaState.stage,
      smartDefault,
      preloadedDownloaded,
      playCalls: window.__playCalls,
      createdEmail: createdUser?.email,
      createdName: createdUser?.displayName,
      cloudFavs: cloudSnap?.data?.favorites,
      signedInName: signedInUser?.displayName,
      wrongPassBlocked,
      resetOk: Boolean(signedInAfterReset?.uid),
      duplicateSignupBlocked,
      formattedDur,
      sleepRemAtExpire,
      sleepTriggeredCount,
      errTimeout,
      errDns,
    };
  }, pkgVersion);

  assert.equal(results.translatedTitle, "The Billion Contract Bride", "dramaTranslator must preserve English UI drama titles");
  assert.equal(
    results.arm64Url,
    `https://github.com/cozgams/AuraStream/releases/download/v${pkgVersion}/AuraStream_${pkgVersion}_arm64.apk`
  );
  assert.equal(
    results.armUrl,
    `https://github.com/cozgams/AuraStream/releases/download/v${pkgVersion}/AuraStream_${pkgVersion}_arm.apk`
  );
  assert.equal(
    results.x86Url,
    `https://github.com/cozgams/AuraStream/releases/download/v${pkgVersion}/AuraStream_${pkgVersion}_x86_64.apk`
  );
  assert.equal(results.exactArm64Size, 14400000, "Multi-ABI release asset list must preserve exact APK byte size");
  assert.equal(results.cachedArm64Ready, true, "Cached verified APK check must report ready=true");
  assert.equal(results.cachedArm64Path, "/data/cache/updates/AuraStream_0.1.57_arm64.apk");
  assert.equal(results.midOtaStage, "downloading");
  assert.equal(results.midOtaProgress, 45);
  assert.equal(results.readyOtaStage, "ready");
  assert.equal(results.cancelledOtaStage, "idle");
  assert.equal(results.smartDefault, false, "Smart Auto-Download must default OFF to save data");
  assert.equal(results.preloadedDownloaded, false, "preloadEpisode must skip already-downloaded episodes");
  assert.equal(results.playCalls, 0, "preloadEpisode must make 0 api.play calls for downloaded episodes");
  assert.equal(results.createdEmail, "aaa@gmail.com");
  assert.equal(results.createdName, "A");
  assert.deepEqual(results.cloudFavs, [101, 202]);
  assert.equal(results.signedInName, "A");
  assert.equal(results.wrongPassBlocked, true);
  assert.equal(results.resetOk, true);
  assert.equal(results.duplicateSignupBlocked, true, "Duplicate Account Vault signup must throw auth/email-already-in-use");
  assert.equal(results.formattedDur, "2:05", "dur(125.4) must floor seconds cleanly");
  assert.equal(results.sleepRemAtExpire, 0, "Sleep timer expiration must notify 0 remaining seconds");
  assert.equal(results.sleepTriggeredCount, 1, "Sleep timer callback must trigger once on expiration");
  assert.equal(results.errTimeout, "Connection timed out. Tap Retry to resume.");
  assert.equal(results.errDns, "Network DNS timed out. Check connection and tap Retry.");
  assert.equal(results.errTimeout.includes("https://"), false, "Sanitized download error must not leak URLs");
  assert.equal(errors.length, 0, `Unexpected page errors: ${errors.join("; ")}`);

  console.log("PASS: Complete CC removal, OTA ABI routing, Firebase Account Vault, sleep timer, dur(), zero-emoji & zero-internet preload tests PASSED");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
