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

  // Inspect the CC button
  const btnInfo = await client.evaluate(`
    (() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const ccBtn = allBtns.find(b => b.title && b.title.includes('Captions'));
      if (!ccBtn) return { found: false, count: allBtns.length };
      return {
        found: true,
        title: ccBtn.title,
        aria: ccBtn.getAttribute('aria-label'),
        rect: ccBtn.getBoundingClientRect()
      };
    })()
  `);
  console.log("CC Button Info:", btnInfo);

  if (btnInfo.found) {
    // Tap the CC button using touch / click
    console.log("Tapping CC button...");
    await client.evaluate(`
      (() => {
        const ccBtn = Array.from(document.querySelectorAll('button')).find(b => b.title && b.title.includes('Captions'));
        if (ccBtn) {
          ccBtn.click();
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));

    // Check if dialog opened
    const dialogOpen = await client.evaluate(`
      (() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog ? { open: true, text: dialog.innerText.slice(0, 200) } : { open: false };
      })()
    `);
    console.log("Dialog open status:", dialogOpen);

    // Scroll dialog to view all controls
    console.log("Scrolling dialog down...");
    await client.evaluate(`
      (() => {
        const sheetContent = document.querySelector('[role="dialog"] > div');
        if (sheetContent) {
          sheetContent.scrollTop = 220;
        }
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));
    await client.screenshot(path.join(ARTIFACT_DIR, "cc_sheet_scrolled.png"));

    // Select XL font size and Above Title position
    console.log("Testing XL size and Above Title position...");
    await client.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const xlBtn = btns.find(b => b.innerText.includes('XL') || b.innerText.includes('Extra Large'));
        if (xlBtn) xlBtn.click();
        const aboveBtn = btns.find(b => b.innerText.includes('Above Title'));
        if (aboveBtn) aboveBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 1000));
    await client.screenshot(path.join(ARTIFACT_DIR, "cc_sheet_customized.png"));
  }
  client.close();
}

main().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
