// SAP Cutover Brain v35 — content_roadmap.js
// Runs in ISOLATED world — has chrome APIs.
// Relays file-download requests from background.js using the page's session cookies.

chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  // Background reads the intercepted data via executeScript(world:MAIN),
  // but file downloads must go through this content script (has session cookies).
  if (msg.action === 'fetchFileBytes') {
    (async () => {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const r = await fetch(msg.url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) { respond({ ok: false, error: 'HTTP ' + r.status }); return; }
        const buf   = await r.arrayBuffer();
        if (buf.byteLength < 50) { respond({ ok: false, error: 'Too small — likely an auth redirect' }); return; }
        const bytes = new Uint8Array(buf);
        const CHUNK = 8192;
        let b64 = '';
        for (let i = 0; i < bytes.length; i += CHUNK)
          b64 += btoa(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
        respond({ ok: true, base64: b64, size: buf.byteLength });
      } catch (e) {
        respond({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
