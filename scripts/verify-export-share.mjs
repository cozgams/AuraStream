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

  // 1. Switch to Profile tab
  console.log("Switching to Profile...");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "4" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "4" });
  await wait(1000);

  // 2. Click Downloads tab
  console.log("Opening Downloads tab...");
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dlTab = buttons.find(b => b.innerText.trim() === 'Downloads');
    if (dlTab) dlTab.click();
  })()`);
  await wait(1000);

  // 3. Inspect UI elements in Downloads tab
  const tabInfo = await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean);
    const hasExportAll = buttons.some(b => b.includes('Export All'));
    const hasMp4 = buttons.some(b => b === 'MP4' || b.includes('MP4'));
    const hasShare = document.querySelector('button[aria-label="Share Video"]') != null;
    return { hasExportAll, hasMp4, hasShare, buttons: buttons.slice(0, 15) };
  })()`);
  console.log("Downloads tab info:", tabInfo);

  await takeScreenshot('aurastream_live_downloads_export_ui.png');

  // 4. Click the "MP4" (Export) button on the downloaded episode!
  console.log("Clicking MP4 export button...");
  const exportClickRes = await evalCode(`(() => {
    const mp4Btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'MP4' || b.getAttribute('title')?.includes('Export MP4'));
    if (mp4Btn) {
      mp4Btn.click();
      return { clicked: true };
    }
    return { clicked: false };
  })()`);
  console.log("MP4 click result:", exportClickRes);

  // Wait for export streaming to complete
  await wait(3000);

  // Check toasts and status
  const toastText = await evalCode(`(() => {
    const toasts = Array.from(document.querySelectorAll('.hg-toast, [role=alert], .fixed')).map(el => el.innerText.trim());
    return { toasts: toasts.filter(t => t.includes('Movies') || t.includes('Export') || t.includes('Saved')) };
  })()`);
  console.log("Toast result:", toastText);

  await takeScreenshot('aurastream_live_mp4_exported.png');

  // 5. Test Share button click
  console.log("Testing Share button click...");
  await evalCode(`(() => {
    const shareBtn = document.querySelector('button[aria-label="Share Video"]');
    if (shareBtn) shareBtn.click();
  })()`);
  await wait(1500);

  await takeScreenshot('aurastream_live_share_triggered.png');

  ws.close();
}

run().catch(console.error);
