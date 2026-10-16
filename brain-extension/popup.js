// SAP Cutover Brain — popup.js

let activeTabId    = null;
let brainDirHandle = null;

// ── Persist folder handle across popup sessions via IndexedDB ─────────────────
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('brainExt', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function saveHandle(h) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(h, 'brainDir');
    tx.oncomplete = res; tx.onerror = e => rej(e.target.error);
  });
}
async function loadHandle() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx  = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('brainDir');
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function getBrainDir() {
  const saved = await loadHandle().catch(() => null);
  if (saved) {
    try {
      const perm = await saved.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return saved;
      const req = await saved.requestPermission({ mode: 'readwrite' });
      if (req === 'granted') return saved;
    } catch(_) {}
  }
  const h = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(h).catch(() => {});
  return h;
}

function show(id) {
  ['loading','notSap','roadmapMode'].forEach(i => {
    document.getElementById(i).style.display = (i === id) ? 'block' : 'none';
  });
}
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function sanitizeFilename(name) {
  return (name||'file').replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,'_').trim().substring(0,120);
}
function base64ToUint8(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function writeFile(dir, filename, content) {
  const fh = await dir.getFileHandle(filename, { create:true });
  const wr = await fh.createWritable(); await wr.write(content); await wr.close();
}
function setStatus(text, pct) {
  document.getElementById('brainPct').textContent = text;
  if (pct !== undefined) document.getElementById('brainPb').style.width = pct + '%';
}
function isRealFile(bytes) { return !!(bytes && bytes.length >= 50); }
function extFromBytes(bytes, nameExt) {
  if (nameExt) return nameExt;
  if (!bytes || bytes.length < 4) return 'bin';
  if (bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46) return 'pdf';
  if (bytes[0]===0x50&&bytes[1]===0x4B&&bytes[2]===0x03&&bytes[3]===0x04) {
    const peek = new TextDecoder('utf-8',{fatal:false}).decode(bytes.slice(0,Math.min(bytes.length,8192)));
    if (peek.includes('ppt/'))  return 'pptx';
    if (peek.includes('xl/'))   return 'xlsx';
    if (peek.includes('word/')) return 'docx';
    return 'zip';
  }
  if (bytes[0]===0xD0&&bytes[1]===0xCF&&bytes[2]===0x11&&bytes[3]===0xE0) return 'doc';
  if (bytes[0]===0x3C)                                                      return 'html';
  if (bytes[0]===0xEF&&bytes[1]===0xBB&&bytes[2]===0xBF)                   return 'html';
  return 'bin';
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    activeTabId = tab.id;
    if (!tab.url || !tab.url.includes('me.sap.com')) { show('notSap'); return; }
    if (tab.url.includes('/roadmapviewer/')) {
      show('roadmapMode');
      document.getElementById('btnBrainExport').addEventListener('click', handleExport);
      return;
    }
    show('notSap');
  } catch(e) { show('notSap'); }
});

