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

  // Scroll down the profile scroll container
  await evalCode(`(() => {
    const scroller = document.querySelector('.ios-page-body');
    if (scroller) {
      scroller.scrollTop = 320;
    }
  })()`);
  await wait(600);

  await takeScreenshot('aurastream_v2.1_profile_downloads_scrolled.png');
  console.log("Captured scrolled Profile Downloads screen!");

  ws.close();
}

run().catch(console.error);
