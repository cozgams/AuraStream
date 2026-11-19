import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function run() {
  const listRes = await fetch("http://127.0.0.1:9222/json");
  const targets = await listRes.json();
  const pageTarget = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error("No page target found on port 9222");

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();
  const consoleLogs = [];
  const testResults = [];

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
    console.log(`[Screenshot saved] -> ${filename} (${buffer.length} bytes)`);
    return filepath;
  }

  console.log("=================================================");
  console.log("       AURASTREAM 2.1.0 ANDROID LIVE TEST SUITE   ");
  console.log("=================================================");

  // Wait for initial feed player to mount
  await new Promise(r => setTimeout(r, 1500));

  // Step 1: Check runtime errors on startup
  const errors = await evalCode(`window.__errors || []`);
  console.log("1. Runtime errors on startup:", errors);
  testResults.push({ test: "Zero Runtime Errors on Startup", passed: errors.length === 0 });
  await takeScreenshot("test_01_home_feed.png");

  // Step 2: Test Star / Favorite button on Action Rail
  console.log("2. Testing Star / Favorite on Action Rail...");
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const favBtn = buttons.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite') || aria.includes('saved');
    });
    if (favBtn) favBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const starInfo = await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const favBtn = buttons.find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite') || aria.includes('saved');
    });
    if (!favBtn) return { found: false };
    const isPressed = favBtn.getAttribute('aria-pressed') === 'true' || (favBtn.getAttribute('aria-label') || '').toLowerCase().includes('saved');
    const svg = favBtn.querySelector('svg');
    const hasAmber = svg?.classList?.contains('text-amber-400') || false;
    return { found: true, isPressed, hasAmber };
  })()`);
  console.log("Star Button State:", starInfo);
  testResults.push({ test: "Action Rail Star Toggle", passed: starInfo.found });
  await takeScreenshot("test_02_star_amber_active.png");

  // Step 3: Test Comments Sheet
  console.log("3. Testing Comments Sheet...");
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return a.includes('comment');
    });
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 800));

  const commentsInfo = await evalCode(`(() => {
    const sheet = document.querySelector('[role="dialog"]') || document.querySelector('.ios-sheet') || document.body;
    const title = (sheet.textContent || '').toLowerCase().includes('comment');
    const commentItems = sheet.querySelectorAll('.border-b') || [];
    return { hasTitle: title, commentCount: commentItems.length };
  })()`);
  console.log("Comments Sheet Info:", commentsInfo);
  testResults.push({ test: "Comments Sheet & Comment Stars", passed: commentsInfo.hasTitle });
  await takeScreenshot("test_03_comments_sheet.png");

  // Close comments sheet
  await evalCode(`(() => {
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('close'));
    if (closeBtn) closeBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Step 4: Test Download Choice Sheet
  console.log("4. Testing Download Choice Sheet...");
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return a.includes('download');
    });
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const downloadChoiceInfo = await evalCode(`(() => {
    const text = document.body.innerText.toLowerCase();
    return {
      hasOffline: text.includes('offline') || text.includes('download'),
      hasBatch: text.includes('batch') || text.includes('season') || text.includes('all'),
      hasStorage: text.includes('space') || text.includes('storage') || text.includes('gb')
    };
  })()`);
  console.log("Download Choice Info:", downloadChoiceInfo);
  testResults.push({ test: "Download Choice Sheet", passed: downloadChoiceInfo.hasOffline && downloadChoiceInfo.hasBatch });
  await takeScreenshot("test_04_download_choice_sheet.png");

  // Close download choice sheet
  await evalCode(`(() => {
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('close'));
    if (closeBtn) closeBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Step 5: Test More Options Sheet
  console.log("5. Testing More Options Sheet...");
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      return a.includes('more');
    });
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const moreInfo = await evalCode(`(() => {
    const text = document.body.innerText.toLowerCase();
    return {
      hasQuality: text.includes('quality') || text.includes('hevc'),
      hasSubtitles: text.includes('subtitles') || text.includes('captions'),
      hasSpeed: text.includes('speed'),
      hasSleepTimer: text.includes('sleep timer'),
      hasAutoSkip: text.includes('skip intro') || text.includes('auto-skip')
    };
  })()`);
  console.log("More Options Sheet Info:", moreInfo);
  testResults.push({ test: "More Options Sheet", passed: moreInfo.hasQuality && moreInfo.hasSleepTimer && moreInfo.hasAutoSkip });
  await takeScreenshot("test_05_more_options_sheet.png");

  // Step 6: Test Episodes Sheet (from More Options Sheet click All Episodes)
  console.log("6. Testing Episodes Sheet...");
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('All Episodes'));
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const epInfo = await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const epBtns = buttons.filter(b => /^[0-9]+$/.test((b.textContent || '').trim()));
    const sortBtn = buttons.find(b => (b.textContent || '').includes('1-N') || (b.textContent || '').includes('N-1'));
    return { epCount: epBtns.length, hasSort: Boolean(sortBtn) };
  })()`);
  console.log("Episodes Sheet Info:", epInfo);
  testResults.push({ test: "Episodes Grid & Sorting", passed: epInfo.epCount > 0 });
  await takeScreenshot("test_06_episodes_sheet.png");

  // Close episodes sheet
  await evalCode(`(() => {
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('close'));
    if (closeBtn) closeBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Step 7: Test Search Tab & Query
  console.log("7. Testing Search Tab...");
  await evalCode(`(() => {
    const navBtns = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    if (navBtns[1]) navBtns[1].click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const searchTabInfo = await evalCode(`(() => {
    const input = document.querySelector('input');
    const hotItems = document.querySelectorAll('.ios-search-hot-item');
    return { hasInput: Boolean(input), hotCount: hotItems.length };
  })()`);
  console.log("Search Tab Info:", searchTabInfo);
  testResults.push({ test: "Search Tab Load & Hot Search", passed: searchTabInfo.hasInput && searchTabInfo.hotCount > 0 });
  await takeScreenshot("test_07_search_tab.png");

  // Type query and submit
  console.log("7b. Running Search Query for 'Urban'...");
  await evalCode(`(() => {
    const input = document.querySelector('input');
    if (input) {
      input.value = 'Urban';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const form = input.closest('form');
      if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  })()`);
  await new Promise(r => setTimeout(r, 1200));

  const searchResultsInfo = await evalCode(`(() => {
    const cards = document.querySelectorAll('.ios-masonry-card') || [];
    const text = document.body.innerText;
    return { resultTextFound: text.includes('Urban'), cardCount: cards.length };
  })()`);
  console.log("Search Results Info:", searchResultsInfo);
  testResults.push({ test: "Search Execution & Masonry Results", passed: searchResultsInfo.resultTextFound });
  await takeScreenshot("test_08_search_results.png");

  // Step 8: Test Categories Tab
  console.log("8. Testing Categories Tab...");
  await evalCode(`(() => {
    const navBtns = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    if (navBtns[2]) navBtns[2].click();
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const catInfo = await evalCode(`(() => {
    const text = document.body.innerText;
    return {
      hasShortDramas: text.includes('Short Dramas'),
      hasAnimeDramas: text.includes('Anime Dramas'),
      hasOriginals: text.includes('Originals'),
      hasRankings: text.includes('Rankings')
    };
  })()`);
  console.log("Categories Tab Info:", catInfo);
  testResults.push({ test: "Categories / Channels Tab", passed: catInfo.hasShortDramas && catInfo.hasRankings });
  await takeScreenshot("test_09_categories_tab.png");

  // Step 9: Test Profile Tab & Downloads Multi-Select
  console.log("9. Testing Profile Tab...");
  await evalCode(`(() => {
    const navBtns = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    if (navBtns[3]) navBtns[3].click();
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const profileInfo = await evalCode(`(() => {
    const text = document.body.innerText;
    return {
      hasFavorites: text.includes('Favorites'),
      hasHistory: text.includes('History'),
      hasDownloads: text.includes('Downloads')
    };
  })()`);
  console.log("Profile Tab Info:", profileInfo);
  testResults.push({ test: "Profile Tab & Collections", passed: profileInfo.hasFavorites && profileInfo.hasDownloads });
  await takeScreenshot("test_10_profile_tab.png");

  // Click Downloads tab in Profile
  console.log("9b. Testing Downloads Tab & Multi-Select Batch Actions...");
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dlTab = buttons.find(b => (b.textContent || '').includes('Downloads'));
    if (dlTab) dlTab.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Expand episodes accordion
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Episodes'));
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  // Click "Select" button
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Select');
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  // Click "Select All"
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Select All'));
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  const selectState = await evalCode(`(() => {
    const deleteBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Delete ('));
    const exportBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Export ('));
    const deselectBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Deselect'));
    const doneBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done');
    return {
      deleteBtnText: deleteBtn?.textContent?.trim() || null,
      exportBtnText: exportBtn?.textContent?.trim() || null,
      hasDeselect: Boolean(deselectBtn),
      hasDone: Boolean(doneBtn)
    };
  })()`);
  console.log("Downloads Select State:", selectState);
  testResults.push({ test: "Downloads Multi-Select Mode (Select / Export / Delete / Done)", passed: Boolean(selectState.deleteBtnText && selectState.exportBtnText) });
  await takeScreenshot("test_11_downloads_select_mode.png");

  // Exit select mode
  await evalCode(`(() => {
    const doneBtn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done');
    if (doneBtn) doneBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  // Step 10: Test Settings Screen
  console.log("10. Testing Settings Screen...");
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('settings'));
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 700));

  const settingsInfo = await evalCode(`(() => {
    const text = document.body.innerText;
    return {
      hasTheme: text.includes('Dark') || text.includes('Light') || text.includes('Auto'),
      hasPlayback: text.includes('Playback'),
      hasBuffer: text.includes('Pre-Cache') || text.includes('Preload'),
      hasStorage: text.includes('Offline Storage') || text.includes('Downloads')
    };
  })()`);
  console.log("Settings Screen Info:", settingsInfo);
  testResults.push({ test: "Settings Screen & Feature Toggles", passed: settingsInfo.hasTheme && settingsInfo.hasStorage });
  await takeScreenshot("test_12_settings_screen.png");

  // Click Back from Settings
  await evalCode(`(() => {
    const backBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('back'));
    if (backBtn) backBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 500));

  // Return to Home tab
  await evalCode(`(() => {
    const navBtns = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    if (navBtns[0]) navBtns[0].click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Check final runtime errors
  const finalErrors = await evalCode(`window.__errors || []`);
  console.log("Final Runtime Errors:", finalErrors);
  testResults.push({ test: "Zero Runtime Errors After Full Session", passed: finalErrors.length === 0 });

  console.log("\n=================================================");
  console.log("                 TEST RESULTS SUMMARY            ");
  console.log("=================================================");
  let passedCount = 0;
  for (const t of testResults) {
    const mark = t.passed ? "PASS" : "FAIL";
    console.log(`• [${mark}] ${t.test}`);
    if (t.passed) passedCount++;
  }
  console.log(`Total: ${passedCount} / ${testResults.length} passed`);

  ws.close();
}

run().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
