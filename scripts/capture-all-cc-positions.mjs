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
      this.ws.onclose = () => console.log("CDP closed");
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
  return page.webSocketDebuggerUrl;
}

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function main() {
  const wsUrl = await getPageWsUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  console.log("1. Inject sample subtitle display for position visual verification...");
  await client.evaluate(`
    (() => {
      const overlay = Array.from(document.querySelectorAll("div")).find(d => d.getAttribute("aria-live") === "polite");
      if (overlay) {
        overlay.classList.remove("opacity-0", "scale-95");
        overlay.classList.add("opacity-100", "scale-100");
        const span = overlay.querySelector("span");
        if (span) {
          span.textContent = "[AuraStream CC] Customized Subtitle Position";
        }
      }
    })()
  `);

  // Position 1: Downside (bottom)
  console.log("Setting position to 'bottom' (Downside)...");
  await client.evaluate(`
    (() => {
      const updated = { color: 'white', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'translucent', bgOpacity: 80, position: 'bottom', customOffsetPercent: 12 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_pos1_downside.png"));

  // Position 2: Above Title
  console.log("Setting position to 'above_title'...");
  await client.evaluate(`
    (() => {
      const updated = { color: 'yellow', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'translucent', bgOpacity: 80, position: 'above_title', customOffsetPercent: 32 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_pos2_above_title.png"));

  // Position 3: Middle (50%)
  console.log("Setting position to 'middle' (50%)...");
  await client.evaluate(`
    (() => {
      const updated = { color: 'cyan', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'translucent', bgOpacity: 80, position: 'middle', customOffsetPercent: 50 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_pos3_middle.png"));

  // Position 4: Top (85%)
  console.log("Setting position to 'top' (85%)...");
  await client.evaluate(`
    (() => {
      const updated = { color: 'green', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'translucent', bgOpacity: 80, position: 'top', customOffsetPercent: 85 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_pos4_top.png"));

  // Position 5: Custom Height Slider (72%)
  console.log("Setting position to 'custom' (72% height)...");
  await client.evaluate(`
    (() => {
      const updated = { color: 'white', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'solid', bgOpacity: 100, position: 'custom', customOffsetPercent: 72 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);
  await new Promise(r => setTimeout(r, 400));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_pos5_custom_72pct.png"));

  // 2. Open Subtitle Sheet and capture the interactive preview box and slider
  console.log("Opening CC Subtitle Sheet to capture interactive position preview...");
  await client.evaluate(`
    (() => {
      const optionsBtn = document.querySelector('button[aria-label="More Options"]');
      if (optionsBtn) {
        optionsBtn.click();
        setTimeout(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const customizeBtn = btns.find(b => b.innerText.includes('Customize Styles'));
          if (customizeBtn) customizeBtn.click();
        }, 300);
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_sheet_interactive_preview.png"));

  // Close sheet
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
      if (closeBtn) closeBtn.click();
      else {
        const bd = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/70');
        if (bd) bd.click();
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 600));

  // Reset to default downside cleanly
  await client.evaluate(`
    (() => {
      const updated = { color: 'white', edgeStyle: 'drop_shadow', font: 'sans', bgStyle: 'translucent', bgOpacity: 80, position: 'bottom', customOffsetPercent: 12 };
      localStorage.setItem('aurastream_subtitle_style_v2', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('aurastream:subtitlestyle-changed', { detail: updated }));
    })()
  `);

  console.log("Done capturing all CC position and sheet screenshots!");
  client.close();
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
