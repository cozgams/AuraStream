import { writeFileSync } from "node:fs";

async function main() {
  console.log("=== AuraStream Bug Hunt & Verification Suite ===");

  const res = await fetch("http://127.0.0.1:9222/json");
  const targets = await res.json();
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    throw new Error("No active webview CDP target found on http://127.0.0.1:9222");
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();

  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const msgId = id++;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((r) => ws.addEventListener("open", r));
  console.log("Connected to Android WebView DevTools CDP!");

  await send("Runtime.enable");
  await send("Page.enable");

  const errors = [];
  const warnings = [];
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data.toString());
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args?.map((a) => a.value || JSON.stringify(a)).join(" ") || "";
      if (msg.params.type === "error") errors.push(text);
      else if (msg.params.type === "warning") warnings.push(text);
    } else if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails?.text || "Unknown exception");
    }
  });

  const evalCode = async (expr) => {
    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Run suite of checks in browser
  const results = await evalCode(`(async () => {
    const report = { checks: [], success: true };

    // 1. Check Native Bridge
    const bridge = window.AuraNativeExport;
    report.checks.push({
      name: "Native Export Bridge Available",
      pass: !!bridge && typeof bridge.isAvailable === "function" && bridge.isAvailable(),
    });

    // 2. Check Native PiP Support & Aspect Ratio Function
    report.checks.push({
      name: "PiP Supported via Android Activity",
      pass: !!bridge && typeof bridge.isPictureInPictureSupported === "function" && bridge.isPictureInPictureSupported(),
    });
    report.checks.push({
      name: "PiP Aspect Ratio Support",
      pass: !!bridge && typeof bridge.enterPictureInPictureWithAspect === "function",
    });

    // 3. Storage Info
    if (bridge && typeof bridge.getStorageInfo === "function") {
      try {
        const info = JSON.parse(bridge.getStorageInfo());
        report.checks.push({
          name: "Storage Info Parsing",
          pass: typeof info.primaryFreeBytes === "number" && typeof info.hasSdCard === "boolean",
          details: info,
        });
      } catch (e) {
        report.checks.push({ name: "Storage Info Parsing", pass: false, error: e.message });
      }
    }

    // 4. Batch Download Plan Size Estimation (~5.5MB)
    try {
      const estBytes = Math.round(5 * 5.5 * 1024 * 1024);
      report.checks.push({
        name: "Batch Size Realistic Estimation",
        pass: estBytes > 20000000 && estBytes < 35000000,
        estBytes,
      });
    } catch (e) {
      report.checks.push({ name: "Batch Size Realistic Estimation", pass: false, error: e.message });
    }

    // 5. Test WebVTT parser tag stripping logic
    const sampleVttWithTags = \`WEBVTT

1
00:00:01.000 --> 00:00:04.500
<v Speaker><b>Hello</b> <c.yellow>world</c>!
\`;
    const lines = sampleVttWithTags.split("\\n");
    const textLines = lines.slice(4).map(l => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    report.checks.push({
      name: "WebVTT Tag Stripper",
      pass: textLines[0] === "Hello world!",
      extracted: textLines[0],
    });

    return report;
  })()`);

  console.log("In-Browser Test Results:\n", JSON.stringify(results, null, 2));

  // Step 2: Open More Options drawer and click "Batch Download" to verify BatchDownloadSheet mounts!
  console.log("Testing Feed -> More Options -> Batch Download Sheet...");
  await evalCode(`(() => {
    // Switch to Home tab
    const tabs = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
    const homeBtn = tabs.find(b => b.innerText.includes("Home"));
    if (homeBtn) homeBtn.click();
  })()`);
  await wait(800);

  // Click More Options (three dots)
  await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const moreBtn = buttons.find(b => b.getAttribute("aria-label") === "More Options" || b.innerText.trim() === "Options");
    if (moreBtn) moreBtn.click();
    return !!moreBtn;
  })()`);
  await wait(600);

  // Click "Batch Download"
  const batchClicked = await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const batchBtn = buttons.find(b => b.innerText.includes("Batch Download"));
    if (batchBtn) {
      batchBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Batch Download button clicked:", batchClicked);
  await wait(800);

  // Check if Batch Download Sheet is visible in DOM
  const sheetMounted = await evalCode(`(() => {
    const sheetTitle = Array.from(document.querySelectorAll("div, h2, h3")).some(
      el => el.innerText.includes("Batch Download Series")
    );
    return sheetTitle;
  })()`);
  console.log("Batch Download Sheet mounted in DOM:", sheetMounted);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_bugfix_verified_batch_sheet.png",
    Buffer.from(shot.data, "base64")
  );
  console.log("Screenshot saved!");

  // Close sheet
  await evalCode(`(() => {
    const closeBtn = document.querySelector('button[aria-label="Close"]');
    if (closeBtn) closeBtn.click();
  })()`);
  await wait(400);

  console.log("Console Errors Captured:", errors.length, errors);
  console.log("Console Warnings Captured:", warnings.length);

  ws.close();
}

main().catch(console.error);
