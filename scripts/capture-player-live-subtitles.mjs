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
      this.ws.onopen = () => resolve();
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
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
        const list = JSON.parse(data);
        const page = list.find((p) => p.type === "page" && p.url.includes("tauri.localhost")) || list[0];
        resolve(page.webSocketDebuggerUrl);
      });
    }).on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const wsUrl = await getPageWsUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();

  const brainDir = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

  // Close any modal sheet
  await client.evaluate(`(() => {
    const closeBtn = document.querySelector("button[aria-label='Close'], button[aria-label='close']");
    if (closeBtn) closeBtn.click();
    // Also simulate escape key or click backdrop
    const backdrop = document.querySelector(".fixed.inset-0.bg-black\\\\/60, .sheet-backdrop");
    if (backdrop) backdrop.click();
  })()`);
  await sleep(600);

  // Ensure on home feed
  await client.evaluate(`(() => {
    const navButtons = Array.from(document.querySelectorAll("nav button"));
    if (navButtons.length > 0) navButtons[0].click();
  })()`);
  await sleep(800);

  // Play video and seek to 2.5s where first cue is active
  await client.evaluate(`(() => {
    const v = document.querySelector("video");
    if (v) {
      v.currentTime = 2.5;
      v.play();
    }
  })()`);
  await sleep(1200);

  const cueState = await client.evaluate(`(() => {
    const overlay = document.querySelector("[aria-live='polite']");
    const v = document.querySelector("video");
    return {
      currentTime: v?.currentTime,
      paused: v?.paused,
      hasOverlay: !!overlay,
      text: overlay?.innerText,
      bottom: overlay ? window.getComputedStyle(overlay).bottom : null
    };
  })()`);
  console.log("Live Cue State:", cueState);

  await client.screenshot(path.join(brainDir, "player_live_cc_active.png"));

  client.close();
}

main().catch(console.error);
