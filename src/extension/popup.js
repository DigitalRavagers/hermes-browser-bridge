(() => {
  const status = document.getElementById('status');
  const screenshot = document.getElementById('screenshot');
  const btnCapture = document.getElementById('BtnCapture');
  const btnCopyUrl = document.getElementById('BtnCopyUrl');

  chrome.runtime.sendMessage({ type: 'ping' }, (res) => {
    if (chrome.runtime.lastError) {
      status.className = 'status err';
      status.textContent = 'Bridge unreachable. Run the bridge server first.';
      return;
    }
    status.className = 'status' + (res?.ok ? ' ok' : ' err');
    status.textContent = res?.ok ? 'Bridge connected' : 'Bridge returned error';
  });

  btnCapture.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    try {
      const r = await fetch(`http://127.0.0.1:8765/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: tab.url, width: 1280, height: 800 })
      });
      const data = await r.json();
      if (data.url) {
        screenshot.innerHTML = `<img src="${data.url}" style="max-width:100%;display:block;border-radius:6px;border:1px solid #e5e7eb;" />`;
      } else if (data.dataUrl) {
        screenshot.innerHTML = `<img src="${data.dataUrl}" style="max-width:100%;display:block;border-radius:6px;border:1px solid #e5e7eb;" />`;
      } else {
        screenshot.textContent = JSON.stringify(data);
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
})();
