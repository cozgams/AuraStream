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

  const data = await evalCode(`(async () => {
    try {
      const feed = await window.__TAURI_INTERNALS__.invoke('api_feed', { page: 1, size: 20 });
      return {
        ok: true,
        titles: feed.items.map(it => ({ id: it.id, title: it.title, tags: it.tags }))
      };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  })()`);

  console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  ws.close();
}
run();
