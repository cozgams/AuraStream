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

  // Close any overlay
  await evalCode(`(() => {
    document.querySelectorAll('button[aria-label="Close"]').forEach(b => b.click());
  })()`);
  await wait(500);

  // Click Profile Tab
  console.log("Navigating to Profile tab...");
  const profClicked = await evalCode(`(() => {
    const btn = document.querySelector('button[aria-label="Profile"]');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  console.log("Profile tab clicked:", profClicked);
  await wait(1500);

  // Click Settings button
  console.log("Clicking Settings button...");
  const settingsClicked = await evalCode(`(() => {
    const btn = document.querySelector('button[aria-label="Settings"]');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  console.log("Settings button clicked:", settingsClicked);
  await wait(1500);

  // Take screenshot of settings top
  await takeScreenshot('verified_live_03_settings_top.png');

  // Scroll to middle
  await evalCode(`(() => {
    const scroller = document.querySelector('.ios-page-body');
    if (scroller) scroller.scrollTop = 480;
  })()`);
  await wait(600);
  await takeScreenshot('verified_live_04_settings_middle.png');

  // Scroll to bottom
  await evalCode(`(() => {
    const scroller = document.querySelector('.ios-page-body');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  })()`);
  await wait(600);
  await takeScreenshot('verified_live_05_settings_bottom.png');

  console.log("Settings screenshots captured successfully!");
  ws.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
