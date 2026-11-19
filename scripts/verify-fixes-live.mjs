import fs from 'fs';

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json');
  const [target] = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve) => {
    const cur = id++;
    const handler = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === cur) {
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });

  await new Promise(r => ws.addEventListener('open', r));
  const evalCode = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  };

  console.log('--- Step 1: Check Current Elements & Options Button ---');
  const optionsCheck = await evalCode(`(() => {
    // Find options button in action rail
    const btns = Array.from(document.querySelectorAll('button'));
    const optionsBtn = btns.find(b => b.innerText.includes('Options') || b.getAttribute('aria-label') === 'More Options');
    if (!optionsBtn) return { found: false };
    const rect = optionsBtn.getBoundingClientRect();
    const hitEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      found: true,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      hitTag: hitEl ? hitEl.tagName : null,
      hitClass: hitEl ? hitEl.className : null,
      isSelfOrChild: hitEl === optionsBtn || optionsBtn.contains(hitEl)
    };
  })()`);
  console.log('Options Button Hitbox Check:', JSON.stringify(optionsCheck, null, 2));

  console.log('\n--- Step 2: Click Options Button and Verify Sheet Opens ---');
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const optionsBtn = btns.find(b => b.innerText.includes('Options') || b.getAttribute('aria-label') === 'More Options');
    if (optionsBtn) {
      optionsBtn.click();
    }
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const optionsSheetCheck = await evalCode(`(() => {
    const sheetTitle = document.querySelector('[data-sheet-title]') || Array.from(document.querySelectorAll('h2, h3, div')).find(d => d.innerText && d.innerText.includes('Playback Options'));
    const bodyText = document.body.innerText;
    const hasOptionsSheet = bodyText.includes('Playback Options') || bodyText.includes('Customise Playback');
    const hasPipWindow = bodyText.includes('PiP Window') || bodyText.includes('Floating player');
    const hasCleanScreen = bodyText.includes('Clean Screen');
    const ccSegments = Array.from(document.querySelectorAll('button')).filter(b => ['English', 'Off', 'Dual Bilingual'].includes(b.innerText.trim())).map(b => b.innerText.trim());
    return {
      hasOptionsSheet,
      hasPipWindow, // Should be FALSE (removed mini popup)
      hasCleanScreen, // Should be TRUE
      ccSegments // Should only be ['English', 'Off']
    };
  })()`);
  console.log('Options Sheet Check:', JSON.stringify(optionsSheetCheck, null, 2));

  // Screenshot More Options sheet
  const shotOptions = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/verified_more_options_sheet.png', Buffer.from(shotOptions.data, 'base64'));
  console.log('Saved verified_more_options_sheet.png');

  // Close options sheet
  await evalCode(`(() => {
    // tap backdrop or close
    const backdrop = document.querySelector('.fixed.inset-0.bg-black\\\\/60') || document.querySelector('[aria-label=\"Close\"]');
    if (backdrop) backdrop.click();
  })()`);
  await new Promise(r => setTimeout(r, 400));

  console.log('\n--- Step 3: Test CC Button Toggling (English / Off only) ---');
  // Find top right CC button
  const ccToggleResult = await evalCode(`(() => {
    const ccBtn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('title') === 'Captions' || b.getAttribute('aria-label') === 'Closed Captions (CC)' || b.getAttribute('aria-label') === 'Captions');
    if (!ccBtn) return { error: 'CC button not found' };
    
    // Toggle 1
    ccBtn.click();
    const mode1 = localStorage.getItem('aurastream_subtitle_mode');
    
    // Toggle 2
    ccBtn.click();
    const mode2 = localStorage.getItem('aurastream_subtitle_mode');

    // Toggle 3
    ccBtn.click();
    const mode3 = localStorage.getItem('aurastream_subtitle_mode');

    return { mode1, mode2, mode3 };
  })()`);
  console.log('CC Toggle Cycling:', JSON.stringify(ccToggleResult, null, 2));

  console.log('\n--- Step 4: Open Settings and Verify Clean Professional Layout ---');
  // Navigate to profile tab first
  await evalCode(`(() => {
    const profileTab = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Profile'));
    if (profileTab) profileTab.click();
  })()`);
  await new Promise(r => setTimeout(r, 500));

  // Click Settings icon/button in Profile
  await evalCode(`(() => {
    const settingsBtn = document.querySelector('[aria-label=\"Settings\"]') || Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Settings'));
    if (settingsBtn) settingsBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  // Check Settings screen content
  const settingsAudit = await evalCode(`(() => {
    const text = document.body.innerText;
    return {
      isSettingsPage: text.includes('Settings') && text.includes('Appearance'),
      hasCreatedByAAA: text.includes('This App Created by AAA'),
      // Messy fields that MUST BE FALSE (removed/hidden)
      hasGeminiApiKeyInput: text.includes('Gemini API Key') || !!document.querySelector('input[placeholder*=\"Gemini\"]'),
      hasWhisperApiKeyInput: text.includes('Whisper API Key') || !!document.querySelector('input[placeholder*=\"Whisper\"]'),
      hasAiEngineSelector: text.includes('AI Auto-Caption Engine'),
      hasCachedSubtitlesCount: text.includes('Cached Subtitles:'),
      hasPlaybackDiagnosticsLog: text.includes('Playback Diagnostics Log') || text.includes('Copy Full Event Log'),
      hasNetworkProxyLines: text.includes('Primary Line') || text.includes('Run Network Diagnostics'),
      // Professional fields that MUST BE TRUE
      hasAppearance: text.includes('Appearance') || text.includes('Theme'),
      hasAccentColors: !!document.querySelector('.ios-setting-group'),
      hasCaptionMode: text.includes('Caption Mode'),
      hasCaptionPreview: text.includes('The real drama has only just begun') || text.includes('Live Preview'),
      hasDownloadsStorage: text.includes('Offline Downloads') || text.includes('Offline Storage'),
      hasRamBooster: text.includes('1-Tap RAM Booster') || text.includes('Boost RAM'),
      hasAbout: text.includes('About AuraStream'),
      hasDualBilingualInSettings: text.includes('Dual') && text.includes('Original')
    };
  })()`);
  console.log('Settings Screen Professional Audit:', JSON.stringify(settingsAudit, null, 2));

  // Capture full screenshot of Settings screen
  const shotSettings = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/verified_clean_professional_settings.png', Buffer.from(shotSettings.data, 'base64'));
  console.log('Saved verified_clean_professional_settings.png');

  // Scroll down in Settings and capture second screenshot
  await evalCode(`(() => {
    const scroller = document.querySelector('.ios-page-body');
    if (scroller) scroller.scrollTop = 500;
  })()`);
  await new Promise(r => setTimeout(r, 400));
  const shotSettings2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/verified_clean_settings_scrolled.png', Buffer.from(shotSettings2.data, 'base64'));
  console.log('Saved verified_clean_settings_scrolled.png');

  ws.close();
}

main().catch(console.error);
