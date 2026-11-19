import fs from 'fs';

async function run() {
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);

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
  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p1 = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`;
    fs.writeFileSync(p1, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  // Reset any open overlays or back navigation to return cleanly to Home
  await evalCode(`(() => {
    document.querySelectorAll('button[aria-label="Close"]').forEach(b => b.click());
    let b;
    for (let i = 0; i < 5; i++) {
      b = document.querySelector('button[aria-label="Back"]');
      if (b) b.click();
    }
    const homeBtn = document.querySelector('button[aria-label="Home"]') || Array.from(document.querySelectorAll('nav button')).find(x => x.innerText.includes('Home'));
    homeBtn?.click();
  })()`);
  await wait(1200);

  // 1. Home Feed
  await evalCode(`(() => {
    const homeBtn = document.querySelector('button[aria-label="Home"]') || Array.from(document.querySelectorAll('nav button')).find(x => x.innerText.includes('Home'));
    homeBtn?.click();
  })()`);
  await wait(1000);
  await takeScreenshot('screen_01_home_feed.png');

  // 2. Open Download Choice Sheet
  await evalCode(`document.querySelector('button[aria-label="Offline Download"]')?.click()`);
  await wait(800);
  await takeScreenshot('screen_02_download_choice.png');

  // 3. Open Batch Download Sheet
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.includes("Full Season Batch") || el.innerText.includes("All ("));
    b?.click();
  })()`);
  await wait(800);
  await takeScreenshot('screen_03_batch_sheet.png');

  // Close batch sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('[aria-label="Close"]');
    closeBtn?.click();
  })()`);
  await wait(500);

  // 4. Open Subtitle Sheet (via contextmenu on CC button or Options menu)
  await evalCode(`(() => {
    const ccBtn = document.querySelector('button[aria-label*="Closed Captions"]') || document.querySelector('button[title="Captions"]');
    if (ccBtn) {
      ccBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }
  })()`);
  await wait(800);
  await takeScreenshot('screen_04_subtitle_sheet.png');

  // Close subtitle sheet
  await evalCode(`document.querySelector('[aria-label="Close"]')?.click()`);
  await wait(500);

  // 5. Open Episodes Drawer
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.includes("Details") || el.innerText.includes("Ep."));
    b?.click();
  })()`);
  await wait(600);
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.trim() === "Episodes");
    b?.click();
  })()`);
  await wait(800);
  await takeScreenshot('screen_05_episodes_sheet.png');

  // Close episodes drawer
  await evalCode(`document.querySelector('[aria-label="Close"]')?.click()`);
  await wait(500);

  // 6. Navigate to Search / Discover tab
  await evalCode(`document.querySelector('button[aria-label="Search"]')?.click()`);
  await wait(1000);
  await takeScreenshot('screen_06_search_tab.png');

  // 7. Navigate to Categories tab
  await evalCode(`document.querySelector('button[aria-label="Categories"]')?.click() || document.querySelector('button[aria-label="Category"]')?.click()`);
  await wait(1000);
  await takeScreenshot('screen_07_categories_tab.png');

  // 8. Navigate to Profile tab
  await evalCode(`document.querySelector('button[aria-label="My Space"]')?.click() || document.querySelector('button[aria-label="Profile"]')?.click()`);
  await wait(1000);
  await takeScreenshot('screen_08_profile_tab.png');

  // 9. Profile -> History subtab
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.includes("History"));
    b?.click();
  })()`);
  await wait(800);
  await takeScreenshot('screen_09_profile_history.png');

  // 10. Profile -> Downloads subtab
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.includes("Downloads"));
    b?.click();
  })()`);
  await wait(800);
  await takeScreenshot('screen_10_profile_downloads.png');

  // 11. Open Export Sheet from Profile Downloads
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find(el => el.innerText.includes("Export All") || el.innerText.includes("Export Series"));
    b?.click();
  })()`);
  await wait(800);
  await takeScreenshot('screen_12_export_sheet.png');

  // Close Export Sheet
  await evalCode(`document.querySelector('[aria-label="Close"]')?.click()`);
  await wait(500);

  // 12. Navigate to Settings page
  await evalCode(`(() => {
    const gear = document.querySelector('button[aria-label="Settings"]') || document.querySelector('button[title="Settings"]');
    gear?.click();
  })()`);
  await wait(1000);
  await takeScreenshot('screen_11_settings_page.png');

  ws.close();
  console.log("ALL SCREENSHOTS CAPTURED FOR AUDIT!");
}

run().catch(console.error);
