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
    fs.writeFileSync(`/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  await wait(1000);

  // 1. Check current app state
  const appState = await evalCode(`(() => {
    const store = window.__AURA_STORE__ || {};
    return {
      title: document.title,
      url: window.location.href,
      bodyTextSnippet: document.body.innerText.slice(0, 300),
      hasErrors: Boolean(document.querySelector('.error-banner, [data-error]')),
    };
  })()`);
  console.log("App State:", appState);

  // 2. Check console errors collected so far
  const errorLogs = consoleLogs.filter(l => l.type === 'error' || l.type === 'EXCEPTION');
  console.log(`Found ${errorLogs.length} console errors:`, errorLogs.slice(0, 10));

  // 3. Test tapping Download on the vertical bar to open DownloadChoiceSheet
  await evalCode(`(() => {
    const btn = document.querySelector('button[aria-label="Offline Download"]');
    if (btn) btn.click();
  })()`);
  await wait(800);

  // 4. Test tapping Single Episode Download button
  const singleDlClick = await evalCode(`(() => {
    const sheet = document.querySelector('[aria-label="Offline Downloads"]');
    if (!sheet) return "No sheet";
    const btn = sheet.querySelector('button[data-card="true"]');
    if (!btn) return "No card button";
    btn.click();
    return "Clicked single download";
  })()`);
  console.log("Single DL Click:", singleDlClick);
  await wait(2000);

  // Take screenshot during/after single download
  await takeScreenshot('aurastream_v2.1_after_single_download_tap.png');

  // Check toast or offline storage in localStorage
  const offlineCheck = await evalCode(`(() => {
    const eps = JSON.parse(localStorage.getItem('aurastream:offline_episodes') || '[]');
    return {
      offlineCount: eps.length,
      firstEp: eps[0] ? { id: eps[0].id, ep: eps[0].episode, title: eps[0].title } : null,
      toastText: document.querySelector('.ios-toast, [role="alert"]')?.innerText || null,
    };
  })()`);
  console.log("Offline Storage Check:", offlineCheck);

  ws.close();
}

run().catch(console.error);
