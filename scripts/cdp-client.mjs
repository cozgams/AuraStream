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
      this.ws.onopen = () => {
        console.log("WebSocket connected successfully.");
        resolve();
      };
      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = (ev) => {
        console.log("WebSocket closed:", ev.code, ev.reason);
      };
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

  // Step 1: Current player screen
  console.log("Capturing Step 1: Player View...");
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_step1_player.png"));

  // Step 2: Open Subtitle / CC Sheet
  console.log("Opening CC Subtitle Sheet...");
  const ccFound = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cc = btns.find(b => b.innerText.trim() === 'CC' || b.getAttribute('aria-label')?.includes('ubtitle'));
      if (cc) {
        cc.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("CC button found & clicked:", ccFound);
  await new Promise(r => setTimeout(r, 1500));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_step2_cc_sheet.png"));

  // Close CC sheet
  console.log("Closing CC sheet...");
  await client.evaluate(`
    (() => {
      const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Done') || b.innerText.includes('✕') || b.getAttribute('aria-label') === 'Close');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // Step 3: Open Download Choice Sheet
  console.log("Opening Download Choice Sheet...");
  const dlFound = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dl = btns.find(b => b.innerText.includes('Save') || b.getAttribute('aria-label')?.includes('Save') || b.innerText.includes('Download') || b.getAttribute('aria-label')?.includes('Download'));
      if (dl) {
        dl.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("Download / Save button clicked:", dlFound);
  await new Promise(r => setTimeout(r, 1500));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_step3_download_sheet.png"));

  const sheetInfo = await client.evaluate(`
    (() => {
      const text = document.body.innerText;
      return {
        hasEpisodeStrip: text.includes('Select Episode') || text.includes('Ep. 1') || text.includes('Ep.'),
        hasDownloadEpisode: text.includes('Download Episode') || text.includes('Download Single'),
        hasFullSeason: text.includes('Download Full Season'),
        hasStorage: text.includes('Free Device Storage') || text.includes('Available') || text.includes('Free:')
      };
    })()
  `);
  console.log("Download Choice Sheet verification:", sheetInfo);

  // Close Download Choice Sheet
  console.log("Closing Download Choice sheet...");
  await client.evaluate(`
    (() => {
      const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('✕') || b.getAttribute('aria-label') === 'Close');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // Step 4: Navigate to Profile -> Downloads tab
  console.log("Navigating to Profile Tab...");
  await client.evaluate(`
    (() => {
      const navBtns = Array.from(document.querySelectorAll('button, a'));
      const profile = navBtns.find(b => b.innerText.trim() === 'Profile' || b.getAttribute('aria-label')?.includes('Profile'));
      if (profile) profile.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));

  // Switch to Downloads segment
  console.log("Switching to Downloads segment...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dlSegment = btns.find(b => b.innerText.trim() === 'Downloads');
      if (dlSegment) dlSegment.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_step4_downloads_clean_tab.png"));

  const profileInfo = await client.evaluate(`
    (() => {
      const text = document.body.innerText;
      return {
        hasDownloadsTitle: text.includes('Downloads'),
        hasPermanentStorageNote: text.includes('Permanent Offline Storage') || text.includes('never auto-delete'),
        hasMB: text.includes('MB') || text.includes('KB') || text.includes('offline')
      };
    })()
  `);
  console.log("Downloads Tab verification:", profileInfo);

  client.close();
  console.log("Done all steps successfully!");
}

main().catch(err => {
  console.error("Error in CDP client:", err);
  process.exit(1);
});
