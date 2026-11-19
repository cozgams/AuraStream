import fs from 'fs';

async function run() {
  const targetsRes = await fetch('http://127.0.0.1:9222/json');
  const targets = await targetsRes.json();
  const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
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
  await send('Page.enable');
  await send('Runtime.enable');

  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const takeScreenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}`;
    fs.writeFileSync(p, Buffer.from(shot.result.data, 'base64'));
    console.log(`Saved screenshot: ${name}`);
  };

  // 1. We are in Feed right now! Capture radiant amber star active screen
  await wait(600);
  await takeScreenshot('aurastream_final_verified_screen.png');
  await takeScreenshot('aurastream_android_star_active.png');

  // 2. Open More Options sheet and capture
  await evalCode(`document.querySelector('button[aria-label="More Options"]')?.click()`);
  await wait(700);
  await takeScreenshot('audit_04_more_options_sheet.png');

  // 3. Open All Episodes from More Options
  await evalCode(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('All Episodes'))?.click()`);
  await wait(700);
  await takeScreenshot('audit_03_episodes_sheet.png');

  // 4. Toggle sort to N-1 and capture
  await evalCode(`document.querySelector('button[aria-label*="Sort" i]')?.click()`);
  await wait(500);
  await takeScreenshot('audit_03_episodes_grid.png');

  // Close Episodes
  await evalCode(`document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button')?.click()`);
  await wait(500);

  // 5. Open Comments sheet and capture
  await evalCode(`document.querySelector('button[aria-label*="Comments" i]')?.click()`);
  await wait(700);
  await takeScreenshot('audit_02_comments_panel.png');

  // Close Comments
  await evalCode(`document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] .ios-icon-button')?.click()`);
  await wait(500);

  // 6. Go back to Home
  await evalCode(`document.querySelector('button[aria-label="Back"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_01_home_feed.png');

  // 7. Go to Search
  await evalCode(`document.querySelector('button[aria-label="Search"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_08_search_tab.png');

  // 8. Go to Categories
  await evalCode(`document.querySelector('button[aria-label="Categories"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_09_categories_tab.png');

  // 9. Go to Profile
  await evalCode(`document.querySelector('button[aria-label="Profile"]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_10_profile_tab.png');

  // 10. Open Settings
  await evalCode(`document.querySelector('button[aria-label*="Settings" i]')?.click()`);
  await wait(600);
  await takeScreenshot('audit_12_settings_screen.png');

  // Go back to Profile then Home
  await evalCode(`document.querySelector('button[aria-label="Back"]')?.click()`);
  await wait(400);
  await evalCode(`document.querySelector('button[aria-label="Home"]')?.click()`);
  await wait(400);

  ws.close();
  console.log("All screenshots captured successfully.");
}

run().catch(console.error);
