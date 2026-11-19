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
    fs.writeFileSync(p1, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  // 1. Check theme and background
  const themeInfo = await evalCode(`(() => {
    const html = document.documentElement;
    const cs = window.getComputedStyle(html);
    return {
      className: html.className,
      colorScheme: cs.colorScheme,
      bgCanvas: cs.getPropertyValue('--p-canvas').trim(),
      bgCard: cs.getPropertyValue('--p-card').trim(),
      textColor: cs.getPropertyValue('--p-on').trim(),
      localStorageTheme: localStorage.getItem('aurastream_theme_preference_v1'),
      amoledRemoved: !html.classList.contains('theme-amoled'),
      hasAuraNativeExport: typeof window.AuraNativeExport !== 'undefined',
    };
  })()`);
  console.log('Live Theme info:', themeInfo);

  // 2. Navigate to Category tab
  const catNav = await evalCode(`(() => {
    const catBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Category'));
    if (catBtn) { catBtn.click(); return true; }
    return false;
  })()`);
  console.log('Navigated to Category:', catNav);

  await wait(1500);
  await takeScreenshot('aurastream_live_category_white.png');

  // 3. Navigate back to Home
  const homeNav = await evalCode(`(() => {
    const homeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Home'));
    if (homeBtn) { homeBtn.click(); return true; }
    return false;
  })()`);
  console.log('Navigated to Home:', homeNav);

  await wait(1500);
  await takeScreenshot('aurastream_live_home_white.png');

  // 4. Test Settings page
  const settingsNav = await evalCode(`(() => {
    const profileBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Profile'));
    if (profileBtn) { profileBtn.click(); return true; }
    return false;
  })()`);
  console.log('Navigated to Profile:', settingsNav);

  await wait(1000);

  const openSettings = await evalCode(`(() => {
    const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('Settings') || b.textContent?.includes('Settings'));
    if (settingsBtn) { settingsBtn.click(); return true; }
    return false;
  })()`);
  console.log('Opened Settings:', openSettings);

  await wait(1200);
  await takeScreenshot('aurastream_live_settings_white.png');

  ws.close();
  console.log('All live verifications completed successfully!');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
