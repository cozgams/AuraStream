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

  // 1. Switch to Profile -> Downloads tab
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button, [role=tab]"));
      const profileBtn = buttons.find(b => (b.innerText || "").toLowerCase().includes("profile") || (b.getAttribute("aria-label") || "").toLowerCase().includes("profile"));
      if (profileBtn) profileBtn.click();
    })()
  `);
  await wait(1000);

  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const dlBtn = buttons.find(b => (b.innerText || "").trim() === "Downloads");
      if (dlBtn) dlBtn.click();
    })()
  `);
  await wait(1000);

  // 2. Click Export Series or Export on the downloaded item
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const expBtn = buttons.find(b => (b.innerText || "").includes("Export Series") || (b.innerText || "").includes("Export All"));
      if (expBtn) expBtn.click();
    })()
  `);
  await wait(1200);

  await screenshot("aurastream_exportsheet_subtitles_and_gallery");

  // 3. Click "Export .SRT" inside ExportSheet
  console.log("Triggering Export .SRT in ExportSheet...");
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const srtBtn = buttons.find(b => (b.innerText || "").includes("Export .SRT"));
      if (srtBtn) srtBtn.click();
    })()
  `);

  await wait(2000);
  await screenshot("aurastream_exportsheet_success_with_gallery_button");

  ws.close();
  console.log("Capture completed!");
}

run().catch(console.error);
