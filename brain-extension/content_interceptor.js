// SAP Cutover Brain v36 — content_interceptor.js
// Runs in MAIN world at document_start — bypasses CSP.
// Patches fetch + XHR so every API response is inspected for file URLs.

(function () {
  if (window.__sapBrain) return;

  window.__sapBrain = {
    fileUrls:     [],   // { url, name, ext, source }
    apiResponses: [],   // { url, snippet } first 600 chars of each JSON response
    phases:       [],
    tasks:        [],
  };

  function getExt(s) {
    const m = (s || '').match(/\.(pdf|xlsx?|pptx?|docx?|zip)\b/i);
    return m ? m[1].toLowerCase() : '';
  }

  function safeName(s) {
    return (s || 'file').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, '_').substring(0, 100);
  }

  function recordText(url, text) {
    if (!text || text.length < 2) return;

    // Keep a snippet of every JSON response for diagnostics
    const trimmed = text.trim();
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      if (window.__sapBrain.apiResponses.length < 60)
        window.__sapBrain.apiResponses.push({ url, snippet: text.substring(0, 600) });
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { return; }

    function walk(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 7) return;

      // --- File URL detection ---
      const urlCandidates = [
        obj.DownloadUrl, obj.downloadUrl, obj.Url, obj.url,
        obj.ContentUrl, obj.contentUrl, obj.FileUrl, obj.fileUrl,
        obj.ObjectKey, obj.objectKey, obj.Link, obj.link,
        obj.HRef, obj.href,
      ].filter(Boolean);

      for (const candidate of urlCandidates) {
        if (typeof candidate !== 'string') continue;
        const ext = getExt(candidate);
        if (ext) {
          const name = obj.FileName || obj.fileName || obj.Title || obj.title || obj.Name || obj.name || '';
          if (!window.__sapBrain.fileUrls.some(f => f.url === candidate)) {
            window.__sapBrain.fileUrls.push({
              url: candidate,
              name: safeName(name || candidate.split('/').pop()),
              ext,
              source: url,
            });
          }
        }
      }

      // --- Phase detection ---
      const nameVal = obj.Name || obj.name || obj.Title || obj.title || obj.DisplayName;
      const isPhase = nameVal && (
        obj.PhaseId !== undefined || obj.phaseId !== undefined ||
        obj.Sequence !== undefined || obj.sequence !== undefined ||
        obj.Type === 'PHASE' || obj.type === 'PHASE' ||
        obj.ItemType === 'Phase' || obj.itemType === 'Phase'
      );
      if (isPhase) {
        const id = String(obj.Id || obj.id || obj.PhaseId || obj.phaseId || Math.random());
        if (!window.__sapBrain.phases.some(p => p.id === id)) {
          window.__sapBrain.phases.push({
            id, name: String(nameVal),
            description: (obj.Description || obj.description || obj.LongText || '').substring(0, 500),
            sequence: +(obj.Sequence || obj.sequence || obj.Order || 0),
          });
          const tasks = obj.Tasks || obj.tasks || obj.Activities || obj.activities || obj.Items || obj.items || [];
          if (Array.isArray(tasks)) tasks.forEach(t => walk(t, depth + 1));
        }
      }

      // --- Task detection ---
      const isTask = nameVal && !isPhase && (
        obj.TaskId || obj.taskId || obj.ActivityId || obj.activityId ||
        obj.Type === 'TASK' || obj.type === 'task' ||
        obj.ItemType === 'Task' || obj.itemType === 'task'
      );
      if (isTask) {
        const tid = String(obj.Id || obj.id || obj.TaskId || obj.ActivityId || Math.random());
        if (!window.__sapBrain.tasks.some(t => t.id === tid)) {
          window.__sapBrain.tasks.push({
            id: tid, title: String(nameVal),
            description: (obj.Description || obj.description || '').substring(0, 500),
            phaseId: String(obj.PhaseId || obj.phaseId || ''),
          });
        }
      }

      // --- Recurse ---
      if (Array.isArray(obj)) {
        obj.forEach(item => walk(item, depth + 1));
      } else {
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      }
    }

    walk(data, 0);
  }

  // ── Patch window.fetch ────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (!reqUrl.match(/\.(css|js|png|jpg|svg|woff|gif|ico|map)(\?|$)/i)) {
        res.clone().text().then(text => recordText(reqUrl, text)).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // ── Patch XMLHttpRequest ──────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sapUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try { if (this.__sapUrl) recordText(this.__sapUrl, this.responseText); } catch (e) {}
    });
    return _send.apply(this, arguments);
  };

  // ── Track SPA navigation (SAP for Me uses pushState routing) ─────────────
  window.__sapBrain.navLog = [];
  const _pushState = history.pushState;
  history.pushState = function (state, title, url) {
    window.__sapBrain.navLog.push({ to: String(url), at: Date.now() });
    return _pushState.apply(this, arguments);
  };
  window.addEventListener('popstate', function () {
    window.__sapBrain.navLog.push({ to: location.href, at: Date.now(), type: 'pop' });
  });

})();
