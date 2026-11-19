import fs from 'node:fs';

async function run() {
  console.log("=== Running AuraStream v2.1.0 Final Verification Suite ===");
  const res = await fetch('http://127.0.0.1:9222/json');
  const [target] = await res.json();
  if (!target || !target.webSocketDebuggerUrl) throw new Error("No CDP webSocketDebuggerUrl found");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const cur = id++;
    const timer = setTimeout(() => reject(new Error(`Timeout on ${method}`)), 12000);
    const handler = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === cur) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
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

  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/${name}.png`;
    fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
    console.log(`Saved screenshot: ${name}.png`);
  };

  // Step 1: Check initial page state
  console.log("1. Checking initial page state...");
  await new Promise(r => setTimeout(r, 1200));
  await capture("final_step1_initial");

  // Step 2: Navigate to Profile
  console.log("2. Navigating to Profile tab...");
  await evalCode(`(() => {
    const tabBtns = Array.from(document.querySelectorAll('.ios-tabbar-btn'));
    const profileBtn = tabBtns.find(b => b.innerText.includes('Profile') || b.innerText.includes('Me'));
    if (profileBtn) profileBtn.click();
    return !!profileBtn;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  await capture("final_step2_profile");

  // Step 3: Switch to Downloads tab in Profile
  console.log("3. Switching to Downloads tab in Profile...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const dlBtn = btns.find(b => b.innerText.trim() === 'Downloads');
    if (dlBtn) dlBtn.click();
    return !!dlBtn;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  await capture("final_step3_downloads_tab");

  // Step 4: Test styled Clear All confirmation Modal
  console.log("4. Testing Clear All confirmation Modal...");
  const clickedClear = await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const clearBtn = btns.find(b => b.innerText.includes('Clear All'));
    if (clearBtn) {
      clearBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Clicked Clear All button:", clickedClear);
  await new Promise(r => setTimeout(r, 600));

  const modalInfo = await evalCode(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      isOpen: !!dialog,
      title: dialog ? dialog.querySelector('.text-\\\\[17px\\\\]')?.innerText : null,
      fullText: dialog ? dialog.innerText : null
    };
  })()`);
  console.log("Modal state:", JSON.stringify(modalInfo, null, 2));
  await capture("final_step4_clear_all_modal");

  // Step 5: Test modal cancellation
  console.log("5. Testing Modal Cancel...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const cancelBtn = btns.find(b => b.innerText.trim() === 'Cancel');
    if (cancelBtn) cancelBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 600));

  const modalAfterCancel = await evalCode(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return !dialog;
  })()`);
  console.log("Modal cleanly dismissed after cancel:", modalAfterCancel);
  await capture("final_step5_after_cancel");

  // Step 6: Test opening Export Sheet
  console.log("6. Testing Export All MP4 sheet...");
  await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const exportBtn = btns.find(b => b.innerText.includes('Export All MP4') || b.innerText.includes('Export Series'));
    if (exportBtn) exportBtn.click();
  })()`);
  await new Promise(r => setTimeout(r, 800));

  const exportSheetInfo = await evalCode(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      isOpen: !!dialog,
      label: dialog ? dialog.getAttribute('aria-label') : null,
      text: dialog ? dialog.innerText : null
    };
  })()`);
  console.log("Export Sheet State:", JSON.stringify(exportSheetInfo, null, 2));
  await capture("final_step6_export_sheet");

  // Step 7: Test executing export to Phone Gallery & Movies
  console.log("7. Executing export to Phone Gallery & Movies...");
  const clickedTarget = await evalCode(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const galleryBtn = btns.find(b => b.innerText.includes('Phone Gallery & Movies'));
    if (galleryBtn) {
      galleryBtn.click();
      return true;
    }
    return false;
  })()`);
  console.log("Clicked Phone Gallery & Movies:", clickedTarget);

  await new Promise(r => setTimeout(r, 3500));

  const exportResultState = await evalCode(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      text: dialog ? dialog.innerText : null
    };
  })()`);
  console.log("Export execution result:", exportResultState?.text?.slice(0, 150));
  await capture("final_step7_export_success");

  // Close sheet
  await evalCode(`(() => {
    const backdrop = document.querySelector('.ios-overlay-backdrop');
    if (backdrop) backdrop.click();
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  })()`);
  await new Promise(r => setTimeout(r, 600));

  ws.close();
  console.log("=== Verification Suite Completed Successfully! ===");
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
