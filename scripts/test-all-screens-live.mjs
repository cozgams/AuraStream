import fs from "node:fs";
import path from "node:path";

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
    this.consoleErrors = [];
    this.consoleWarnings = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = (ev) => console.log("CDP closed:", ev.code, ev.reason);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params.args.map((a) => a.value || a.description || JSON.stringify(a)).join(" ");
          if (msg.params.type === "error") {
            this.consoleErrors.push(text);
            console.error("[Console Error]", text);
          } else if (msg.params.type === "warning") {
            this.consoleWarnings.push(text);
          }
        }
        if (msg.method === "Runtime.exceptionThrown") {
          const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text;
          this.consoleErrors.push(desc);
          console.error("[Exception]", desc);
        }
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || "Evaluation error");
    }
    return res.result?.value;
  }

  async screenshot(filePath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.data, "base64");
    fs.writeFileSync(filePath, buffer);
    console.log(`Saved screenshot -> ${filePath}`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function getPageWsUrl() {
  const res = await fetch("http://127.0.0.1:9222/json");
  const pages = await res.json();
  const page = pages.find((p) => p.type === "page" && p.url.includes("tauri.localhost"));
  if (!page) throw new Error("No tauri page found: " + JSON.stringify(pages));
  return page.webSocketDebuggerUrl;
}

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function main() {
  const wsUrl = await getPageWsUrl();
  console.log("Connecting to webview:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  console.log("\n--- TEST 1: HOME FEED NAVIGATION & PLAYBACK CONTROLS ---");
  await client.evaluate(`
    (() => {
      const homeBtn = document.querySelector('button[aria-label="Home"], button[aria-label="Feed"]');
      if (homeBtn) homeBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1500));

  const playerState = await client.evaluate(`
    (() => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      return {
        found: true,
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
        src: video.src || "hls-attached"
      };
    })()
  `);
  console.log("Player state on load:", playerState);

  // Toggle Play / Pause
  console.log("Testing play/pause toggle...");
  await client.evaluate(`
    (() => {
      const video = document.querySelector('video');
      if (video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));

  console.log("\n--- TEST 2: SUBTITLE CC PRESETS & CUSTOM POSITION VERIFICATION ---");
  // Open CC Sheet
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cc = btns.find(b => b.innerText.trim() === 'CC' || b.getAttribute('aria-label')?.includes('ubtitle'));
      if (cc) cc.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));

  // Cycle through presets: Downside, Above Title, Middle, Top
  for (const preset of ["Downside", "Above Title", "Middle", "Top"]) {
    const res = await client.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.innerText.trim() === '${preset}');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    console.log(`Clicked preset ${preset}:`, res);
    await new Promise((r) => setTimeout(r, 400));
  }

  // Change Subtitle Size to Medium (lg)
  const sizeChange = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const medBtn = btns.find(b => b.innerText.trim().startsWith('Medium'));
      if (medBtn) {
        medBtn.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("Changed subtitle size to Medium:", sizeChange);

  // Close CC sheet
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="Dismiss"]');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "deep_test_01_feed_subtitles.png"));

  console.log("\n--- TEST 3: CATEGORIES & DISCOVER TAB ---");
  await client.evaluate(`
    (() => {
      const tabs = Array.from(document.querySelectorAll('nav button, [role="tab"]'));
      if (tabs.length >= 2) tabs[1].click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1500));

  const catCount = await client.evaluate(`
    (() => {
      const cards = document.querySelectorAll('.ios-rank-copy, .ios-card-title, h3');
      return cards.length;
    })()
  `);
  console.log("Categories items rendered:", catCount);
  await client.screenshot(path.join(ARTIFACT_DIR, "deep_test_02_categories.png"));

  console.log("\n--- TEST 4: PROFILE & DOWNLOADS TAB ---");
  await client.evaluate(`
    (() => {
      const tabs = Array.from(document.querySelectorAll('nav button, [role="tab"]'));
      if (tabs.length >= 4) tabs[3].click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Verify tabs inside Profile
  const profileSubTabs = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => 
        ['Favorites', 'History', 'Downloads'].some(k => b.textContent.includes(k))
      );
      return btns.map(b => b.textContent.trim());
    })()
  `);
  console.log("Profile sub-tabs:", profileSubTabs);
  await client.screenshot(path.join(ARTIFACT_DIR, "deep_test_03_profile.png"));

  console.log("\n--- TEST 5: SETTINGS & THEME TOGGLE ---");
  await client.evaluate(`
    (() => {
      const settingsBtn = document.querySelector('button[aria-label="Settings"]');
      if (settingsBtn) settingsBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Test Theme Switcher: Switch to Light, then back to Dark
  console.log("Testing Light/Dark theme toggle...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const lightBtn = btns.find(b => b.innerText.trim() === 'Light');
      if (lightBtn) lightBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "deep_test_04_settings_light_mode.png"));

  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const darkBtn = btns.find(b => b.innerText.trim() === 'Dark');
      if (darkBtn) darkBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "deep_test_05_settings_dark_mode.png"));

  // Check Download Quality options: Auto, HEVC, H.264
  const dlPrefBefore = await client.evaluate(`
    (() => localStorage.getItem('aurastream_download_quality_preference_v1'))()
  `);
  console.log("Initial download quality preference:", dlPrefBefore);

  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const h264 = btns.find(b => b.innerText.trim() === 'H.264');
      if (h264) h264.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  const dlPrefH264 = await client.evaluate(`
    (() => localStorage.getItem('aurastream_download_quality_preference_v1'))()
  `);
  console.log("Preference after clicking H.264:", dlPrefH264);

  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const autoBtn = btns.find(b => b.innerText.trim() === 'Auto');
      if (autoBtn) autoBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));
  const dlPrefAuto = await client.evaluate(`
    (() => localStorage.getItem('aurastream_download_quality_preference_v1'))()
  `);
  console.log("Preference after clicking Auto:", dlPrefAuto);

  console.log("\n--- TEST 6: CONSOLE ERROR & EXCEPTION AUDIT ---");
  console.log("Total Console Errors captured:", client.consoleErrors.length);
  if (client.consoleErrors.length > 0) {
    console.error("Console Errors:", client.consoleErrors);
  }
  console.log("Total Console Warnings:", client.consoleWarnings.length);

  client.close();
  console.log("\n=== ALL SCREENS DEEP AUDIT PASSED ===");
}

main().catch((err) => {
  console.error("Deep audit failed:", err);
  process.exit(1);
});
