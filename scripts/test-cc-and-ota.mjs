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
    "src/components/SubtitleSheet.tsx",
    "src/components/SubtitleOverlay.tsx",
    "src/components/BatchDownloadSheet.tsx",
    "src/components/DownloadChoiceSheet.tsx",
    "src/pages/Settings.tsx",
    "src/pages/Profile.tsx",
    "src/components/Feed.tsx",
  ];
  for (const rel of uiFilesToCheck) {
    const content = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(/voiceDub/i.test(content), false, `Leftover voiceDub found in ${rel}`);
  }
  assert.equal(
    fs.existsSync(path.join(root, "src/subtitles/voiceDubService.ts")),
    false,
    "voiceDubService.ts must be deleted"
  );
  const aiSubSrc = fs.readFileSync(path.join(root, "src/subtitles/aiSubtitleService.ts"), "utf8");
  assert.ok(/import\s*\{[^}]*\bisLocalMedia\b[^}]*\}\s*from\s*["']\.\.\/api["']/.test(aiSubSrc), "aiSubtitleService.ts must import isLocalMedia");
  assert.ok((aiSubSrc.match(/isLocalMedia\(/g) || []).length >= 2, "aiSubtitleService.ts must guard both collectEpisodeMediaForAI and getSubtitlesForEpisode with isLocalMedia");
  assert.ok(aiSubSrc.includes("navigator.onLine === false"), "aiSubtitleService.ts must skip remote HLS inspection when offline");
  console.log("PASS: Static zero-emoji and zero-voiceDub checks passed");

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
    const vttMod = await import("/src/subtitles/vttParser.ts");
    const subMod = await import("/src/subtitles/aiSubtitleService.ts");
    const tsMod = await import("/src/subtitles/tsAudioExtractor.ts");
    const otaMod = await import("/src/otaUpdater.ts");
    const dlMod = await import("/src/offline/downloadService.ts");
    const tmpMod = await import("/src/playback/tempCacheService.ts");
    const stMod = await import("/src/storage.ts");
    const fbMod = await import("/src/firebase.ts");
    const apiMod = await import("/src/api.ts");
    const pfMod = await import("/src/playbackFeatures.ts");

    // A. parseVtt: 2-line English cue preservation & ASS tag stripping
    const srt = "1\n00:00:01,000 --> 00:00:03,500\n{\\an8}First line of dialogue\nSecond line of dialogue\n";
    const parsedCues = vttMod.parseVtt(srt);

    // B. formatBalancedCaptionLines
    const wrapped = vttMod.formatBalancedCaptionLines(
      "This is a deliberately long English subtitle sentence that should wrap evenly into two balanced lines on mobile.",
      42
    );

    // C. Honest CC: no procedural fallback cues
    const emptyTrack = await subMod.getSubtitlesForEpisode(987654, 1, "My Five Elder Sisters");

    // D. Import + Remove subtitle track round-trip
    const imported = subMod.importSubtitleTextForEpisode(987654, 2, srt, "test.srt");
    const fetchedAfterImport = await subMod.getSubtitlesForEpisode(987654, 2, "My Five Elder Sisters");
    subMod.removeSubtitleTrackForEpisode(987654, 2);
    const fetchedAfterRemove = await subMod.getSubtitlesForEpisode(987654, 2, "My Five Elder Sisters");

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

    // I. MPEG-TS AAC extraction, WAV 16k encoding, .ASS parsing, Chinese SRT preservation, AI provider persistence, and Download error sanitization
    const makeTsPacket = (pid, payloadUnitStart, payloadBytes) => {
      const pkt = new Uint8Array(188).fill(0xff);
      pkt[0] = 0x47;
      pkt[1] = (payloadUnitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f);
      pkt[2] = pid & 0xff;
      pkt[3] = 0x10;
      pkt.set(payloadBytes.slice(0, 184), 4);
      return pkt;
    };
    const patSection = [0x00, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0x00, 0x00, 0x00, 0x00];
    const pmtSection = [0x00, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x0f, 0xe1, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00];
    const expectedAac = [0xff, 0xf1, 0x50, 0x80, 0x02, 0x00, 0xfc, 0xde, 0xad, 0xbe, 0xef];
    const pesAudio = [0x00, 0x00, 0x01, 0xc0, 0x00, 0x00, 0x80, 0x00, 0x00, ...expectedAac];
    const tsStream = new Uint8Array(188 * 3);
    tsStream.set(makeTsPacket(0x0000, true, patSection), 0);
    tsStream.set(makeTsPacket(0x0100, true, pmtSection), 188);
    tsStream.set(makeTsPacket(0x0101, true, pesAudio), 376);
    const tsDetected = tsMod.isMpegTs(tsStream);
    const nonTsDetected = tsMod.isMpegTs(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    const extractedAac = Array.from(tsMod.extractAacFromTs(tsStream).slice(0, expectedAac.length));

    const wavBlob = tsMod.encodeSamplesToWav16k(new Float32Array([0, 0.5, -0.5, 0.25]), 48000);
    const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
    const wavHeader = String.fromCharCode(...wavBytes.slice(0, 4)) + String.fromCharCode(...wavBytes.slice(8, 12));

    const assContent = "[Script Info]\nTitle: Test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.50,0:00:04.20,Default,,0,0,0,,{\\an8\\i1}Hello{\\i0}\\NWorld!\n";
    const assCues = vttMod.parseVtt(assContent);

    const zhSrt = "1\n00:00:01,000 --> 00:00:03,000\n我永远不会放弃你。\n";
    const zhCues = vttMod.parseVtt(zhSrt);

    subMod.setAICaptionConfig({
      provider: "groq",
      groqKey: "gsk_test_key",
      customUrl: "https://custom.invalid/v1/audio/translations",
      customModel: "whisper-large-v3",
    });
    const savedAiCfg = subMod.getAICaptionConfig();

    const errTimeout = dlMod.formatDownloadError(
      "error sending request for url (https://tp7.qnlycc.cn/videos5/secret?auth_key=xyz): client error (Connect) <- operation timed out"
    );
    const errDns = dlMod.formatDownloadError("DNS resolution timed out for cdn.example");

    return {
      parsedCount: parsedCues.length,
      parsedEn: parsedCues[0]?.en,
      wrappedLines: wrapped.split("\n"),
      emptySource: emptyTrack.source,
      emptyCuesLen: emptyTrack.cues.length,
      importedSource: imported.source,
      importedFileName: imported.fileName,
      fetchedImportedLen: fetchedAfterImport.cues.length,
      fetchedRemovedSource: fetchedAfterRemove.source,
      arm64Url: arm64Asset?.url,
      armUrl: armAsset?.url,
      x86Url: x86Asset?.url,
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
      tsDetected,
      nonTsDetected,
      extractedAac,
      expectedAac,
      wavSize: wavBlob.size,
      wavType: wavBlob.type,
      wavHeader,
      assCount: assCues.length,
      assStart: assCues[0]?.start,
      assEnd: assCues[0]?.end,
      assEn: assCues[0]?.en,
      zhEn: zhCues[0]?.en,
      savedAiCfg,
      errTimeout,
      errDns,
    };
  }, pkgVersion);

  assert.equal(results.parsedCount, 1);
  assert.ok(results.parsedEn.includes("First line of dialogue"), "Line 1 preserved");
  assert.ok(results.parsedEn.includes("Second line of dialogue"), "Line 2 preserved (not treated as zh)");
  assert.equal(results.parsedEn.includes("{\\an8}"), false, "ASS tags stripped");
  assert.ok(results.wrappedLines.length <= 2, "Wrapped into <= 2 balanced lines");
  assert.equal(results.emptySource, "none", "No procedural fake captions");
  assert.equal(results.emptyCuesLen, 0, "Empty cues when no real track exists");
  assert.equal(results.importedSource, "local_import");
  assert.equal(results.importedFileName, "test.srt");
  assert.equal(results.fetchedImportedLen, 1);
  assert.equal(results.fetchedRemovedSource, "none");
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
  assert.equal(results.tsDetected, true, "isMpegTs must detect 188-byte sync packets");
  assert.equal(results.nonTsDetected, false, "isMpegTs must reject non-TS buffers");
  assert.deepEqual(results.extractedAac, results.expectedAac, "extractAacFromTs must recover exact ADTS AAC bytes");
  assert.equal(results.wavType, "audio/wav", "encodeSamplesToWav16k must set audio/wav MIME");
  assert.equal(results.wavHeader, "RIFFWAVE", "WAV must contain valid RIFF/WAVE header");
  assert.ok(results.wavSize > 44, "WAV must contain PCM samples beyond 44-byte header");
  assert.equal(results.assCount, 1, "parseVtt must auto-parse .ASS Dialogue cues");
  assert.equal(results.assStart, 1.5);
  assert.equal(results.assEnd, 4.2);
  assert.equal(results.assEn, "Hello\nWorld!", "ASS override tags stripped and \\N converted to newline");
  assert.equal(results.zhEn, "我永远不会放弃你。", "Monolingual Chinese subtitles must stay intact without CHAR_MAP corruption");
  assert.equal(results.savedAiCfg.provider, "groq");
  assert.equal(results.savedAiCfg.groqKey, "gsk_test_key");
  assert.equal(results.savedAiCfg.customUrl, "https://custom.invalid/v1/audio/translations");
  assert.equal(results.savedAiCfg.customModel, "whisper-large-v3");
  assert.equal(results.errTimeout, "Connection timed out. Tap Retry to resume.");
  assert.equal(results.errDns, "Network DNS timed out. Check connection and tap Retry.");
  assert.equal(results.errTimeout.includes("https://"), false, "Sanitized download error must not leak URLs");
  assert.equal(errors.length, 0, `Unexpected page errors: ${errors.join("; ")}`);

  console.log("PASS: CC parsing, honest empty CC, OTA ABI routing, Firebase Account Vault, sleep timer, dur(), zero-emoji & zero-internet preload tests PASSED");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
