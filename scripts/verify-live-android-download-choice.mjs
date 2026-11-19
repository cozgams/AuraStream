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
  console.log("Connected to live Android AuraStream CDP!");

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

  await wait(2500);

  // 1. Verify Feed is loaded and check for fake procedural subtitles
  const subCheck = await evalCode(`(() => {
    const hasFakeZh = document.body.innerText.includes("区区林家，也敢在太岁头上动土？");
    const hasFakeEn = document.body.innerText.includes("A trivial family like the Lins dares to cross us?");
    const hasDupOffline = document.body.innerText.includes("⚡ Offline");
    return { hasFakeZh, hasFakeEn, hasDupOffline };
  })()`);

  console.log("Initial Screen Checks:", subCheck);
  await takeScreenshot('aurastream_v2.1_clean_feed.png');

  // 2. Find and click the Download button on the right vertical bar
  const clickRes = await evalCode(`(() => {
    const dlBtn = document.querySelector('button[aria-label="Offline Download"]');
    if (!dlBtn) return "No dlBtn found";
    dlBtn.click();
    return "Clicked dlBtn";
  })()`);
  console.log("Click Download Button result:", clickRes);

  await wait(800);

  // 3. Verify the Download Choice Sheet with 2 buttons opened
  const sheetCheck = await evalCode(`(() => {
    const sheet = document.querySelector('[aria-label="Offline Downloads"]');
    if (!sheet) return { open: false };
    const text = sheet.innerText;
    const hasSingle = text.includes("Download Episode") || text.includes("Episode");
    const hasBatch = text.includes("Full Season Batch") || text.includes("Batch");
    return {
      open: true,
      hasSingle,
      hasBatch,
      textSnippet: text.slice(0, 150),
    };
  })()`);

  console.log("Download Choice Sheet check:", sheetCheck);
  await takeScreenshot('aurastream_v2.1_download_choice_sheet_live.png');

  // 4. Click Button 2: Full Season Batch
  const clickBatchRes = await evalCode(`(() => {
    const sheet = document.querySelector('[aria-label="Offline Downloads"]');
    if (!sheet) return "No sheet found";
    const buttons = Array.from(sheet.querySelectorAll('button'));
    const batchBtn = buttons.find(b => b.innerText.includes("Full Season Batch") || b.innerText.includes("All ("));
    if (!batchBtn) return "No batchBtn found";
    batchBtn.click();
    return "Clicked batchBtn";
  })()`);
  console.log("Click Batch Download result:", clickBatchRes);

  await wait(800);

  // 5. Verify the full session batch downloader sheet is opened
  const batchSheetCheck = await evalCode(`(() => {
    const batchSheet = document.querySelector('[aria-label="Batch Download"]') || document.body.innerText.includes("All Unsaved");
    return {
      open: Boolean(batchSheet),
      hasPresets: document.body.innerText.includes("+ Next 5") || document.body.innerText.includes("+ 5"),
    };
  })()`);

  console.log("Batch Sheet check:", batchSheetCheck);
  await takeScreenshot('aurastream_v2.1_batch_sheet_live.png');

  console.log("LIVE VERIFICATION COMPLETE!");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
