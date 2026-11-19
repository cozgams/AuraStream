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

  const evalCode = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res?.result?.result?.value ?? res?.result?.value;
  };

  const res = await evalCode(`(() => {
    const raw = localStorage.getItem('aurastream_offline_episodes_v1');
    const parsed = raw ? JSON.parse(raw) : [];
    return {
      rawLength: raw ? raw.length : 0,
      itemCount: parsed.length,
      items: parsed.map(p => ({ id: p.id, title: p.title, ep: p.episode, size: p.sizeFormatted })),
    };
  })()`);

  console.log("Real Offline Episodes:", res);
  ws.close();
}

run().catch(console.error);
