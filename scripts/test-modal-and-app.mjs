import fs from 'node:fs';

async function run() {
  const res = await fetch('http://127.0.0.1:9222/json');
  const [target] = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const cur = id++;
    const timer = setTimeout(() => reject(new Error(`Timeout on ${method}`)), 8000);
    const handler = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === cur) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });
  await new Promise(r => ws.addEventListener('open', r));

  // Check what is currently open on screen
  const currentState = await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return {
        hasDialog: !!dialog,
        dialogLabel: dialog ? dialog.getAttribute('aria-label') : null,
        dialogText: dialog ? dialog.innerText.slice(0, 100) : null
      };
    })()`,
    returnByValue: true
  });
  console.log('Current state:', currentState.result.value);

  // If a dialog is open (e.g. Export Episode), close it first
  if (currentState.result.value.hasDialog) {
    console.log('Closing open dialog...');
    await send('Runtime.evaluate', {
      expression: `(() => {
        const closeBtn = document.querySelector('.ios-overlay-backdrop');
        if (closeBtn) closeBtn.click();
        else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      })()`
    });
    await new Promise(r => setTimeout(r, 600));
  }

  // Click Clear All button
  console.log('Clicking Clear All...');
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const clearBtn = btns.find(b => b.innerText.includes('Clear All'));
      if (clearBtn) {
        clearBtn.click();
        return true;
      }
      return false;
    })()`,
    returnByValue: true
  });
  console.log('Clicked Clear All:', clicked.result.value);

  await new Promise(r => setTimeout(r, 600));

  const modalState = await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return {
        hasDialog: !!dialog,
        dialogLabel: dialog ? dialog.getAttribute('aria-label') : null,
        dialogText: dialog ? dialog.innerText : null
      };
    })()`,
    returnByValue: true
  });
  console.log('Clear All Modal State:', modalState.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/clear_all_modal_live.png', Buffer.from(shot.data, 'base64'));
  console.log('Saved clear_all_modal_live.png');

  ws.close();
}

run().catch(console.error);
