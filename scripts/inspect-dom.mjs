import fs from 'fs';

async function run() {
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

  const info = await evalCode(`(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map(i => ({
      src: i.src.slice(0, 80),
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
      complete: i.complete,
      displayed: i.offsetWidth + 'x' + i.offsetHeight,
      alt: i.alt,
      classes: i.className
    }));
    const video = document.querySelector('video');
    const videoInfo = video ? {
      src: video.src ? video.src.slice(0, 80) : '',
      currentSrc: video.currentSrc ? video.currentSrc.slice(0, 80) : '',
      paused: video.paused,
      currentTime: video.currentTime,
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      error: video.error ? video.error.message || video.error.code : null
    } : null;
    const bodyText = document.body.innerText.slice(0, 500);
    return { imgs, videoInfo, bodyText };
  })()`);

  console.log(JSON.stringify(info, null, 2));

  // Take a full screenshot of what's currently showing
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const p = `/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d/current_screen.png`;
  fs.writeFileSync(p, Buffer.from(shot.data, 'base64'));
  console.log('Saved current_screen.png');
  ws.close();
}
run();
