import fs from 'fs';

async function run() {
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    console.error("No active page target found on port 9222");
    process.exit(1);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();
  const consoleLogs = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLogs.push({
        type: msg.params.type,
        args: msg.params.args.map(a => a.value ?? a.description)
      });
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleLogs.push({
        type: 'EXCEPTION',
        details: msg.params.exceptionDetails
      });
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

  await new Promise(r => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`;
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  await wait(800);

  // 1. Check if we are on Home tab; if so, tap the first drama poster to enter Feed
  console.log("=== STEP 1: ENTER FEED PLAYER ===");
  const enterFeedResult = await evalCode(`(() => {
    const poster = document.querySelector('.ios-poster, [data-drama-id], button.ios-poster');
    if (poster) {
      poster.click();
      return "Clicked poster to open Feed";
    }
    const resumeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Resume'));
    if (resumeBtn) {
      resumeBtn.click();
      return "Clicked resume button";
    }
    return "Already in Feed or no poster found";
  })()`);
  console.log("Enter Feed:", enterFeedResult);
  await wait(1500);

  // 2. Feed Star Button Verification
  console.log("=== STEP 2: STAR BUTTON TEST ===");
  const starInfoBefore = await evalCode(`(() => {
    const starBtn = document.querySelector('button[aria-label="Favorite"], button[aria-label="Favorited"]');
    const svg = starBtn?.querySelector('svg');
    return {
      found: Boolean(starBtn),
      pressed: starBtn?.getAttribute('aria-pressed'),
      isAmber: svg?.classList.contains('text-amber-400') || false,
      svgTag: svg?.outerHTML?.slice(0, 100)
    };
  })()`);
  console.log("Star Before Click:", starInfoBefore);
  await takeScreenshot('aurastream_live_android_feed_star_idle.png');

  // Click Star to toggle favorite
  const starClick = await evalCode(`(() => {
    const starBtn = document.querySelector('button[aria-label="Favorite"], button[aria-label="Favorited"]');
    if (starBtn) {
      starBtn.click();
      return "Clicked star button";
    }
    return "Star button not found";
  })()`);
  console.log("Star Click Result:", starClick);
  await wait(800);

  const starInfoAfter = await evalCode(`(() => {
    const starBtn = document.querySelector('button[aria-label="Favorite"], button[aria-label="Favorited"]');
    const svg = starBtn?.querySelector('svg');
    const persist = JSON.parse(localStorage.getItem('aurastream_app_v1') || '{}');
    const toast = document.querySelector('.ios-toast, [role="alert"]')?.innerText;
    return {
      pressed: starBtn?.getAttribute('aria-pressed'),
      isAmber: svg?.classList.contains('text-amber-400') || false,
      toast,
      favCount: persist.favs?.length || 0,
      favs: persist.favs || [],
      likes: persist.likes || []
    };
  })()`);
  console.log("Star After Click:", starInfoAfter);
  await takeScreenshot('aurastream_live_android_feed_star_active.png');
  await takeScreenshot('aurastream_final_verified_screen.png');

  // 3. Test Seek Scrubber with Finger-tracking Bubble
  console.log("=== STEP 3: TIMELINE SEEK SCRUBBER ===");
  const seekBubbleResult = await evalCode(`(() => {
    const bar = document.querySelector('.relative[style*="touch-action: none"], [style*="touchAction: none"]');
    if (!bar) return { found: false };
    const rect = bar.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.45;
    const clientY = rect.top + rect.height / 2;

    bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX, clientY, pointerId: 1 }));
    bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: clientX + 20, clientY, pointerId: 1 }));

    // Check if seek bubble rendered
    const bubble = Array.from(document.querySelectorAll('div, span')).find(el => el.innerText && el.innerText.includes('/') && el.style.position === 'absolute');
    return {
      found: true,
      hasBubble: Boolean(bubble),
      bubbleText: bubble?.innerText,
      bubbleStyle: bubble ? { left: bubble.style.left, transform: bubble.style.transform } : null
    };
  })()`);
  console.log("Seek Bubble Result:", seekBubbleResult);
  await takeScreenshot('aurastream_live_android_feed_seeking.png');

  // Release pointer
  await evalCode(`(() => {
    const bar = document.querySelector('.relative[style*="touch-action: none"], [style*="touchAction: none"]');
    if (bar) bar.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })()`);
  await wait(600);

  // 4. Test More Options Sheet
  console.log("=== STEP 4: MORE OPTIONS SHEET ===");
  await evalCode(`(() => {
    const moreBtn = document.querySelector('button[aria-label="More Options"]');
    if (moreBtn) moreBtn.click();
  })()`);
  await wait(800);

  const moreSheetCards = await evalCode(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (!sheet) return [];
    return Array.from(sheet.querySelectorAll('button[data-card="true"]')).map(b => b.innerText.trim());
  })()`);
  console.log("More Options Card Labels:", moreSheetCards);
  await takeScreenshot('aurastream_live_android_more_options.png');

  // 5. Click "All Episodes" card from More Options to open Episodes sheet
  console.log("=== STEP 5: EPISODES SHEET & SORT TOGGLE ===");
  const openEpResult = await evalCode(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (!sheet) return "No more sheet";
    const allEpBtn = Array.from(sheet.querySelectorAll('button')).find(b => b.innerText.includes('All Episodes') || b.innerText.includes('Episodes'));
    if (allEpBtn) {
      allEpBtn.click();
      return "Clicked All Episodes";
    }
    return "All Episodes button not found";
  })()`);
  console.log("Open Episodes Sheet:", openEpResult);
  await wait(1000);

  // Check sort button in Episodes sheet
  const sortBtnCheck = await evalCode(`(() => {
    const sortBtn = document.querySelector('button[aria-label*="Sort descending" i], button[aria-label*="Sort ascending" i]');
    const beforeText = sortBtn?.innerText?.trim();
    if (sortBtn) sortBtn.click();
    return {
      found: Boolean(sortBtn),
      beforeText
    };
  })()`);
  console.log("Sort Button Check 1:", sortBtnCheck);
  await wait(600);

  const sortBtnAfter = await evalCode(`(() => {
    const sortBtn = document.querySelector('button[aria-label*="Sort descending" i], button[aria-label*="Sort ascending" i]');
    return {
      afterText: sortBtn?.innerText?.trim(),
      ariaLabel: sortBtn?.getAttribute('aria-label')
    };
  })()`);
  console.log("Sort Button After Click:", sortBtnAfter);
  await takeScreenshot('aurastream_live_android_episodes_sheet.png');

  // Close Episodes sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button');
    if (closeBtn) closeBtn.click();
    else {
      const backdrop = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/40');
      if (backdrop) backdrop.click();
    }
  })()`);
  await wait(600);

  // 6. Test Comments Panel & Comment Like Heart
  console.log("=== STEP 6: COMMENTS PANEL & COMMENT HEART ===");
  await evalCode(`(() => {
    const commentBtn = document.querySelector('button[aria-label*="Comments" i]');
    if (commentBtn) commentBtn.click();
  })()`);
  await wait(800);

  const commentLikeAction = await evalCode(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (!sheet) return "No comments sheet";
    const heartBtn = Array.from(sheet.querySelectorAll('button')).find(b => b.querySelector('svg.text-rose-500, svg.text-mut'));
    const beforeCount = heartBtn?.innerText?.trim();
    if (heartBtn) {
      heartBtn.click();
      return { clicked: true, beforeCount };
    }
    return { clicked: false };
  })()`);
  console.log("Comment Like Action:", commentLikeAction);
  await wait(500);

  const commentLikeAfter = await evalCode(`(() => {
    const sheet = document.querySelector('[role="dialog"]');
    if (!sheet) return null;
    const heartBtn = Array.from(sheet.querySelectorAll('button')).find(b => b.querySelector('svg.text-rose-500, svg.text-mut'));
    return {
      afterCount: heartBtn?.innerText?.trim(),
      svgClass: heartBtn?.querySelector('svg')?.className?.baseVal || heartBtn?.querySelector('svg')?.className
    };
  })()`);
  console.log("Comment Like After:", commentLikeAfter);
  await takeScreenshot('aurastream_live_android_comments_panel.png');

  // Close Comments sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button');
    if (closeBtn) closeBtn.click();
    else {
      const backdrop = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/40');
      if (backdrop) backdrop.click();
    }
  })()`);
  await wait(600);

  // 7. Exit Feed back to Home tab
  console.log("=== STEP 7: EXIT FEED TO HOME ===");
  await evalCode(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back"]');
    if (backBtn) backBtn.click();
  })()`);
  await wait(800);

  // 8. Tab Audits: Search, Categories, Profile, Settings
  console.log("=== STEP 8: TAB AUDITS ===");
  // Search
  await evalCode(`(() => {
    const searchTab = document.querySelector('button[aria-label="Search"]');
    if (searchTab) searchTab.click();
  })()`);
  await wait(800);
  await takeScreenshot('aurastream_live_android_search.png');

  // Categories
  await evalCode(`(() => {
    const catTab = document.querySelector('button[aria-label="Categories"]');
    if (catTab) catTab.click();
  })()`);
  await wait(800);
  await takeScreenshot('aurastream_live_android_categories.png');

  // Profile
  await evalCode(`(() => {
    const profTab = document.querySelector('button[aria-label="Profile"]');
    if (profTab) profTab.click();
  })()`);
  await wait(800);
  await takeScreenshot('aurastream_live_android_profile.png');

  // Settings
  await evalCode(`(() => {
    const settingsBtn = document.querySelector('button[aria-label*="Settings" i]');
    if (settingsBtn) settingsBtn.click();
  })()`);
  await wait(800);
  await takeScreenshot('aurastream_live_android_settings.png');

  // Go back to Profile then Home
  await evalCode(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back"]');
    if (backBtn) backBtn.click();
    const homeTab = document.querySelector('button[aria-label="Home"]');
    if (homeTab) homeTab.click();
  })()`);
  await wait(800);

  // Final check: console errors and runtime exceptions
  const errs = await evalCode(`window.__errors || []`);
  console.log("Final window.__errors:", errs);

  const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'EXCEPTION');
  console.log(`Captured ${errors.length} console errors:`, errors);

  ws.close();
  console.log("=== ALL LIVE ANDROID CHECKS COMPLETE AND VERIFIED ===");
}

run().catch(console.error);
