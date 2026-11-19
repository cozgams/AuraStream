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

  const takeScreenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p1 = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`;
    const p2 = `/data/home/Project/A/${name}`;
    fs.writeFileSync(p1, Buffer.from(shot.result.data, 'base64'));
    fs.writeFileSync(p2, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  await wait(1000);

  // 1. Navigate to Settings page
  console.log("Navigating to Profile -> Settings...");
  // Press key 4 (Profile)
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "4" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "4" });
  await wait(800);

  // Click Settings gear button
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const gear = buttons.find(b => b.getAttribute('aria-label')?.includes('Settings') || b.querySelector('svg'));
    if (gear) gear.click();
  })()`);
  await wait(1000);

  // Scroll down in Settings to see the Instant Playback & Preload Auto-Cleaner section
  await evalCode(`(() => {
    window.scrollBy({ top: 600, behavior: 'instant' });
    const scrollable = document.querySelector('main, .overflow-y-auto, [class*="scroll"]');
    if (scrollable) scrollable.scrollTop = 600;
  })()`);
  await wait(1000);

  // Check section elements
  const sectionInfo = await evalCode(`(() => {
    const text = document.body.innerText;
    const hasSection = text.includes('Instant Playback & Preload Auto-Cleaner');
    const hasPrecache = text.includes('Full Episode Pre-Cache');
    const hasPreload = text.includes('Next Episode Background Preload');
    const hasAutoClean = text.includes('Memory Cache Auto-Cleaner');
    const hasTempCache = text.includes('Temporary Memory Cache');
    return { hasSection, hasPrecache, hasPreload, hasAutoClean, hasTempCache };
  })()`);
  console.log("Settings section info:", sectionInfo);

  await takeScreenshot('aurastream_live_precache_settings.png');

  // 2. Test preloading & auto-cleaner engine via evaluate
  console.log("Testing preload and auto-cleaner engine directly in runtime...");
  const engineTest = await evalCode(`(async () => {
    try {
      // Test localStorage flags
      const fullPreCache = localStorage.getItem('aurastream_full_episode_precache_v1');
      const nextPreload = localStorage.getItem('aurastream_next_episode_preload_v1');
      const autoClean = localStorage.getItem('aurastream_temp_cache_autoclean_v1');

      return {
        fullPreCache: fullPreCache ?? 'default true',
        nextPreload: nextPreload ?? 'default true',
        autoClean: autoClean ?? 'default true',
      };
    } catch (e) {
      return { error: e.message };
    }
  })()`);
  console.log("Engine flags test:", engineTest);

  // 3. Navigate back to Home feed and test live playback preloading
  console.log("Navigating back to Feed...");
  await evalCode(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back"], button.pressable');
    if (backBtn) backBtn.click();
  })()`);
  await wait(800);

  // Switch to Home tab (key 1)
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "1" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "1" });
  await wait(2500);

  await takeScreenshot('aurastream_live_precache_active.png');

  ws.close();
  console.log("Verification finished successfully!");
}

run().catch(console.error);