// ── Export ────────────────────────────────────────────────────────────────────
async function handleExport() {
  const btn      = document.getElementById('btnBrainExport');
  const progArea = document.getElementById('brainProgArea');
  const errEl    = document.getElementById('brainErr');
  const result   = document.getElementById('brainResult');
  const rows     = document.getElementById('brainResultRows');

  btn.disabled = true;
  progArea.style.display = 'block';
  result.style.display   = 'none';
  errEl.style.display    = 'none';
  setStatus('Pick an output folder…', 3);

  try {
    // ── Folder picker (remembered across sessions) ────────────────────────────
    brainDirHandle = await getBrainDir();

    setStatus('Scanning page…', 8);

    // ── Scan ──────────────────────────────────────────────────────────────────
    const scanRes = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action:'scanCutoverFiles', tabId:activeTabId }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
      setTimeout(() => reject(new Error('Scan timed out')), 120000);
    });

    if (!scanRes?.ok) throw new Error(scanRes?.error || 'Scan failed');

    const allFiles = scanRes.allFiles || [];
    if (!allFiles.length) throw new Error('No files found.');

    setStatus(`Found ${allFiles.length} file(s). Capturing…`, 18);

    const downloaded = [], failed = [], dlFallback = [];

    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      const safeName = sanitizeFilename(f.name) + '.' + (f.ext||'bin');
      setStatus(`Capturing ${i+1}/${allFiles.length}: ${f.name}…`, 18 + Math.round((i/allFiles.length)*62));

      if (f.inMemory && f.content) {
        const bytes = new TextEncoder().encode(f.content);
        let b64 = ''; const CH = 8190;
        for (let j = 0; j < bytes.length; j += CH)
          b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j+CH, bytes.length))));
        downloaded.push({ name:sanitizeFilename(f.name), ext:'html', base64:b64, url:'', size:bytes.length });
        continue;
      }

      let msgData;
      if (f.type==='task'&&f.url&&!f.noUrl) msgData={action:'captureTaskPage',url:f.url,tabId:activeTabId};
      else if (f.url&&!f.noUrl)             msgData={action:'fetchAndCapture',url:f.url,tabId:activeTabId,name:safeName};
      else                                   msgData={action:'clickAndCapture',fileName:f.name,tabId:activeTabId,name:safeName};

      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage(msgData, r => {
          if (chrome.runtime.lastError) resolve({ok:false,error:chrome.runtime.lastError.message});
          else resolve(r||{ok:false,error:'No response'});
        });
      });

      if (!res.ok && res.error?.includes('message channel') && !f._retried) {
        f._retried = true;
        await new Promise(r => setTimeout(r, 2000));
        i--; continue;
      }

      if (res.ok && res.base64) {
        const bytes = base64ToUint8(res.base64);
        if (isRealFile(bytes)) {
          downloaded.push({ name:sanitizeFilename(f.name), ext:extFromBytes(bytes,f.ext), base64:res.base64, url:f.url||res.cdnUrl||'', size:res.size });
          continue;
        }
        failed.push({ name:f.name, error:'Invalid bytes' });
      } else if (res.usedDownloads) {
        dlFallback.push({ name:f.name, error:res.error });
      } else {
        failed.push({ name:f.name, error:res.error||'Capture failed' });
      }
    }

    // ── Write ─────────────────────────────────────────────────────────────────
    setStatus(`Writing ${downloaded.length} file(s)…`, 83);

    await writeFile(brainDirHandle, 'diagnostics.json', JSON.stringify({
      exportedAt: new Date().toISOString(), filesFound: allFiles.length,
      downloaded: downloaded.length, failed: failed.length,
      files: allFiles.map(f=>({name:f.name,url:f.url,ext:f.ext})),
    }, null, 2));

    const filesDir = await brainDirHandle.getDirectoryHandle('files', { create:true });
    let written = 0;
    for (let i = 0; i < downloaded.length; i++) {
      const f = downloaded[i];
      setStatus(`Writing ${i+1}/${downloaded.length}: ${f.name}…`, 83+Math.round((i/downloaded.length)*16));
      try { await writeFile(filesDir, f.name+'.'+(f.ext||'bin'), base64ToUint8(f.base64)); written++; }
      catch(e) { failed.push({name:f.name, error:'Write failed: '+e.message}); }
    }

    setStatus('Done!', 100);

    // Push to local brain server if running (auto-indexes for distribution use)
    try {
      const payload = {
        files: downloaded.map(f => ({ name:f.name, ext:f.ext, base64:f.base64 })),
        diagnostics: { exportedAt: new Date().toISOString(), filesFound: allFiles.length, downloaded: written },
      };
      const ping = await fetch('http://localhost:7878/api/ingest', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(5000)
      });
      if (ping.ok) setStatus('Done! Brain server updated.', 100);
    } catch(_) { /* server not running — folder save is sufficient */ }

    rows.innerHTML = [
      ['Files found',                       allFiles.length],
      ['Saved to '+brainDirHandle.name,     written],
      ['Failed',                            failed.length],
    ].map(([k,v]) =>
      `<div class="rrow"><span class="rk">${escHtml(k)}</span><span class="rv">${escHtml(String(v))}</span></div>`
    ).join('');

    if (failed.length) {
      rows.innerHTML += `<div style="margin-top:6px;font-size:9px;color:#FF6B6B;line-height:1.7">`+
        failed.map(f=>`<b>${escHtml(f.name.substring(0,40))}</b>: ${escHtml(f.error||'?')}`).join('<br>')+`</div>`;
    }

    result.style.display = 'block';
    btn.textContent = 'Export Again';
    btn.disabled    = false;

    chrome.notifications.create({ type:'basic', iconUrl:'icon48.png', title:'SAP Cutover Brain',
      message:`Export done — ${written} file(s) saved to ${brainDirHandle.name}/files/` });

  } catch(e) {
    if (e.name === 'AbortError') {
      brainDirHandle = null; btn.disabled = false; progArea.style.display = 'none'; return;
    }
    errEl.textContent   = e.message || String(e);
    errEl.style.display = 'block';
    document.getElementById('brainPb').style.width = '0%';
    btn.textContent = 'Retry Export';
    btn.disabled    = false;
  }
}
