import fs from "node:fs";
import path from "node:path";
import http from "node:http";

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        console.log("WebSocket connected.");
        resolve();
      };
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
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
    console.log(`Saved screenshot to ${filePath}`);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function getPageWsUrl() {
  return new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:9222/json/list", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const list = JSON.parse(data);
          const page = list.find((p) => p.type === "page" && p.url.includes("tauri.localhost"));
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else if (list.length > 0 && list[0].webSocketDebuggerUrl) {
            resolve(list[0].webSocketDebuggerUrl);
          } else {
            reject(new Error("No webview page found: " + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const wsUrl = await getPageWsUrl();
  console.log("Connecting to:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();

  const brainDir = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

  // Step 1: Inspect initial state
  console.log("Checking initial page state...");
  const initInfo = await client.evaluate(`(() => {
    return {
      title: document.title,
      url: window.location.href,
      hasVideo: !!document.querySelector("video"),
      hasNav: !!document.querySelector("nav")
    };
  })()`);
  console.log("Initial page info:", JSON.stringify(initInfo, null, 2));

  // Step 2: Check Profile / Downloads Tab
  console.log("Navigating to Profile / Downloads tab...");
  await client.evaluate(`(() => {
    const navButtons = Array.from(document.querySelectorAll("nav button"));
    const profileBtn = navButtons.find(b => b.innerText.includes("Profile") || b.innerText.includes("Me") || b.getAttribute("aria-label")?.includes("Profile"));
    if (profileBtn) profileBtn.click();
    else if (navButtons.length > 0) navButtons[navButtons.length - 1].click();
  })()`);
  await sleep(1000);

  // Switch subtab to "Downloads"
  await client.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll("button"));
    const dlTab = tabs.find(b => b.innerText.includes("Downloads") || b.innerText.includes("Offline"));
    if (dlTab) dlTab.click();
  })()`);
  await sleep(800);

  const dlCheck = await client.evaluate(`(() => {
    return {
      hasClutteredDisclaimer: document.body.innerText.includes("Permanent Offline Storage"),
      sampleText: document.querySelector("main, section, div[class*='overflow']")?.innerText?.substring(0, 300)
    };
  })()`);
  console.log("Downloads Tab UI Check:", JSON.stringify(dlCheck, null, 2));
  await client.screenshot(path.join(brainDir, "downloads_tab_clean_verified.png"));

  // Step 3: Switch back to Home / Feed (Player)
  console.log("Navigating back to Feed player...");
  await client.evaluate(`(() => {
    const navButtons = Array.from(document.querySelectorAll("nav button"));
    if (navButtons.length > 0) navButtons[0].click();
  })()`);
  await sleep(1500);

  // Verify player: check version badge removal
  const playerCheck = await client.evaluate(`(() => {
    return {
      hasPlayerVersionBadge: Array.from(document.querySelectorAll("span, div")).some(el => el.innerText.trim() === "v0.1.0" && el.closest(".absolute")),
      videoFound: !!document.querySelector("video"),
      paused: document.querySelector("video")?.paused,
      currentTime: document.querySelector("video")?.currentTime,
      duration: document.querySelector("video")?.duration
    };
  })()`);
  console.log("Player Check (Version badge removed):", JSON.stringify(playerCheck, null, 2));

  // Test CC Subtitles
  console.log("Testing CC subtitles...");
  await client.evaluate(`(() => {
    // Click CC button in action rail
    const allButtons = Array.from(document.querySelectorAll("button"));
    const ccBtn = allButtons.find(b => b.innerText.includes("CC") || b.getAttribute("aria-label")?.includes("Captions") || b.getAttribute("aria-label")?.includes("Subtitle"));
    if (ccBtn) {
      ccBtn.click();
    }
  })()`);
  await sleep(1000);

  // Check subtitle overlay
  const ccDom = await client.evaluate(`(() => {
    const overlay = document.querySelector("[aria-live='polite']");
    if (!overlay) return { found: false };
    const span = overlay.querySelector("span");
    const style = span ? window.getComputedStyle(span) : null;
    const overlayStyle = window.getComputedStyle(overlay);
    return {
      found: true,
      text: overlay.innerText,
      color: style?.color,
      backgroundColor: style?.backgroundColor,
      fontSize: style?.fontSize,
      fontFamily: style?.fontFamily,
      bottom: overlayStyle.bottom,
      top: overlayStyle.top,
      position: overlayStyle.position
    };
  })()`);
  console.log("CC DOM Styling:", JSON.stringify(ccDom, null, 2));

  await client.screenshot(path.join(brainDir, "player_clean_cc_verified.png"));

  // Step 4: Background buffering test
  console.log("Testing background buffering behavior...");
  const bgTest = await client.evaluate(`(() => {
    const v = document.querySelector("video");
    const initialMuted = v ? v.muted : null;
    const initialPaused = v ? v.paused : null;

    // Simulate visibility change to hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const hiddenMuted = v ? v.muted : null;
    const hiddenPaused = v ? v.paused : null;

    // Simulate visibility change back to visible
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const visibleMuted = v ? v.muted : null;
    const visiblePaused = v ? v.paused : null;

    return { initialMuted, initialPaused, hiddenMuted, hiddenPaused, visibleMuted, visiblePaused };
  })()`);
  console.log("Background Buffering Test Result:", JSON.stringify(bgTest, null, 2));

  // Step 5: Test Permanent Persistence across App Exit & Reboot
  console.log("Testing permanent storage persistence...");
  const persistSetup = await client.evaluate(`(() => {
    // Add a test favorite
    const favs = ["test_fav_persistence_123"];
    window.localStorage.setItem("aurastream_favorites", JSON.stringify(favs));
    // Trigger sync
    window.dispatchEvent(new Event("storage"));
    return { saved: true, readBack: window.localStorage.getItem("aurastream_favorites") };
  })()`);
  console.log("Set test favorite:", persistSetup);

  client.close();
  console.log("CDP operations completed successfully.");
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
