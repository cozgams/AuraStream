import fs from 'fs';

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json');
  const [target] = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const cur = id++;
    const handler = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === cur) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
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

  const takeScreenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}.png`;
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log(`Saved screenshot: ${name}.png`);
  };

  console.log("=== 1. Checking Home / Player Feed ===");
  await new Promise(r => setTimeout(r, 1500));
  await takeScreenshot("verify_player_live");

  // Check if CC is active or can be enabled
  console.log("=== 2. Enabling Subtitles (CC) ===");
  await evalCode(`(() => {
    // Open subtitles or set subtitle mode to en
    try {
      localStorage.setItem("aurastream_subtitle_mode", "en");
      window.dispatchEvent(new CustomEvent("aurastream:subtitlestyle-changed", {
        detail: {
          font: "sans",
          color: "white",
          bgOpacity: 80,
          bgStyle: "translucent",
          edgeStyle: "drop_shadow",
          position: "bottom"
        }
      }));
    } catch(e) {}
  })()`);
  await new Promise(r => setTimeout(r, 1200));
  await takeScreenshot("verify_cc_active_feed");

  console.log("=== 3. Navigating to Categories Tab ===");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll('nav button, nav [role="tab"], .ios-tab-bar button'));
    if (tabs.length >= 2) {
      tabs[1].click();
    }
  })()`);
  await new Promise(r => setTimeout(r, 2000));

  const categoriesTitles = await evalCode(`(() => {
    const cards = Array.from(document.querySelectorAll('.ios-rank-copy strong, .ios-card-title, h3, h4')).map(el => el.textContent.trim()).filter(Boolean);
    return cards.slice(0, 15);
  })()`);
  console.log("Categories Drama Titles:", categoriesTitles);
  await takeScreenshot("verify_categories_clean_titles");

  console.log("=== 4. Testing Continue Watching Dismissal Persistence ===");
  const dismissTest = await evalCode(`(() => {
    const continueBar = document.querySelector('aside[aria-label*="Continue"], aside[aria-label*="Next"]');
    const hasBarBefore = Boolean(continueBar);
    const dismissBtn = continueBar ? continueBar.querySelector('button[aria-label*="Dismiss"]') : null;
    if (dismissBtn) {
      dismissBtn.click();
    }
    const dismissedStorage = localStorage.getItem("aurastream_continue_dismissed_v1");
    return { hasBarBefore, dismissedStorage };
  })()`);
  console.log("Continue watching bar test:", dismissTest);
  await new Promise(r => setTimeout(r, 800));
  await takeScreenshot("verify_categories_after_dismiss");

  console.log("=== 5. Navigating to Downloads / Profile Tab ===");
  await evalCode(`(() => {
    const tabs = Array.from(document.querySelectorAll('nav button, nav [role="tab"], .ios-tab-bar button'));
    if (tabs.length >= 4) {
      tabs[3].click();
    }
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  // Click Downloads tab in Profile
  await evalCode(`(() => {
    const subtabs = Array.from(document.querySelectorAll('button, [role="tab"]'));
    const dlTab = subtabs.find(b => b.textContent.includes('Downloads') || b.textContent.includes('Downloaded'));
    if (dlTab) dlTab.click();
  })()`);
  await new Promise(r => setTimeout(r, 1500));

  const downloadsInfo = await evalCode(`(() => {
    const totalSizeBadge = document.querySelector('.bg-primary\\\\/10, .bg-amber-500\\\\/15');
    const items = Array.from(document.querySelectorAll('.rounded-2xl.border')).map(card => {
      const title = card.querySelector('.font-bold')?.textContent?.trim();
      const sizeBadge = Array.from(card.querySelectorAll('span')).find(s => s.textContent.includes('MB') || s.textContent.includes('GB'));
      return { title, size: sizeBadge ? sizeBadge.textContent.trim() : null };
    });
    return {
      bodySnippet: document.body.innerText.slice(0, 300),
      items: items.slice(0, 5)
    };
  })()`);
  console.log("Downloads info:", downloadsInfo);
  await takeScreenshot("verify_downloads_clean_file_sizes");

  console.log("=== All verifications completed! ===");
  ws.close();
}

main().catch(console.error);
