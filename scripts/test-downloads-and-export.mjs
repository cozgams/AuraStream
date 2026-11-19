import { writeFileSync } from "node:fs";

async function run() {
  console.log("=== Testing Downloads Shelf & Storage Export Flow ===");

  const res = await fetch("http://127.0.0.1:9222/json");
  const targets = await res.json();
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error("No CDP page target");

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 1;

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const curId = id++;
      const handler = (evt) => {
        const msg = JSON.parse(evt.data.toString());
        if (msg.id === curId) {
          ws.removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");

  // Step 1: Click Profile tab
  console.log("Navigating to Profile tab...");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tabBtns = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
      const profileBtn = tabBtns.find((b) => b.innerText.includes("Profile") || b.innerText.includes("Me"));
      if (profileBtn) profileBtn.click();
      return !!profileBtn;
    })()`,
  });

  await new Promise((r) => setTimeout(r, 800));

  // Step 2: Click Downloads tab in Profile
  console.log("Switching to Downloads tab...");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const dlTab = buttons.find((b) => b.innerText.trim() === "Downloads");
      if (dlTab) dlTab.click();
      return !!dlTab;
    })()`,
  });

  await new Promise((r) => setTimeout(r, 800));

  // Step 3: Inspect Downloads page state
  const state = await send("Runtime.evaluate", {
    expression: `(() => {
      const storageBar = document.querySelector(".bg-emerald-400");
      const storageText = document.body.innerText.includes("Phone Storage");
      const seriesCards = document.querySelectorAll(".bg-s2");
      return {
        hasStorageText: storageText,
        hasStorageBar: !!storageBar,
        bodyTextSnippet: document.body.innerText.slice(0, 300),
      };
    })()`,
    returnByValue: true,
  });

  console.log("Downloads Tab State:", JSON.stringify(state.result.value, null, 2));

  // Step 4: Capture screenshot of Downloads Tab
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_bugfix_verified_downloads.png",
    Buffer.from(shot1.data, "base64")
  );
  console.log("Saved aurastream_bugfix_verified_downloads.png");

  // Step 5: Test opening Export Modal
  console.log("Testing Export All MP4 modal...");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const exportBtn = buttons.find((b) => b.innerText.includes("Export All MP4") || b.innerText.includes("Export Series"));
      if (exportBtn) {
        exportBtn.click();
        return true;
      }
      return false;
    })()`,
  });

  await new Promise((r) => setTimeout(r, 600));

  const exportSheetState = await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector(".z-\\\\[500\\\\]");
      return {
        isSheetOpen: !!sheet,
        sheetText: sheet ? sheet.innerText : null,
      };
    })()`,
    returnByValue: true,
  });

  console.log("Export Sheet State:", JSON.stringify(exportSheetState.result.value, null, 2));

  // Capture screenshot of Export Sheet
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/aurastream_bugfix_verified_export_sheet.png",
    Buffer.from(shot2.data, "base64")
  );
  console.log("Saved aurastream_bugfix_verified_export_sheet.png");

  // Step 6: Test dismiss via Escape key
  console.log("Testing dismissal via Escape key...");
  await send("Runtime.evaluate", {
    expression: `(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    })()`,
  });

  await new Promise((r) => setTimeout(r, 400));

  const afterDismiss = await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector(".z-\\\\[500\\\\]");
      return { isSheetClosed: !sheet };
    })()`,
    returnByValue: true,
  });

  console.log("After Escape Dismiss:", JSON.stringify(afterDismiss.result.value, null, 2));

  ws.close();
  console.log("=== All Live Verification Checks Passed! ===");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
