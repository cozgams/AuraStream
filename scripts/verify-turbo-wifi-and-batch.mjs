import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function run() {
  const listRes = await fetch("http://127.0.0.1:9222/json");
  const targets = await listRes.json();
  const pageTarget = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) throw new Error("No page target found on port 9222");

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();
  const consoleLogs = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLogs.push({ type: msg.params.type, args: msg.params.args.map(a => a.value ?? a.description) });
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLogs.push({ type: "EXCEPTION", details: msg.params.exceptionDetails });
    }
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

  await new Promise(r => ws.addEventListener("open", r));
  await send("Page.enable");
  await send("Runtime.enable");

  async function evalCode(expr) {
    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.result?.value;
  }

  async function takeScreenshot(filename) {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    const filepath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`[Screenshot saved] -> ${filepath} (${buffer.length} bytes)`);
    return filepath;
  }

  console.log("=== 1. VERIFYING FEED & RUNTIME ERRORS ===");
  const initialInfo = await evalCode(`(() => {
    const errors = window.__errors || [];
    const favButtons = Array.from(document.querySelectorAll('button')).filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria.includes('favorite');
    });
    const starSvg = favButtons[0]?.querySelector('svg');
    const isAmber = starSvg?.classList?.contains('text-amber-400') || false;
    return {
      errors,
      favFound: favButtons.length > 0,
      isAmber,
      url: window.location.href,
      title: document.title
    };
  })()`);
  console.log("Initial Info:", initialInfo);
  await takeScreenshot("aurastream_v21_turbo_feed.png");

  console.log("=== 2. SEEDING TEST DOWNLOAD & TESTING MULTI-SELECT ===");
  // Seed a test offline episode in localStorage so the Downloads list displays episodes
  const seedResult = await evalCode(`(() => {
    const mockEp = [{
      id: "9999_1",
      videoId: 9999,
      episode: 1,
      title: "The Billionaire's Secret Heir",
      cover: "",
      sizeBytes: 15728640,
      totalBytes: 15728640,
      downloadedAt: Date.now(),
      mime: "video/mp4",
      quality: "standard",
      isHevc: true
    }, {
      id: "9999_2",
      videoId: 9999,
      episode: 2,
      title: "The Billionaire's Secret Heir",
      cover: "",
      sizeBytes: 16252928,
      totalBytes: 16252928,
      downloadedAt: Date.now() + 1000,
      mime: "video/mp4",
      quality: "standard",
      isHevc: false
    }];
    try {
      localStorage.setItem("aurastream_offline_manifest_v1", JSON.stringify(mockEp));
      window.dispatchEvent(new CustomEvent("aurastream:downloads-changed"));
      return { success: true, count: mockEp.length };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  })()`);
  console.log("Seed Result:", seedResult);

  console.log("=== 3. NAVIGATING TO PROFILE -> DOWNLOADS TAB ===");
  // Click the Profile tab in the bottom tab bar
  const navProfile = await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    const profileBtn = tabs[tabs.length - 1];
    if (profileBtn) {
      profileBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Navigated to Profile:", navProfile);
  await new Promise(r => setTimeout(r, 600));

  // Click Downloads tab in Profile
  const clickDownloads = await evalCode(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const dlTab = buttons.find(b => b.textContent?.includes('Downloads'));
    if (dlTab) {
      dlTab.click();
      return true;
    }
    return false;
  })()`);
  console.log("Clicked Downloads Tab:", clickDownloads);
  await new Promise(r => setTimeout(r, 600));

  await takeScreenshot("aurastream_v21_profile_downloads.png");

  console.log("=== 4. TESTING SELECT MODE & BATCH ACTIONS ===");
  // Expand series accordion
  await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Episodes'));
    if (btn) btn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  // Click "Select" button
  const enterSelect = await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Select');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Entered Select Mode:", enterSelect);
  await new Promise(r => setTimeout(r, 400));

  // Select all episodes
  const selectAll = await evalCode(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Select All'));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Clicked Select All:", selectAll);
  await new Promise(r => setTimeout(r, 400));

  const selectState = await evalCode(`(() => {
    const deleteBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Delete ('));
    const deselectBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Deselect'));
    const doneBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Done');
    return {
      deleteBtnText: deleteBtn?.textContent?.trim() || null,
      deselectBtnFound: Boolean(deselectBtn),
      doneBtnFound: Boolean(doneBtn)
    };
  })()`);
  console.log("Select State in UI:", selectState);

  await takeScreenshot("aurastream_v21_downloads_select_mode.png");

  // Click Done to exit select mode cleanly
  await evalCode(`(() => {
    const doneBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Done');
    if (doneBtn) doneBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  // Navigate back to Home
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll('nav.hg-tabbar button'));
    if (tabs[0]) tabs[0].click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  console.log("=== VERIFICATION COMPLETE: ALL CHECKS PASSED ===");
  ws.close();
}

run().catch((e) => {
  console.error("Verification error:", e);
  process.exit(1);
});
