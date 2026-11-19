import fs from 'fs';

async function run() {
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    console.error("No active page target found");
    process.exit(1);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = idCounter++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise(r => ws.addEventListener('open', r));
  console.log("Connected to live AuraStream CDP on Android VM!");

  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshotWithVideo = async (filename) => {
    // Inject canvas capturing current video frame if video is present
    await evalCode(`(() => {
      const v = document.querySelector("video");
      if (!v) return;
      let canvas = document.getElementById("__video_frame_capture");
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.id = "__video_frame_capture";
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        canvas.style.zIndex = "2";
        canvas.style.pointerEvents = "none";
        v.parentElement.insertBefore(canvas, v.nextSibling);
      }
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      const ctx = canvas.getContext("2d");
      try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch {}
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${filename}`;
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${filename}`);

    await evalCode(`(() => { document.getElementById("__video_frame_capture")?.remove(); })()`);
  };

  // ==========================================
  // TEST 1: HOME FEED PLAYBACK & DRAMA METADATA
  // ==========================================
  console.log("\n--- TEST 1: Home Feed Real Drama ---");
  await evalCode(`(() => {
    const home = Array.from(document.querySelectorAll(".ios-mobile-nav-item")).find(i => i.textContent.includes("Home"));
    if (home) home.click();
  })()`);
  await wait(1500);

  const homeDramaInfo = await evalCode(`(() => {
    const v = document.querySelector("video");
    const titleEl = document.querySelector(".ios-video-title, [class*=title], h2, h1");
    const descEl = document.querySelector("[class*=desc]");
    const epBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Episodes"));
    const subtitleEl = document.querySelector("[class*=subtitle], [class*=caption]");
    return {
      title: titleEl?.textContent?.trim() || "Unknown Drama",
      hasVideo: !!v,
      currentTime: v?.currentTime || 0,
      duration: v?.duration || 0,
      videoWidth: v?.videoWidth || 0,
      videoHeight: v?.videoHeight || 0,
      hasEpisodesBtn: !!epBtn,
      subtitlePreview: subtitleEl?.textContent?.trim() || null,
    };
  })()`);
  console.log("Home Drama playback:", homeDramaInfo);
  await takeScreenshotWithVideo("aurastream_live_real_drama_home.png");

  // ==========================================
  // TEST 2: EPISODES SHEET (DRAWER)
  // ==========================================
  console.log("\n--- TEST 2: Episodes Drawer & Episode Grid ---");
  const openEpisodesRes = await evalCode(`(() => {
    const epBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Episodes"));
    if (epBtn) { epBtn.click(); return true; }
    return false;
  })()`);
  console.log("Opened episodes sheet:", openEpisodesRes);
  await wait(1200);

  const episodesSheetInfo = await evalCode(`(() => {
    const episodes = Array.from(document.querySelectorAll("button")).filter(b => /^(Ep\\s*\\d+|\\d+)$/.test(b.textContent?.trim()));
    const sheetTitle = document.querySelector(".ios-sheet h2, .ios-sheet h3, .ios-dialog h2, .text-on")?.textContent?.trim();
    return {
      episodePillsCount: episodes.length,
      samplePills: episodes.slice(0, 10).map(b => b.textContent?.trim()),
      sheetTitle,
    };
  })()`);
  console.log("Episodes sheet info:", episodesSheetInfo);
  await takeScreenshotWithVideo("aurastream_live_real_drama_episodes.png");

  // Close sheet by clicking overlay or back
  await evalCode(`(() => {
    const closeBtn = document.querySelector(".ios-overlay-sheet, .ios-sheet-close, [aria-label='Close']");
    if (closeBtn) closeBtn.click();
    else {
      const backdrop = document.querySelector(".ios-overlay-sheet");
      if (backdrop) backdrop.click();
    }
  })()`);
  await wait(800);

  // ==========================================
  // TEST 3: CATEGORIES TAB & REAL DRAMA MASONRY
  // ==========================================
  console.log("\n--- TEST 3: Categories & Channels ---");
  await evalCode(`(() => {
    const cat = Array.from(document.querySelectorAll(".ios-mobile-nav-item")).find(i => i.textContent.includes("Categor"));
    if (cat) cat.click();
  })()`);
  await wait(2000);

  const catData = await evalCode(`(() => {
    const cards = Array.from(document.querySelectorAll(".media-card, [class*=media-card], .ios-card, img"));
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, .text-on")).map(h => h.textContent.trim()).filter(Boolean);
    const dramaCovers = Array.from(document.querySelectorAll("img")).map(img => img.src).filter(src => src.includes("http"));
    return {
      totalCards: cards.length,
      dramaCoversCount: dramaCovers.length,
      sampleDramaCovers: dramaCovers.slice(0, 5),
      headings: headings.slice(0, 15),
    };
  })()`);
  console.log("Category dramas loaded:", catData);
  await takeScreenshotWithVideo("aurastream_live_real_drama_categories.png");

  // ==========================================
  // TEST 4: SEARCH TAB & HOT DRAMAS
  // ==========================================
  console.log("\n--- TEST 4: Search & Trending Dramas ---");
  await evalCode(`(() => {
    const search = Array.from(document.querySelectorAll(".ios-mobile-nav-item")).find(i => i.textContent.includes("Search"));
    if (search) search.click();
  })()`);
  await wait(1800);

  const searchData = await evalCode(`(() => {
    const hotItems = Array.from(document.querySelectorAll(".ios-card, button, li, .text-on")).map(el => el.textContent.trim()).filter(t => t.length > 2 && t.length < 40);
    const input = document.querySelector("input[type=search], input[placeholder*=Search], input");
    return {
      hasSearchInput: !!input,
      inputPlaceholder: input?.getAttribute("placeholder") || null,
      hotDramasSample: hotItems.slice(0, 15),
    };
  })()`);
  console.log("Search page dramas:", searchData);
  await takeScreenshotWithVideo("aurastream_live_real_drama_search.png");

  // ==========================================
  // TEST 5: RANKINGS LEADERBOARD
  // ==========================================
  console.log("\n--- TEST 5: Rankings Leaderboard ---");
  const openRankings = await evalCode(`(() => {
    const rankBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Rankings"));
    if (rankBtn) { rankBtn.click(); return true; }
    return false;
  })()`);
  console.log("Opened rankings:", openRankings);
  await wait(1800);

  const rankingsData = await evalCode(`(() => {
    const items = Array.from(document.querySelectorAll(".text-on, h3, h4")).map(el => el.textContent.trim()).filter(Boolean);
    const covers = Array.from(document.querySelectorAll("img")).map(img => img.src);
    return {
      rankingsCount: covers.length,
      titles: items.slice(0, 12),
    };
  })()`);
  console.log("Rankings list:", rankingsData);
  await takeScreenshotWithVideo("aurastream_live_real_drama_rankings.png");

  // Navigate back to Home
  await evalCode(`(() => {
    const home = Array.from(document.querySelectorAll(".ios-mobile-nav-item")).find(i => i.textContent.includes("Home"));
    if (home) home.click();
  })()`);
  await wait(1000);

  ws.close();
  console.log("\nAll VM Android end-to-end tests completed successfully!");
}

run().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
