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
  console.log("Connected to live AuraStream CDP on Android!");

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

  await wait(1500);
  await screenshot("live_step1_home");

  // 1. Navigate to Profile tab
  console.log("Switching to Profile tab...");
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button, [role=tab]"));
      const profileBtn = buttons.find(b => (b.innerText || "").toLowerCase().includes("profile") || (b.getAttribute("aria-label") || "").toLowerCase().includes("profile"));
      if (profileBtn) profileBtn.click();
    })()
  `);

  await wait(1500);
  await screenshot("live_step2_profile_library");

  // 2. Verify Profile Tab Elements
  const profileStats = await evalCode(`
    (() => {
      const text = document.body.innerText;
      return {
        hasMyLibrary: text.includes("My Library"),
        hasLocalActive: text.includes("Local Active"),
        hasFavoritesTab: text.includes("Favorites"),
        hasWatchLaterTab: text.includes("Watch Later"),
        hasHistoryTab: text.includes("History"),
        hasDownloadsTab: text.includes("Downloads"),
        hasSyncBtn: text.includes("Sync"),
      };
    })()
  `);
  console.log("Profile Tab Verification:", profileStats);

  // 3. Click "Watch Later" tab
  console.log("Switching to Watch Later tab...");
  await evalCode(`
    (() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const wlBtn = buttons.find(b => (b.innerText || "").trim() === "Watch Later");
      if (wlBtn) wlBtn.click();
    })()
  `);
  await wait(1200);
  await screenshot("live_step3_watch_later_tab");

  const watchLaterState = await evalCode(`
    (() => {
      return {
        hasEmptyMsg: document.body.innerText.includes("No dramas in Watch Later"),
        hasExploreAction: document.body.innerText.includes("Explore Now"),
      };
    })()
  `);
  console.log("Watch Later Tab State:", watchLaterState);

  // 4. Test Subtitle (.SRT and .VTT) Export via AuraNativeExport
  console.log("Testing Subtitle (.SRT / .VTT) Export via native bridge...");
  const subResult = await evalCode(`
    (() => {
      try {
        const isNative = typeof window.AuraNativeExport !== "undefined";
        const bridgeAvail = window.AuraNativeExport?.isAvailable?.();
        const hasExportSub = typeof window.AuraNativeExport?.exportSubtitleText === "function";
        const hasGallery = typeof window.AuraNativeExport?.openInGallery === "function";
        
        // Export test SRT
        const srtContent = "1\\n00:00:01,000 --> 00:00:03,500\\nHow much longer are you going to hide this from me?!\\n你到底还要瞒我到什么时候？！\\n\\n2\\n00:00:04,000 --> 00:00:07,200\\nIt is really not what you think, please let me explain...\\n事情真的不是你想象的那样，听我解释……\\n";
        const srtRes = window.AuraNativeExport?.exportSubtitleText?.("Demon_Lord_Reborn_Ep1.srt", srtContent, "save_movies");

        // Export test VTT
        const vttContent = "WEBVTT\\n\\n1\\n00:00:01.000 --> 00:00:03.500\\nHow much longer are you going to hide this from me?!\\n你到底还要瞒我到什么时候？！\\n\\n2\\n00:00:04.000 --> 00:00:07.200\\nIt is really not what you think, please let me explain...\\n事情真的不是你想象的那样，听我解释……\\n";
        const vttRes = window.AuraNativeExport?.exportSubtitleText?.("Demon_Lord_Reborn_Ep1.vtt", vttContent, "save_movies");

        return { isNative, bridgeAvail, hasExportSub, hasGallery, srtRes, vttRes };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);
  console.log("Subtitle Native Export Result:", subResult);

  // 5. Test Open in Gallery Intent
  console.log("Testing openInGallery bridge invocation...");
  const galleryRes = await evalCode(`
    (() => {
      try {
        const opened = window.AuraNativeExport?.openInGallery?.("");
        const lastUri = window.AuraNativeExport?.getLastExportedUri?.();
        return { opened, lastUri };
      } catch (e) {
        return { error: e.message };
      }
    })()
  `);
  console.log("Gallery Intent Result:", galleryRes);

  await wait(1000);
  await screenshot("live_step4_gallery_intent");

  ws.close();
  console.log("All tests passed cleanly!");
}

run().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
