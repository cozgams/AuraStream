import fs from 'fs';

async function run() {
  const res = await fetch('http://127.0.0.1:9222/json');
  const [target] = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const cur = id++;
    const handler = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === cur) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });

  await new Promise(r => ws.addEventListener('open', r));

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const evalCode = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };

  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}.png`;
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log(`Captured ${name}.png`);
  };

  // Close any current sheet
  await evalCode(`(() => { const b = document.querySelector(".ios-overlay-backdrop"); if (b) b.click(); })()`);
  await wait(600);

  // 1. Open Episodes / Detail Drawer
  await evalCode(`(() => {
    const detailBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Details'));
    if (detailBtn) detailBtn.click();
  })()`);
  await wait(800);
  await capture('audit_episodes_drawer');

  // Close
  await evalCode(`(() => { const b = document.querySelector(".ios-overlay-backdrop"); if (b) b.click(); })()`);
  await wait(600);

  // 2. Open Comments Sheet
  await evalCode(`(() => {
    const commentBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Comments' || b.getAttribute('aria-label') === 'player.comments');
    if (commentBtn) commentBtn.click();
  })()`);
  await wait(800);
  await capture('audit_comments_sheet');

  // Close
  await evalCode(`(() => { const b = document.querySelector(".ios-overlay-backdrop"); if (b) b.click(); })()`);
  await wait(600);

  // 3. Open Subtitles Customization Sheet
  await evalCode(`(() => {
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('More') || b.getAttribute('aria-label')?.includes('More'));
    if (moreBtn) moreBtn.click();
  })()`);
  await wait(600);
  await evalCode(`(() => {
    const custBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Customize'));
    if (custBtn) custBtn.click();
  })()`);
  await wait(800);
  await capture('audit_subtitles_sheet');

  ws.close();
  console.log("Audit screenshots completed!");
}

run().catch(console.error);
