import { writeFileSync } from "node:fs";

async function main() {
  console.log("=== AuraStream End-to-End Deep Flow Audit ===");

  const res = await fetch("http://127.0.0.1:9222/json");
  const targets = await res.json();
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error("No CDP page target");

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
  await send("Runtime.enable");
  await send("Page.enable");

  const errors = [];
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data.toString());
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      const text = msg.params.args?.map((a) => a.value || JSON.stringify(a)).join(" ") || "";
      errors.push(text);
    } else if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params.exceptionDetails?.text || "Exception thrown");
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
  const snap = async (name) => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}.png`;
    writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log(`Saved screenshot: ${p}`);
  };

  // 1. Test Search Tab & Surprise Me
  console.log("Navigating to Search Tab...");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
    const searchBtn = tabs.find(b => b.innerText.includes("Search"));
    if (searchBtn) searchBtn.click();
  })()`);
  await wait(1000);

  // Test Surprise Me button
  console.log("Tapping Surprise Me...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const surpriseBtn = btns.find(b => b.innerText.includes("Surprise Me"));
    if (surpriseBtn) surpriseBtn.click();
  })()`);
  await wait(1200);
  await snap("aurastream_bugaudit_search_surprise");

  // 2. Test Rankings Page
  console.log("Opening Rankings Page...");
  await evalCode(`(() => {
    const trophyBtn = document.querySelector(".ios-search-shortcut");
    if (trophyBtn) trophyBtn.click();
  })()`);
  await wait(1200);
  await snap("aurastream_bugaudit_rankings");

  // Back from Rankings
  await evalCode(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back"]');
    if (backBtn) backBtn.click();
  })()`);
  await wait(800);

  // 3. Test Category Tab & Channel Navigation
  console.log("Navigating to Category Tab...");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
    const catBtn = tabs.find(b => b.innerText.includes("Category") || b.innerText.includes("Channels"));
    if (catBtn) catBtn.click();
  })()`);
  await wait(1000);
  await snap("aurastream_bugaudit_category");

  // Open "Short Dramas" Channel
  console.log("Opening Short Dramas channel...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const channelBtn = btns.find(b => b.innerText.includes("Short Dramas"));
    if (channelBtn) channelBtn.click();
  })()`);
  await wait(1200);
  await snap("aurastream_bugaudit_channel_page");

  // Back from Channel
  await evalCode(`(() => {
    const backBtn = document.querySelector('button[aria-label="Back"]');
    if (backBtn) backBtn.click();
  })()`);
  await wait(800);

  // 4. Test Profile Tab & Continue Watching Bar
  console.log("Navigating to Profile Tab...");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
    const profileBtn = tabs.find(b => b.innerText.includes("Profile") || b.innerText.includes("Me"));
    if (profileBtn) profileBtn.click();
  })()`);
  await wait(1000);
  await snap("aurastream_bugaudit_profile");

  // Switch to Downloads Tab in Profile
  console.log("Switching to Downloads shelf...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const dlBtn = btns.find(b => b.innerText.trim() === "Downloads");
    if (dlBtn) dlBtn.click();
  })()`);
  await wait(800);
  await snap("aurastream_bugaudit_profile_downloads");

  // Switch back to Feed
  console.log("Returning to Feed...");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll(".ios-tabbar-btn"));
    const homeBtn = tabs.find(b => b.innerText.includes("Home"));
    if (homeBtn) homeBtn.click();
  })()`);
  await wait(1000);
  await snap("aurastream_bugaudit_feed_live");

  console.log("=== End of Audit ===");
  console.log("Total Console Errors:", errors.length);
  if (errors.length > 0) {
    console.error("Errors:", errors);
  }

  ws.close();
}

main().catch(console.error);
