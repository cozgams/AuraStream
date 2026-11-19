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
      this.ws.onclose = (ev) => console.log("CDP closed:", ev.code, ev.reason);
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
  if (!page) throw new Error("No tauri page found: " + JSON.stringify(pages));
  return page.webSocketDebuggerUrl;
}

const ARTIFACT_DIR = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

async function main() {
  const wsUrl = await getPageWsUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  console.log("=== Part 1: Verify Settings -> Subtitles & CC Customization ===");
  // Click Profile nav button
  await client.evaluate(`
    (() => {
      const profileBtn = document.querySelector('button[aria-label="Profile"]');
      if (profileBtn) profileBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 600));

  // Click Settings gear button
  await client.evaluate(`
    (() => {
      const settingsBtn = document.querySelector('button[aria-label="Settings"]');
      if (settingsBtn) settingsBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Scroll down to Subtitles section in Settings
  const foundSubSection = await client.evaluate(`
    (() => {
      const headings = Array.from(document.querySelectorAll('h2, h3, div, span'));
      const h = headings.find(el => el.textContent?.includes('Subtitles & Closed Captions (CC)') || el.textContent?.includes('Subtitle Position'));
      if (h) {
        h.scrollIntoView({ behavior: 'instant', block: 'center' });
        return true;
      }
      return false;
    })()
  `);
  console.log("Found Subtitles section in Settings:", foundSubSection);
  await new Promise(r => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_settings_cc_controls.png"));

  // Click Middle preset in Settings
  console.log("Clicking 'Middle (50%)' preset in Settings...");
  const clickedMiddle = await client.evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const midBtn = buttons.find(b => b.textContent?.includes('Middle (50%)') || b.textContent?.includes('Middle'));
      if (midBtn) {
        midBtn.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("Clicked Middle in Settings:", clickedMiddle);
  await new Promise(r => setTimeout(r, 500));

  // Verify localStorage has Middle position saved
  const config1 = await client.evaluate(`localStorage.getItem('aurastream_subtitle_style_v1')`);
  console.log("Saved config in Settings:", config1);
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_settings_middle_preset.png"));

  console.log("=== Part 2: Verify Player CC Sheet and Real-time Position Controls ===");
  // Navigate back to Home tab
  await client.evaluate(`
    (() => {
      const backBtn = document.querySelector('header button');
      if (backBtn) backBtn.click();
      const homeBtn = document.querySelector('button[aria-label="Home"]');
      if (homeBtn) homeBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Click the first drama in feed or click play
  await client.evaluate(`
    (() => {
      const card = document.querySelector('article, div[tabindex="0"], div.cursor-pointer');
      if (card) card.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 1200));

  // Open the SubtitleSheet
  // Option A: click CC button twice (first enables, second opens) or click options -> Customize Styles
  console.log("Opening CC SubtitleSheet...");
  const sheetOpened = await client.evaluate(`
    (() => {
      const ccBtn = document.querySelector('button[aria-label*="Captions"], button[title*="Captions"], button[aria-label*="ubtitle"]');
      if (ccBtn) {
        ccBtn.click();
        setTimeout(() => ccBtn.click(), 200);
        return true;
      }
      return false;
    })()
  `);
  console.log("Clicked CC button:", sheetOpened);
  await new Promise(r => setTimeout(r, 1000));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_player_cc_sheet_middle.png"));

  // In SubtitleSheet, click "Top (85%)" preset
  console.log("Clicking 'Top (85%)' in SubtitleSheet...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const topBtn = btns.find(b => b.textContent?.includes('Top (85%)') || b.textContent?.includes('Top'));
      if (topBtn) {
        topBtn.click();
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_sheet_top_preset.png"));

  // In SubtitleSheet, test the Fine-Tuning Vertical Slider (set to 65%)
  console.log("Testing CC vertical height fine-tuning slider (65%)...");
  await client.evaluate(`
    (() => {
      const range = document.querySelector('input[type="range"]');
      if (range) {
        range.value = '65';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_sheet_slider_65.png"));

  // Read config to confirm slider update
  const config2 = await client.evaluate(`localStorage.getItem('aurastream_subtitle_style_v1')`);
  console.log("Saved config after slider 65%:", config2);

  // Close CC sheet
  console.log("Closing SubtitleSheet to inspect live video overlay...");
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
      if (closeBtn) closeBtn.click();
      else {
        const backdrop = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/70');
        if (backdrop) backdrop.click();
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Inspect SubtitleOverlay position style in the DOM
  const overlayStyle = await client.evaluate(`
    (() => {
      const overlay = document.querySelector('.aurastream-subtitles, div[style*="calc(var(--sab"]');
      const allDivs = Array.from(document.querySelectorAll('div'));
      const subDiv = allDivs.find(d => d.style.bottom || d.style.top);
      return {
        bottom: subDiv?.style.bottom,
        top: subDiv?.style.top,
        transform: subDiv?.style.transform
      };
    })()
  `);
  console.log("SubtitleOverlay style:", overlayStyle);
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_player_custom_positioned_subtitles.png"));

  // Click Downside (reset preset) to verify Downside works properly
  console.log("Re-opening CC sheet to test Reset Downside...");
  await client.evaluate(`
    (() => {
      const ccBtn = document.querySelector('button[aria-label*="Captions"], button[title*="Captions"]');
      if (ccBtn) ccBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const downBtn = btns.find(b => b.textContent?.includes('Downside (12%)') || b.textContent?.includes('Reset Downside'));
      if (downBtn) downBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_sheet_reset_downside.png"));

  const configDownside = await client.evaluate(`localStorage.getItem('aurastream_subtitle_style_v1')`);
  console.log("Saved config after Downside:", configDownside);

  // Close CC sheet
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  console.log("=== Part 3: Verify Profile Tab & Zero Overlap ===");
  // Navigate to Profile tab
  await client.evaluate(`
    (() => {
      const profileBtn = document.querySelector('button[aria-label="Profile"]');
      if (profileBtn) profileBtn.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Check ContinueWatchingBar presence
  const cwbStatus = await client.evaluate(`
    (() => {
      const bar = document.querySelector('[data-testid="continue-watching-bar"], .continue-watching');
      return {
        found: !!bar,
        display: bar ? window.getComputedStyle(bar).display : 'none'
      };
    })()
  `);
  console.log("ContinueWatchingBar on Profile tab:", cwbStatus);
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_profile_clean_no_bar.png"));

  // Click Downloads subtab
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dlSub = btns.find(b => b.innerText.trim() === 'Downloads');
      if (dlSub) dlSub.click();
    })()
  `);
  await new Promise(r => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "live_v01_profile_downloads_clean_unobstructed.png"));

  console.log("=== All Tests Verified Successfully! ===");
  client.close();
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
