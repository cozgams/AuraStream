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
    fs.writeFileSync(`/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  // 1. Close any open sheets by clicking close buttons
  await evalCode(`(() => {
    const closeBtns = Array.from(document.querySelectorAll('button[aria-label="Close"], button[aria-label="close"]'));
    closeBtns.forEach(b => b.click());
  })()`);
  await wait(500);

  // 2. Click Profile tab
  await evalCode(`(() => {
    const navItems = Array.from(document.querySelectorAll('.ios-mobile-nav-item, nav[aria-label="Main Navigation"] button'));
    const profileBtn = navItems.find(b => b.innerText.includes('Profile') || b.getAttribute('aria-label') === 'Profile');
    if (profileBtn) profileBtn.click();
  })()`);
  await wait(600);

  // 3. Click Downloads tab segment
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dlTab = buttons.find(b => b.innerText.includes('Downloads') || b.innerText.includes('Offline'));
    if (dlTab) dlTab.click();
  })()`);
  await wait(600);

  await takeScreenshot('aurastream_v2.1_profile_downloads_clean.png');
  console.log("Captured clean Profile Downloads screen!");

  // 4. Click Home tab to go back to player
  await evalCode(`(() => {
    const navItems = Array.from(document.querySelectorAll('.ios-mobile-nav-item, nav[aria-label="Main Navigation"] button'));
    const homeBtn = navItems.find(b => b.innerText.includes('Home') || b.getAttribute('aria-label') === 'Home');
    if (homeBtn) homeBtn.click();
  })()`);
  await wait(800);

  await takeScreenshot('aurastream_v2.1_back_to_home.png');

  ws.close();
}

run().catch(console.error);
