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
  console.log("Connected to live AuraStream CDP on Android!");

  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshot = async (filePath) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot to ${filePath}`);
  };

  // 1. Initial State Check
  await wait(1500);
  const state1 = await evalCode(`(() => {
    return {
      title: document.title,
      textPreview: document.body.innerText.slice(0, 100),
      chineseChars: (document.body.innerText.match(/[\\u4e00-\\u9fa5]/g) || []).length,
      amoledActive: document.documentElement.classList.contains('theme-amoled')
    };
  })()`);
  console.log("Initial state:", state1);

  // Take Feed screenshot
  await takeScreenshot('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_live_feed_v2.1_suite.png');

  // 2. Navigate to Profile -> Downloads tab
  console.log("Navigating to Profile...");
  await evalCode(`(() => {
    const navButtons = Array.from(document.querySelectorAll('nav button, .ios-tabbar button'));
    // Bottom tab 4 is Profile (Mine)
    const profileBtn = navButtons.find(b => b.innerText.includes('Me') || b.innerText.includes('Profile') || b.getAttribute('aria-label')?.includes('Profile')) || navButtons[3];
    if (profileBtn) profileBtn.click();
  })()`);
  await wait(1000);

  // Click Downloads tab inside Profile
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dlTab = buttons.find(b => b.innerText.trim() === 'Downloads');
    if (dlTab) dlTab.click();
  })()`);
  await wait(800);

  const profileState = await evalCode(`(() => {
    const body = document.body.innerText;
    return {
      hasStorage: body.includes('Phone Storage'),
      hasSmartDl: body.includes('Auto-Download Next Episode'),
      hasAutoDel: body.includes('Auto-Delete Watched Episodes'),
      hasWifiOnly: body.includes('Download on Wi-Fi Only'),
      hasCellularSaver: body.includes('Cellular Data Saver'),
      chineseChars: (body.match(/[\\u4e00-\\u9fa5]/g) || []).length
    };
  })()`);
  console.log("Profile Downloads tab state:", profileState);
  await takeScreenshot('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_live_downloads_v2.1_suite.png');

  // 3. Open Settings from Profile
  console.log("Opening Settings...");
  await evalCode(`(() => {
    const btn = document.querySelector('button[aria-label="Settings"], .ios-icon-button');
    if (btn) btn.click();
  })()`);
  await wait(1000);

  const settingsState = await evalCode(`(() => {
    const body = document.body.innerText;
    return {
      hasWifiOnly: body.includes('Download on Wi-Fi Only'),
      hasCellularSaver: body.includes('Cellular Data Saver'),
      hasAutoSkip: body.includes('Auto-Skip Episode Intro'),
      hasSleepTimer: body.includes('Sleep Timer'),
      hasAmoled: body.includes('AMOLED Pure Black Theme'),
      chineseChars: (body.match(/[\\u4e00-\\u9fa5]/g) || []).length
    };
  })()`);
  console.log("Settings state:", settingsState);

  // Scroll down to Binge Watching & Battery Saver in Settings
  await evalCode(`(() => {
    const scroller = document.querySelector('.scroll-y, .ios-page-body');
    if (scroller) scroller.scrollTop = 500;
  })()`);
  await wait(600);
  await takeScreenshot('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_live_settings_v2.1_suite.png');

  // Test toggling AMOLED theme
  console.log("Toggling AMOLED mode in Settings...");
  await evalCode(`(() => {
    const toggles = Array.from(document.querySelectorAll('button[role="switch"]'));
    // Find amoled toggle
    const amoledToggle = toggles.find(t => t.getAttribute('aria-label')?.includes('AMOLED') || t.parentElement?.innerText?.includes('AMOLED'));
    if (amoledToggle) amoledToggle.click();
  })()`);
  await wait(500);

  const amoledActive = await evalCode(`document.documentElement.classList.contains('theme-amoled')`);
  console.log("AMOLED theme active on <html>:", amoledActive);
  await takeScreenshot('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_live_amoled_mode.png');

  // 4. Return to Feed
  console.log("Returning to Feed tab...");
  await evalCode(`(() => {
    const navButtons = Array.from(document.querySelectorAll('nav button, .ios-tabbar button'));
    if (navButtons[0]) navButtons[0].click();
  })()`);
  await wait(1000);

  // Click Episodes button on player
  console.log("Opening Episodes panel...");
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const epBtn = buttons.find(b => b.innerText.includes('Episodes') || b.getAttribute('aria-label')?.includes('Episodes'));
    if (epBtn) epBtn.click();
  })()`);
  await wait(800);

  const episodesPanelState = await evalCode(`(() => {
    const body = document.body.innerText;
    const hasBatchBtn = body.includes('Batch Download');
    const greenDots = document.querySelectorAll('.bg-emerald-400, .bg-emerald-500').length;
    return { hasBatchBtn, greenDots, text: body.slice(0, 150) };
  })()`);
  console.log("Episodes Panel state:", episodesPanelState);

  // Click "Batch Download" button to open the sheet
  console.log("Clicking Batch Download button...");
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const batchBtn = buttons.find(b => b.innerText.includes('Batch Download'));
    if (batchBtn) batchBtn.click();
  })()`);
  await wait(800);

  const batchSheetState = await evalCode(`(() => {
    const body = document.body.innerText;
    return {
      sheetOpen: body.includes('Series Batch Downloader'),
      hasPresets: body.includes('Next 5') && body.includes('Next 10') && body.includes('All Unsaved'),
      hasStartBtn: body.includes('Download')
    };
  })()`);
  console.log("Batch Sheet state:", batchSheetState);
  await takeScreenshot('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_live_batch_download_sheet.png');

  console.log("Verification suite completed successfully!");
  ws.close();
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
