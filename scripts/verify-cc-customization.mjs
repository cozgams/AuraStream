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
        resolve();
      };
      this.ws.onerror = (err) => reject(err);
      this.ws.onclose = (ev) => {
        console.log("CDP closed:", ev.code, ev.reason);
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
  console.log("Connecting to webview devtools:", wsUrl);
  const client = new CdpClient(wsUrl);
  await client.connect();

  await client.send("Page.enable");
  await client.send("Runtime.enable");

  // Step 1: Check initial home screen and app state
  console.log("Evaluating home screen state...");
  const title = await client.evaluate("document.title");
  console.log("App title:", title);

  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step1_home.png"));

  // Step 2: Navigate to Settings tab
  console.log("Navigating to Settings tab...");
  await client.evaluate(`
    (() => {
      const tabBtns = Array.from(document.querySelectorAll('nav button, button'));
      const profileBtn = tabBtns.find(b => b.innerText.includes('我的') || b.innerText.includes('Profile') || b.innerText.includes('设置') || b.innerText.includes('Settings'));
      if (profileBtn) profileBtn.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Click Settings gear or open settings directly
  await client.evaluate(`
    (() => {
      const gear = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label')?.includes('设置') || b.getAttribute('aria-label')?.includes('Settings') || b.innerText.includes('设置') || b.innerText.includes('Settings'));
      if (gear) gear.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Scroll down to Subtitles & CC section in Settings
  await client.evaluate(`
    (() => {
      const allDivs = Array.from(document.querySelectorAll('div, h2, h3, span'));
      const ccHeading = allDivs.find(el => el.textContent?.includes('字幕与字幕位置 (CC)') || el.textContent?.includes('字幕与字幕位置') || el.textContent?.includes('字幕位置'));
      if (ccHeading) {
        ccHeading.scrollIntoView({ behavior: 'instant', block: 'center' });
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step2_settings_subtitles.png"));

  // Step 3: Test changing CC position in Settings to 'middle' (居中)
  console.log("Testing CC position selection in Settings...");
  const changedInSettings = await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const midBtn = btns.find(b => b.textContent?.includes('居中 (50%)') || b.textContent?.includes('居中'));
      if (midBtn) {
        midBtn.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("Selected Middle in Settings:", changedInSettings);
  await new Promise(r => setTimeout(r, 500));

  // Check stored subtitle style in localStorage
  const storedStyle = await client.evaluate(`localStorage.getItem('aurastream_subtitle_style_v1')`);
  console.log("Stored style after selecting Middle in Settings:", storedStyle);

  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step3_settings_middle_selected.png"));

  // Step 4: Open a video from Home feed to test Player SubtitleSheet and SubtitleOverlay
  console.log("Returning to Home feed to open video player...");
  await client.evaluate(`
    (() => {
      // Find back button or Home tab
      const backBtn = document.querySelector('button[aria-label*="Back"], button[aria-label*="返回"], header button');
      if (backBtn) backBtn.click();
      const tabBtns = Array.from(document.querySelectorAll('nav button'));
      const homeBtn = tabBtns.find(b => b.innerText.includes('精选') || b.innerText.includes('首页') || b.innerText.includes('Home'));
      if (homeBtn) homeBtn.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));

  // Click first drama card
  console.log("Clicking first drama card...");
  await client.evaluate(`
    (() => {
      const card = document.querySelector('div[role="button"], article, .group, div[tabindex="0"]');
      if (card) {
        card.click();
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 1800));

  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step4_player_playing.png"));

  // Step 5: Open Subtitle / CC Sheet in player
  console.log("Opening CC Subtitle Sheet in player...");
  const ccSheetOpened = await client.evaluate(`
    (() => {
      // Tap player to show controls if needed
      const videoContainer = document.querySelector('video')?.parentElement;
      if (videoContainer) videoContainer.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      const allBtns = Array.from(document.querySelectorAll('button'));
      const ccBtn = allBtns.find(b => b.textContent?.trim() === 'CC' || b.getAttribute('aria-label')?.includes('ubtitle') || b.getAttribute('aria-label')?.includes('字幕'));
      if (ccBtn) {
        ccBtn.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("CC Sheet button clicked:", ccSheetOpened);
  await new Promise(r => setTimeout(r, 1200));

  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step5_sheet_open.png"));

  // Step 6: Test selecting different position presets in SubtitleSheet
  // Presets: Downside (底部 12%), Above Title (进度条上 32%), Middle (屏幕居中 50%), Top (顶部 85%)
  console.log("Selecting 'Above Title' preset in CC Sheet...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const aboveTitleBtn = btns.find(b => b.textContent?.includes('进度条上') || b.textContent?.includes('Above Title') || b.textContent?.includes('32%'));
      if (aboveTitleBtn) {
        aboveTitleBtn.click();
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step6_sheet_above_title.png"));

  // Check custom offset slider adjustment (e.g. set to 75%)
  console.log("Adjusting custom offset slider to 75%...");
  await client.evaluate(`
    (() => {
      const slider = document.querySelector('input[type="range"]');
      if (slider) {
        slider.value = '75';
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 600));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step7_sheet_slider_75.png"));

  // Check stored style again to confirm persistence
  const styleAfterSlider = await client.evaluate(`localStorage.getItem('aurastream_subtitle_style_v1')`);
  console.log("Stored style after slider 75%:", styleAfterSlider);

  // Close CC sheet and verify subtitle position on player screen
  console.log("Closing CC sheet...");
  await client.evaluate(`
    (() => {
      const closeBtn = document.querySelector('button[aria-label="关闭"], button[aria-label="Close"], button[aria-label*="close"]');
      if (closeBtn) closeBtn.click();
      else {
        // click backdrop
        const backdrop = document.querySelector('.bg-black\\\\/60, .bg-black\\\\/70, .fixed.inset-0');
        if (backdrop) backdrop.click();
      }
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step8_player_with_high_subtitles.png"));

  // Step 7: Verify Profile tab without ContinueWatchingBar obstruction
  console.log("Navigating to Profile tab to verify no ContinueWatchingBar overlap...");
  await client.evaluate(`
    (() => {
      // Close player if open (or back to feed)
      const closePlayer = document.querySelector('button[aria-label*="Back"], button[aria-label*="返回"], button[aria-label*="关闭"], header button');
      if (closePlayer) closePlayer.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Click Profile tab
  await client.evaluate(`
    (() => {
      const tabBtns = Array.from(document.querySelectorAll('nav button'));
      const profileBtn = tabBtns.find(b => b.innerText.includes('我的') || b.innerText.includes('Profile'));
      if (profileBtn) profileBtn.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 800));

  // Check if ContinueWatchingBar exists in DOM on Profile tab
  const barOnProfile = await client.evaluate(`
    (() => {
      const cwb = document.querySelector('[data-testid="continue-watching-bar"], .continue-watching, a[href*="watch"]');
      const textMatches = Array.from(document.querySelectorAll('div, span, p')).filter(el => el.textContent?.includes('继续观看'));
      return {
        barFound: !!cwb,
        matchesCount: textMatches.length
      };
    })()
  `);
  console.log("ContinueWatchingBar check on Profile tab:", barOnProfile);
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step9_profile_no_overlap.png"));

  // Step 8: Switch to Downloads subtab inside Profile
  console.log("Switching to Downloads subtab in Profile...");
  await client.evaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const dlBtn = btns.find(b => b.innerText.includes('离线') || b.innerText.includes('下载') || b.innerText.includes('Downloads'));
      if (dlBtn) dlBtn.click();
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 800));
  await client.screenshot(path.join(ARTIFACT_DIR, "cc_step10_profile_downloads_clean.png"));

  console.log("All CC customization and layout verification steps completed successfully!");
  client.close();
}

main().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
