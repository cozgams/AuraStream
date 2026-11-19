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
  console.log("Connected to live AuraStream CDP on Android VM!");

  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshotWithVideo = async (filename) => {
    await evalCode(`(() => {
      const v = document.querySelector("video");
      if (!v) return;
      let canvas = document.getElementById("__video_frame_capture");
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.id = "__video_frame_capture";
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        canvas.style.zIndex = "2";
        canvas.style.pointerEvents = "none";
        v.parentElement.insertBefore(canvas, v.nextSibling);
      }
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      const ctx = canvas.getContext("2d");
      try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); } catch {}
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${filename}`;
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${filename}`);

    await evalCode(`(() => { document.getElementById("__video_frame_capture")?.remove(); })()`);
  };

  // Wait 2.5s for video to start playing
  await wait(2500);

  // 1. Inspect clean player UI
  const rightButtons = await evalCode(`(() => {
    const rightCol = document.querySelector(".absolute.right-3\\\\.5, [class*='right-3.5']");
    const buttons = rightCol ? Array.from(rightCol.querySelectorAll("button")).map(b => b.textContent?.trim() || b.getAttribute("aria-label")) : [];
    const bottomPill = document.querySelector("button[aria-label='Main Navigation'], [class*='details'], [class*='episode_num']")?.textContent?.trim();
    const ccBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("CC") || b.textContent?.includes("EN") || b.textContent?.includes("DUAL"))?.textContent?.trim();
    return {
      rightButtonsCount: buttons.length,
      rightButtons: buttons,
      ccBtn,
    };
  })()`);
  console.log("Clean player right-side inspection:", rightButtons);

  // Take screenshot of uncluttered player
  await takeScreenshotWithVideo("aurastream_live_clean_player.png");

  // 2. Click "More" button to open the Playback Options sheet
  const openMoreRes = await evalCode(`(() => {
    const moreBtn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("More") || b.getAttribute("aria-label")?.includes("More"));
    if (moreBtn) { moreBtn.click(); return true; }
    return false;
  })()`);
  console.log("Clicked More button:", openMoreRes);

  await wait(1200);

  // Inspect the Playback Options sheet contents
  const moreSheetData = await evalCode(`(() => {
    const sheet = document.querySelector(".ios-sheet, .ios-dialog");
    const headings = sheet ? Array.from(sheet.querySelectorAll("span, h2, h3, div")).map(el => el.textContent?.trim()).filter(Boolean) : [];
    const buttons = sheet ? Array.from(sheet.querySelectorAll("button")).map(b => b.textContent?.trim()).filter(Boolean) : [];
    return {
      isOpen: !!sheet,
      headings: headings.slice(0, 15),
      buttonsSample: buttons.slice(0, 15),
    };
  })()`);
  console.log("Playback Options Sheet inspection:", moreSheetData);

  // Take screenshot of the Playback Options sheet
  await takeScreenshotWithVideo("aurastream_live_playback_options_sheet.png");

  ws.close();
  console.log("Clean player verification completed successfully!");
}

run().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
