import fs from "node:fs";
import path from "node:path";

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.callbacks = new Map();
    this.consoleErrors = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = (ev) => console.log("CDP closed:", ev.code, ev.reason);
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          const text = msg.params.args.map((a) => a.value || a.description || JSON.stringify(a)).join(" ");
          this.consoleErrors.push(text);
          console.warn("[Browser Console Error]", text);
        }
        if (msg.method === "Runtime.exceptionThrown") {
          const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text;
          this.consoleErrors.push(desc);
          console.warn("[Browser Exception]", desc);
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

  console.log("\n=== Phase 1: Verify Live Feed & Subtitle Customization ===");
  // Reset navigation to Home
  await client.evaluate(`
    (() => {
      const homeBtn = document.querySelector('button[aria-label="Home"], button[aria-label="Feed"]');
      if (homeBtn) homeBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Screenshot 1: Home Feed Player
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_01_feed_player.png"));

  // Open Subtitle Sheet
  const ccOpened = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const ccBtn = btns.find(b => b.innerText.trim() === 'CC' || b.getAttribute('aria-label')?.includes('ubtitle'));
      if (ccBtn) {
        ccBtn.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("CC Sheet button clicked:", ccOpened);
  await new Promise((r) => setTimeout(r, 800));

  // Enable CC Subtitles if off
  await client.evaluate(`
    (() => {
      const sheet = document.querySelector('[role="dialog"], .ios-sheet');
      if (!sheet) return;
      const buttons = Array.from(sheet.querySelectorAll('button'));
      const enBtn = buttons.find(b => b.textContent.includes('English') || b.textContent.includes('EN'));
      if (enBtn) enBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  // Test CC Position: Top Preset
  console.log("Testing CC Position: Top preset...");
  await client.evaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const topBtn = buttons.find(b => b.innerText.trim() === 'Top');
      if (topBtn) topBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_02_cc_sheet_top.png"));

  // Test CC Position: Custom Slider to 70%
  console.log("Testing CC Position: Custom Slider to 70%...");
  await client.evaluate(`
    (() => {
      const slider = document.querySelector('input[type="range"][aria-label*="position" i], input[type="range"]');
      if (slider) {
        slider.value = '70';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_03_cc_sheet_custom_70.png"));

  // Close CC sheet to view subtitle position on active player
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="Dismiss"]');
      if (closeBtn) closeBtn.click();
      else {
        // click backdrop
        const backdrop = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/50, [class*="backdrop"]');
        if (backdrop) backdrop.click();
      }
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_04_player_high_subtitles.png"));

  console.log("\n=== Phase 2: Verify Profile & Downloads Tab (No Obstruction) ===");
  await client.evaluate(`
    (() => {
      const profileBtn = document.querySelector('button[aria-label="Profile"]');
      if (profileBtn) profileBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1000));

  // Check Continue Watching Bar visibility
  const profileState = await client.evaluate(`
    (() => {
      const continueBar = document.querySelector('aside[aria-label*="Continue"], aside[aria-label*="Next"]');
      const tabs = Array.from(document.querySelectorAll('button')).filter(b => ['Saved', 'Downloads', 'History', 'Favorites'].some(t => b.textContent.includes(t)));
      return {
        continueBarVisible: Boolean(continueBar && continueBar.offsetParent !== null),
        tabsFound: tabs.map(t => t.textContent.trim())
      };
    })()
  `);
  console.log("Profile state:", profileState);
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_05_profile_clean.png"));

  // Click Downloads tab
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dlTab = btns.find(b => b.textContent.trim().startsWith('Download'));
      if (dlTab) dlTab.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_06_profile_downloads.png"));

  console.log("\n=== Phase 3: Verify Settings (Labels, Download Quality, Diagnostics) ===");
  // Click Settings gear button
  await client.evaluate(`
    (() => {
      const settingsBtn = document.querySelector('button[aria-label="Settings"]');
      if (settingsBtn) settingsBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1200));

  // Inspect Settings headings, options, and localization
  const settingsInfo = await client.evaluate(`
    (() => {
      const h1s = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent.trim());
      const buttons = Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean);
      const downloadQualityButtons = ['Auto', 'HEVC', 'H.264'].map(q => ({
        quality: q,
        exists: buttons.some(b => b === q)
      }));
      return {
        headings: h1s,
        downloadQualityButtons,
        hasNetworkDiagnostics: buttons.some(b => b.includes('Network Diagnostics')),
        hasPlaybackDiagnostics: buttons.some(b => b.includes('Playback Diagnostics')),
        hasStreamingSource: buttons.some(b => b.includes('Streaming Source') || b.includes('Auto-Select'))
      };
    })()
  `);
  console.log("Settings Page Inspection:", JSON.stringify(settingsInfo, null, 2));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_07_settings_top.png"));

  // Test Download Quality selector: Click HEVC, then H.264, then Auto
  console.log("Testing Download Quality selection...");
  const qualityTest = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const hevcBtn = btns.find(b => b.textContent.trim() === 'HEVC');
      if (hevcBtn) hevcBtn.click();
      const storageAfterHevc = localStorage.getItem('aurastream_download_quality_preference_v1');
      return { storageAfterHevc };
    })()
  `);
  console.log("Quality test HEVC:", qualityTest);
  await new Promise((r) => setTimeout(r, 400));

  // Scroll Settings down to inspect Subtitles & CC and Diagnostics
  await client.evaluate(`
    (() => {
      window.scrollTo({ top: 600, behavior: 'instant' });
      const main = document.querySelector('main, .overflow-y-auto');
      if (main) main.scrollTop = 600;
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_08_settings_subtitles_and_diagnostics.png"));

  // Test Network Diagnostics modal
  console.log("Testing Network Diagnostics modal...");
  const netDiagOpened = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const netBtn = btns.find(b => b.textContent.includes('Network Diagnostics'));
      if (netBtn) {
        netBtn.click();
        return true;
      }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "v01_audit_09_settings_network_diagnostics.png"));

  // Close Network Diagnostics modal
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="Close"], button[aria-label="Dismiss"], button[aria-label="close"]');
      if (closeBtn) closeBtn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  console.log("\n=== Phase 4: Error & Exception Audit ===");
  console.log("Total Console Errors captured:", client.consoleErrors.length);
  if (client.consoleErrors.length > 0) {
    console.log("Console errors:", client.consoleErrors);
  }

  client.close();
  console.log("\n=== AUDIT COMPLETE ===");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
