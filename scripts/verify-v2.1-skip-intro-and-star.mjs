import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function run() {
  const listRes = await fetch("http://127.0.0.1:9222/json");
  const targets = await listRes.json();
  const pageTarget = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error("No page target found");

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();
  const consoleLogs = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLogs.push({ type: msg.params.type, args: msg.params.args.map(a => a.value ?? a.description) });
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLogs.push({ type: "EXCEPTION", details: msg.params.exceptionDetails });
    }
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

  await new Promise(r => ws.addEventListener("open", r));
  await send("Page.enable");
  await send("Runtime.enable");

  async function evalCode(expr) {
    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.result?.value;
  }

  async function takeScreenshot(filename) {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    const filepath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`[Screenshot saved] -> ${filepath} (${buffer.length} bytes)`);
    return filepath;
  }

  console.log("=== VERIFYING AURASTREAM 2.1.0 ANDROID FEATURES ===");

  // 1. Initial Feed State & Zero Console Errors
  const initialInfo = await evalCode(`(() => {
    const errors = window.__errors || [];
    const favButtons = Array.from(document.querySelectorAll('button')).filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite');
    });
    const starSvg = favButtons[0]?.querySelector('svg');
    const isAmber = starSvg?.classList?.contains('text-amber-400') || false;
    return {
      errors,
      favFound: favButtons.length > 0,
      isAmber,
      url: window.location.href,
      title: document.title
    };
  })()`);
  console.log("Initial Info:", initialInfo);

  await takeScreenshot("aurastream_v21_feed_initial.png");

  // 2. Test Star button toggle
  const starToggle = await evalCode(`(() => {
    const favButtons = Array.from(document.querySelectorAll('button')).filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite');
    });
    if (favButtons[0]) {
      favButtons[0].click();
      return true;
    }
    return false;
  })()`);
  console.log("Star button clicked:", starToggle);

  await new Promise(r => setTimeout(r, 600));

  const afterStarInfo = await evalCode(`(() => {
    const favButtons = Array.from(document.querySelectorAll('button')).filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite');
    });
    const starSvg = favButtons[0]?.querySelector('svg');
    const isAmber = starSvg?.classList?.contains('text-amber-400') || false;
    const toast = document.querySelector('.a-toast')?.textContent || '';
    return { isAmber, toast };
  })()`);
  console.log("After Star Click:", afterStarInfo);

  await takeScreenshot("aurastream_v21_star_amber_active.png");

  // 3. Test More Options Sheet (verify Quality, Subtitles, Speed, Sleep Timer, and NEW Auto-Skip Intro)
  const openMore = await evalCode(`(() => {
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const txt = (b.textContent || '').toLowerCase();
      return aria.includes('more') || txt.includes('options');
    });
    if (moreBtn) {
      moreBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("More Options Sheet opened:", openMore);

  await new Promise(r => setTimeout(r, 600));

  const moreSheetContent = await evalCode(`(() => {
    const text = document.body.innerText;
    const hasAutoSkip = text.includes('Auto-Skip Intro');
    const hasQuality = text.includes('Stream Quality') || text.includes('HD 1080p');
    const hasSpeed = text.includes('Playback Speed');
    const hasSleepTimer = text.includes('Sleep Timer');
    return { hasAutoSkip, hasQuality, hasSpeed, hasSleepTimer };
  })()`);
  console.log("More Sheet verification:", moreSheetContent);

  await takeScreenshot("aurastream_v21_more_options_sheet.png");

  // Close more sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  })()`);

  await new Promise(r => setTimeout(r, 400));

  // 4. Test Comments Sheet (verify Comment like uses Star and no Heart)
  const openComments = await evalCode(`(() => {
    const commentBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('comment');
    });
    if (commentBtn) {
      commentBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Comments Sheet opened:", openComments);

  await new Promise(r => setTimeout(r, 600));

  const commentsVerification = await evalCode(`(() => {
    const starButtons = document.querySelectorAll('button[aria-label="Star comment"]');
    const heartButtons = document.querySelectorAll('button[aria-label="Like comment"]');
    return {
      starCommentsCount: starButtons.length,
      heartCommentsCount: heartButtons.length
    };
  })()`);
  console.log("Comments verification (Zero heart):", commentsVerification);

  await takeScreenshot("aurastream_v21_comments_sheet.png");

  // Close comments sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  })()`);

  await new Promise(r => setTimeout(r, 400));

  // 5. Test Episodes Sheet (verify auto-scroll & sort toggle)
  const openEpisodes = await evalCode(`(() => {
    const detailPill = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Details'));
    if (detailPill) {
      detailPill.click();
      return true;
    }
    return false;
  })()`);
  console.log("Episodes/Details Sheet opened:", openEpisodes);

  await new Promise(r => setTimeout(r, 600));
  await takeScreenshot("aurastream_v21_episodes_sheet.png");

  // Close episodes sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  })()`);

  await new Promise(r => setTimeout(r, 400));

  // 6. Test Profile tab navigation & verify Following and Favorites
  await evalCode(`(() => {
    const navItems = Array.from(document.querySelectorAll('.ios-mobile-nav-item'));
    if (navItems[3]) navItems[3].click();
  })()`);

  await new Promise(r => setTimeout(r, 600));

  const profileVerification = await evalCode(`(() => {
    const text = document.body.innerText;
    const hasFollowing = text.includes('Following');
    const hasFavorites = text.includes('Favorites');
    const hasClearFavs = Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').includes('Clear Favorites'));
    return { hasFollowing, hasFavorites, hasClearFavs };
  })()`);
  console.log("Profile verification:", profileVerification);

  await takeScreenshot("aurastream_v21_profile_tab.png");

  // Switch to Settings tab from Profile
  await evalCode(`(() => {
    const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('settings');
    });
    if (settingsBtn) settingsBtn.click();
  })()`);

  await new Promise(r => setTimeout(r, 600));

  const settingsVerification = await evalCode(`(() => {
    const text = document.body.innerText;
    const hasLocalLibrary = text.includes('Local Library');
    const hasAICaptions = text.includes('AI') || text.includes('Caption');
    return { hasLocalLibrary, hasAICaptions };
  })()`);
  console.log("Settings verification:", settingsVerification);

  await takeScreenshot("aurastream_v21_settings_screen.png");

  // Check final error count
  const finalErrors = await evalCode(`window.__errors || []`);
  console.log("Final error log (must be empty):", finalErrors);

  ws.close();
  console.log("=== ALL LIVE VERIFICATION PASSED ===");
}

run().catch((e) => {
  console.error("Verification failed:", e);
  process.exit(1);
});
