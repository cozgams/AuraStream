import fs from "node:fs";

async function run() {
  const targetsRes = await fetch("http://127.0.0.1:9222/json");
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    console.error("No active page target found");
    process.exit(1);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = idCounter++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((r) => ws.addEventListener("open", r));
  console.log("Connected to CDP for ExportSheet UI test");

  await send("Page.enable");
  await send("Runtime.enable");

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalCode = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  async function screenshot(name) {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(res.result.data, "base64");
    const path = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}.png`;
    fs.writeFileSync(path, buf);
    console.log(`Saved screenshot: ${path}`);
  }

  // Go to Profile -> Downloads tab
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button, [role=tab]"));
      const dlBtn = buttons.find(b => (b.innerText || "").trim() === "Downloads");
      if (dlBtn) dlBtn.click();
    })()
  `);
  await wait(1000);
  await screenshot("live_step5_downloads_tab");

  // Open ExportSheet from the downloaded drama
  const exportOpenResult = await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const expBtn = buttons.find(b => (b.innerText || "").includes("Export MP4") || (b.innerText || "").includes("Export Series"));
      if (expBtn) {
        expBtn.click();
        return "Clicked Export button";
      }
      return "Export button not found";
    })()
  `);
  console.log("Export Open Result:", exportOpenResult);

  await wait(1200);
  await screenshot("live_step6_export_sheet_subtitles");

  const exportSheetElements = await evalCode(`
    (() => {
      const text = document.body.innerText;
      return {
        hasBundleSubtitles: text.includes("Bundle Subtitles (.SRT)"),
        hasStandaloneSubtitles: text.includes("Standalone Subtitle Tracks"),
        hasExportSrtBtn: text.includes("Export .SRT"),
        hasExportVttBtn: text.includes("Export .VTT"),
        hasMoviesTarget: text.includes("Phone Gallery & Movies"),
        hasDownloadsTarget: text.includes("Phone Downloads Folder"),
      };
    })()
  `);
  console.log("ExportSheet Elements:", exportSheetElements);

  // Click "Export .SRT" in ExportSheet to test UI-driven subtitle export
  console.log("Clicking 'Export .SRT' in ExportSheet...");
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const srtBtn = buttons.find(b => (b.innerText || "").includes("Export .SRT"));
      if (srtBtn) srtBtn.click();
    })()
  `);

  await wait(2000);
  await screenshot("live_step7_export_sheet_success_gallery_btn");

  const successState = await evalCode(`
    (() => {
      const text = document.body.innerText;
      return {
        hasSuccessMsg: text.includes("Saved subtitle") || text.includes("Saved to"),
        hasOpenGalleryBtn: text.includes("Open in Gallery"),
        hasDoneBtn: text.includes("Done"),
      };
    })()
  `);
  console.log("Success & Gallery Button State:", successState);

  ws.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
