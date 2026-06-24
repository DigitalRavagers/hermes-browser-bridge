(() => {
  const status = document.getElementById('status');
  const screenshot = document.getElementById('screenshot');
  const btnCapture = document.getElementById('BtnCapture');
  const btnCopyUrl = document.getElementById('BtnCopyUrl');

  if (window.chrome?.runtime?.connect) {
    const port = chrome.runtime.connect({ name: 'hermes-bridge-native' });
    const pending = new Map();
    let nextId = 1;

    port.onMessage.addListener((msg) => {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result || msg.error); }
    });

    function nativeCall(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        port.postMessage({ id, method, params });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('native messaging timeout')); } }, 12000);
      });
    }

    async function init() {
      try {
        const ok = await nativeCall('health_check');
        status.className = 'status' + (ok?.ok ? ' ok' : ' err');
        status.textContent = ok?.ok ? 'Bridge connected' : 'Bridge returned error';
      } catch (e) {
        status.className = 'status err';
        status.textContent = 'Bridge unreachable. Run the bridge server first.';
      }
    }
    init();

    btnCapture.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      try {
        const r = await nativeCall('proxy_request', { path: '/screenshot', method: 'POST', body: { url: tab.url, width: 1280, height: 800 } });
        const data = typeof r.json === 'string' ? r.json : r.json;
        if (data?.dataUrl) {
          screenshot.innerHTML = `<img src="${data.dataUrl}" style="max-width:100%;display:block;border-radius:6px;border:1px solid #e5e7eb;" />`;
        } else {
          screenshot.textContent = JSON.stringify(data, null, 2);
        }
      } catch (e) {
        screenshot.className = 'status err';
        screenshot.textContent = String(e);
      }
    });

    btnCopyUrl.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;
      await navigator.clipboard.writeText(tab.url);
      btnCopyUrl.textContent = 'Copied!';
      setTimeout(() => (btnCopyUrl.textContent = 'Copy URL'), 2000);
    });
  } else {
    status.className = 'status err';
    status.textContent = 'Native messaging unavailable in this context.';
  }
})();
