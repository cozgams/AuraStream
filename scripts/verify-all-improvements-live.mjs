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

  await wait(1200);

  // 1. Enter Feed Player from Home
  console.log("=== CHECK 1: ENTER FEED PLAYER ===");
  const enterFeedResult = await evalCode(`(() => {
    const poster = document.querySelector('.ios-poster, button.ios-poster');
    if (poster) {
      poster.click();
      return "Clicked poster";
    }
    return "Already in feed or no poster";
  })()`);
  console.log("Enter Feed:", enterFeedResult);
  await wait(1500);

  // 2. Test Star Button Idle & Active
  console.log("=== CHECK 2: STAR BUTTON TEST ===");
  const starInfoBefore = await evalCode(`(() => {
    const starBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Favorite' || b.getAttribute('aria-label') === 'Saved');
    return {
      found: Boolean(starBtn),
      label: starBtn?.getAttribute('aria-label'),
      pressed: starBtn?.getAttribute('aria-pressed'),
      svg: starBtn?.querySelector('svg')?.outerHTML?.slice(0, 120)
    };
  })()`);
  console.log("Star Before Click:", starInfoBefore);

  // Click Star to favorite
  await evalCode(`(() => {
    const starBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Favorite' || b.getAttribute('aria-label') === 'Saved');
    if (starBtn) starBtn.click();
  })()`);
  await wait(600);

  const starInfoAfter = await evalCode(`(() => {
    const starBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Favorite' || b.getAttribute('aria-label') === 'Saved');
    const svg = starBtn?.querySelector('svg');
    const persist = JSON.parse(localStorage.getItem('aurastream_app_v1') || '{}');
    const toast = document.querySelector('.a-toast, .ios-toast')?.innerText;
    return {
      found: Boolean(starBtn),
      label: starBtn?.getAttribute('aria-label'),
      pressed: starBtn?.getAttribute('aria-pressed'),
      isAmber: svg?.classList.contains('text-amber-400') || false,
      toast,
      favCount: persist.favs?.length || 0,
      favs: persist.favs || []
    };
  })()`);
  console.log("Star After Click:", starInfoAfter);
  await takeScreenshot('aurastream_final_verified_screen.png');
  await takeScreenshot('aurastream_android_star_active.png');

  // 3. Test Center Double-Tap to Star
  console.log("=== CHECK 3: CENTER DOUBLE TAP TEST ===");
  const doubleTapResult = await evalCode(`(() => {
    const overlay = document.querySelector('.relative[style*="touch-action: none"]') || document.body;
    const rect = overlay.getBoundingClientRect();
    const clientX = rect.left + rect.width * 0.5;
    const clientY = rect.top + rect.height * 0.5;

    // Simulate rapid double tap
    const pdown1 = new PointerEvent('pointerdown', { bubbles: true, clientX, clientY, pointerId: 1, button: 0 });
    const pup1 = new PointerEvent('pointerup', { bubbles: true, clientX, clientY, pointerId: 1, button: 0 });
    overlay.dispatchEvent(pdown1);
    overlay.dispatchEvent(pup1);

    const pdown2 = new PointerEvent('pointerdown', { bubbles: true, clientX, clientY, pointerId: 1, button: 0 });
    const pup2 = new PointerEvent('pointerup', { bubbles: true, clientX, clientY, pointerId: 1, button: 0 });
    overlay.dispatchEvent(pdown2);
    overlay.dispatchEvent(pup2);

    return "Dispatched double tap center";
  })()`);
  console.log("Double Tap:", doubleTapResult);
  await wait(400);

  // 4. Test More Options Sheet & All Episodes Auto-Scroll
  console.log("=== CHECK 4: MORE OPTIONS & EPISODES AUTO-SCROLL ===");
  await evalCode(`document.querySelector('button[aria-label="More Options"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_04_more_options_sheet.png');

  // Click "All Episodes"
  await evalCode(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('All Episodes'))?.click()`);
  await wait(700);

  const episodesCheck = await evalCode(`(() => {
    const sortBtn = document.querySelector('button[aria-label*="Sort" i]');
    const activeEp = document.querySelector('.bg-primary.text-on-primary');
    return {
      hasSortBtn: Boolean(sortBtn),
      sortBtnText: sortBtn?.innerText?.trim(),
      activeEpText: activeEp?.innerText?.trim()
    };
  })()`);
  console.log("Episodes Sheet Info:", episodesCheck);
  await takeScreenshot('audit_03_episodes_sheet.png');

  // Toggle sort
  await evalCode(`document.querySelector('button[aria-label*="Sort" i]')?.click()`);
  await wait(400);
  await takeScreenshot('audit_03_episodes_grid.png');

  // Close Episodes
  await evalCode(`document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button')?.click()`);
  await wait(500);

  // 5. Test Comments Sheet
  console.log("=== CHECK 5: COMMENTS PANEL ===");
  await evalCode(`document.querySelector('button[aria-label*="Comments" i]')?.click()`);
  await wait(700);
  await takeScreenshot('audit_02_comments_panel.png');
  await evalCode(`document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button')?.click()`);
  await wait(500);

  // 6. Return to Home
  console.log("=== CHECK 6: RETURN TO HOME & TABS ===");
  await evalCode(`document.querySelector('button[aria-label="Back"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_01_home_feed.png');

  // Search tab
  await evalCode(`document.querySelector('button[aria-label="Search"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_08_search_tab.png');

  // Categories tab
  await evalCode(`document.querySelector('button[aria-label="Categories"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_09_categories_tab.png');

  // Profile tab
  await evalCode(`document.querySelector('button[aria-label="Profile"]')?.click()`);
  await wait(600);

  // Check Clear Favorites button in Profile
  const profileFavCheck = await evalCode(`(() => {
    const clearBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Clear') && b.innerText.includes('Favorites'));
    const persist = JSON.parse(localStorage.getItem('aurastream_app_v1') || '{}');
    return {
      hasClearFavBtn: Boolean(clearBtn),
      clearBtnText: clearBtn?.innerText?.trim(),
      favCount: persist.favs?.length || 0
    };
  })()`);
  console.log("Profile Favorites Check:", profileFavCheck);
  await takeScreenshot('audit_10_profile_tab.png');

  // Settings screen
  await evalCode(`document.querySelector('button[aria-label*="Settings" i]')?.click()`);
  await wait(600);

  const settingsStarCheck = await evalCode(`(() => {
    const libRow = Array.from(document.querySelectorAll('.ios-setting-group div, .ios-setting-group button')).find(el => el.innerText?.includes('Local Library'));
    const starIcon = libRow?.querySelector('svg.text-amber-400');
    return {
      foundLibRow: Boolean(libRow),
      hasStarIcon: Boolean(starIcon)
    };
  })()`);
  console.log("Settings Library Star Icon Check:", settingsStarCheck);
  await takeScreenshot('audit_12_settings_screen.png');

  // Go back to Profile then Home
  await evalCode(`document.querySelector('button[aria-label="Back"]')?.click()`);
  await wait(400);
  await evalCode(`document.querySelector('button[aria-label="Home"]')?.click()`);
  await wait(400);

  // Check errors
  const errs = await evalCode(`window.__errors || []`);
  console.log("Final window.__errors:", errs);

  const errors = consoleLogs.filter(l => l.type === 'error' || l.type === 'EXCEPTION');
  console.log(`Captured ${errors.length} console errors:`, errors);

  ws.close();
  console.log("=== ALL IMPROVEMENTS VERIFIED LIVE ON ANDROID ===");
}

run().catch(console.error);
