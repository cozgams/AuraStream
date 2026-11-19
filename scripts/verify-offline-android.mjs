// Uses Node.js 22 built-in WebSocket

async function run() {
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    console.error("No active page target found");
    process.exit(1);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let idCounter = 1;
  const pending = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = idCounter++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise(r => ws.addEventListener('open', r));
  console.log("Connected to live AuraStream CDP on Android!");

  await send('Page.enable');
  await send('Runtime.enable');

  // Evaluate state
  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body.innerText;
      const chinese = (text.match(/[\\u4e00-\\u9fa5]/g) || []).length;
      const video = document.querySelector('video');
      return {
        title: document.title,
        textLength: text.length,
        chinese,
        hasVideo: !!video,
        paused: video ? video.paused : null,
        currentTime: video ? video.currentTime : null,
      };
    })()`,
    returnByValue: true
  });

  console.log("App live state:", evalRes?.result?.result?.value || evalRes?.result?.value || evalRes);

  // Take screenshot of feed
  const feedShot = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('fs');
  fs.writeFileSync('/data/home/Project/A/aurastream_live_feed_v2.1.png', Buffer.from(feedShot.result.data, 'base64'));
  console.log("Saved feed screenshot: aurastream_live_feed_v2.1.png");

  // Navigate to Profile page by clicking Profile button in tab bar
  const navRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const profileBtn = buttons.find(b => b.innerText.includes('Profile') || b.getAttribute('aria-label') === 'Profile');
      if (profileBtn) {
        profileBtn.click();
        return "clicked profile";
      }
      return "profile button not found";
    })()`,
    returnByValue: true
  });
  console.log("Navigated to profile:", navRes.result?.value);

  await new Promise(r => setTimeout(r, 800));

  // Switch to Downloads tab in Profile
  const tabRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const dlTab = buttons.find(b => b.innerText.includes('Downloads') || b.innerText.includes('Offline'));
      if (dlTab) {
        dlTab.click();
        return "clicked downloads tab";
      }
      return "downloads tab not found";
    })()`,
    returnByValue: true
  });
  console.log("Switched to downloads tab:", tabRes.result?.value);

  await new Promise(r => setTimeout(r, 600));

  // Inspect downloads tab elements & storage visualizer
  const dlState = await send('Runtime.evaluate', {
    expression: `(() => {
      const body = document.body.innerText;
      const chinese = (body.match(/[\\u4e00-\\u9fa5]/g) || []).length;
      return {
        hasPhoneStorage: body.includes("Phone Storage"),
        hasAutoDownload: body.includes("Auto-Download Next Episode"),
        hasAutoDelete: body.includes("Auto-Delete Watched Episodes"),
        chineseInProfile: chinese,
        pageSnippet: body.slice(0, 500)
      };
    })()`,
    returnByValue: true
  });
  console.log("Profile Downloads & Storage state:", dlState.result?.value);

  // Capture screenshot of Profile Downloads section
  const profileShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/Project/A/aurastream_live_downloads_v2.1.png', Buffer.from(profileShot.result.data, 'base64'));
  console.log("Saved profile downloads screenshot: aurastream_live_downloads_v2.1.png");

  // Navigate to Settings
  const settingsRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[aria-label="Settings"]') || Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Settings'));
      if (btn) {
        btn.click();
        return "clicked settings";
      }
      return "settings button not found";
    })()`,
    returnByValue: true
  });
  console.log("Navigated to settings:", settingsRes.result?.value);

  await new Promise(r => setTimeout(r, 800));

  // Scroll down in settings to verify Offline Downloads & Smart Storage section
  await send('Runtime.evaluate', {
    expression: `window.scrollTo({ top: 800, behavior: 'instant' }); document.querySelector('.ios-page-body')?.scrollTo({ top: 1000, behavior: 'instant' });`
  });
  await new Promise(r => setTimeout(r, 400));

  const settingsState = await send('Runtime.evaluate', {
    expression: `(() => {
      const body = document.body.innerText;
      return {
        hasOfflineSection: body.includes("Offline Downloads & Smart Storage"),
        hasSmartToggle: body.includes("Smart Downloads (Next Episode)"),
        hasAutoDeleteToggle: body.includes("Auto-Delete Watched Episodes"),
        chineseInSettings: (body.match(/[\\u4e00-\\u9fa5]/g) || []).length
      };
    })()`,
    returnByValue: true
  });
  console.log("Settings Offline & Smart Storage state:", settingsState.result?.value);

  const settingsShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/Project/A/aurastream_live_settings_v2.1.png', Buffer.from(settingsShot.result.data, 'base64'));
  console.log("Saved settings screenshot: aurastream_live_settings_v2.1.png");

  ws.close();
  process.exit(0);
}

run().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
