import fs from "node:fs";
import path from "node:path";

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
  const res = await fetch("http://127.0.0.1:9222/json");
  const pages = await res.json();
  const page = pages.find((p) => p.type === "page" && p.url.includes("tauri.localhost"));
  if (!page) throw new Error("No tauri page found: " + JSON.stringify(pages));
  return page.webSocketDebuggerUrl;
}

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function main() {
  const wsUrl = await getPageWsUrl();
  console.log("Connecting to:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("Page.enable");
  await client.send("Runtime.enable");

  // Step 1: Clean Player Screen
  console.log("Capturing Step 1: Clean Player Screen...");
  await client.screenshot(path.join(ARTIFACT_DIR, "refined_step1_player_clean.png"));

  // Step 2: Open Subtitle Sheet
  console.log("Tapping CC button to open Subtitle Customization Sheet...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cc = btns.find(b => b.innerText.trim() === 'CC' || b.getAttribute('aria-label')?.includes('ubtitle') || b.getAttribute('title')?.includes('Caption'));
      if (cc) cc.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
  await client.screenshot(path.join(ARTIFACT_DIR, "refined_step2_subtitle_sheet.png"));

  // Select Large size and Yellow preset in Subtitle Sheet
  console.log("Selecting Large size and Yellow preset...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const largeBtn = btns.find(b => b.innerText.includes('Large') || b.innerText.includes('LG') || b.innerText.includes('XL'));
      if (largeBtn) largeBtn.click();
      const netflixBtn = btns.find(b => b.innerText.includes('Yellow') || b.innerText.includes('Netflix'));
      if (netflixBtn) netflixBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1200));
  await client.screenshot(path.join(ARTIFACT_DIR, "refined_step3_subtitle_customized.png"));

  // Close Subtitle Sheet
  console.log("Closing Subtitle Sheet...");
  await client.evaluate(`
    (() => {
      const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('✕') || b.getAttribute('aria-label') === 'Close');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
  await client.screenshot(path.join(ARTIFACT_DIR, "refined_step4_player_with_cc.png"));

  client.close();
  console.log("Refinement verification complete!");
}

main().catch(err => {
  console.error("Verification error:", err);
  process.exit(1);
});
