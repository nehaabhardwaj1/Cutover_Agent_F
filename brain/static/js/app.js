"use strict";
// ═══════════════════════════════════════════════════════════════════════
// SAP Cutover Agent — UI Layer (vanilla JS)
// Business logic lives in logic.js (loaded first via <script>)
// ═══════════════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────────────
const BRAIN_URL  = "http://localhost:7878";
// STORE_KEY and STATUS_CYCLE are declared in logic.js (loaded first)

const STATUS_CFG = {
  PENDING:     { bg:"#f1f5f9", fg:"#64748b", label:"Pending" },
  IN_PROGRESS: { bg:"#dbeafe", fg:"#1d4ed8", label:"In Progress" },
  COMPLETE:    { bg:"#dcfce7", fg:"#16a34a", label:"Complete" },
  VERIFIED:    { bg:"#d1fae5", fg:"#059669", label:"Verified" },
  BLOCKED:     { bg:"#fee2e2", fg:"#dc2626", label:"Blocked" },
  SKIPPED:     { bg:"#f1f5f9", fg:"#94a3b8", label:"Skipped" },
};
// STATUS_CYCLE declared in logic.js

const PC = {
  PRE:  { bg:"#dbeafe", fg:"#1d4ed8" },
  CUT:  { bg:"#fef3c7", fg:"#b45309" },
  POST: { bg:"#dcfce7", fg:"#15803d" },
  HC:   { bg:"#e0f2fe", fg:"#0369a1" },
  RAMP: { bg:"#ede9fe", fg:"#7c3aed" },
};

const NAV = [
  { label:"Project", items:[
    { id:"input",        label:"Plan Builder",    icon:"⌂" },
    { id:"dashboard",    label:"Dashboard",       icon:"◈" },
  ]},
  { label:"Planning", items:[
    { id:"tasks",        label:"Task Plan",       icon:"☰" },
    { id:"timeline",     label:"Timeline",        icon:"▬" },
    { id:"ricefw",       label:"RICEFW",          icon:"⊞" },
    { id:"integrations", label:"Integrations",    icon:"⇌" },
    { id:"training",     label:"Training",        icon:"✎" },
    { id:"coverage",     label:"Readiness",       icon:"✓" },
  ]},
  { label:"Monitoring", items:[
    { id:"command",      label:"Execution",       icon:"▶" },
    { id:"tower",        label:"Orchestration",   icon:"⬡" },
  ]},
  { label:"Intelligence", items:[
    { id:"brain",        label:"Knowledge Base",  icon:"◆" },
    { id:"agents",       label:"AI Insights",     icon:"✦" },
  ]},
];

const AGENTS_DEF = [
  { key:"waveOrchestration", label:"Wave Orchestrator",  desc:"Sequences all cutover waves and recommends the optimal execution order." },
  { key:"readiness",         label:"Readiness Assessor", desc:"Evaluates go-live readiness against SAP Activate criteria." },
  { key:"goNoGo",            label:"Go/No-Go Judge",     desc:"AI go-live recommendation with a confidence score." },
  { key:"riskMitigation",    label:"Risk & Mitigation",  desc:"Top cutover risks and mitigation/contingency plans." },
  { key:"rollbackPlan",      label:"Rollback Planner",   desc:"Phase-by-phase rollback strategy with decision triggers." },
  { key:"executiveReport",   label:"Executive Report",   desc:"Sponsor-ready executive summary of cutover status." },
  { key:"dataValidation",    label:"Data Validation",    desc:"Data migration completeness and cutover data quality risks." },
  { key:"ricefw",            label:"RICEFW Agent",       desc:"Custom development readiness, testing gaps, transport status." },
  { key:"commandCenter",     label:"Command Center",     desc:"Live execution status, active blockers, war-room narrative." },
  { key:"retrospective",     label:"Retrospective",      desc:"Lessons learned and improvement recommendations." },
  { key:"hypercare",         label:"Hypercare Planner",  desc:"Post go-live support schedule and escalation protocols." },
];

const INDUSTRIES_LIST = [
  { k:"", label:"Select industry…" },
  { k:"consumer",      label:"Consumer / FMCG" },
  { k:"manufacturing", label:"Manufacturing" },
  { k:"utilities",     label:"Utilities" },
  { k:"lifesciences",  label:"Life Sciences / Pharma" },
  { k:"publicsector",  label:"Public Sector" },
  { k:"oilgas",        label:"Oil & Gas / Energy" },
  { k:"financial",     label:"Financial Services" },
  { k:"automotive",    label:"Automotive" },
];

// Built from SAP_LOB_GROUPS (logic.js): value is the LoB name the engine uses,
// label keeps the SAP codes visible.
const MODULES_LIST = (typeof SAP_LOB_GROUPS !== "undefined" ? SAP_LOB_GROUPS : [])
  .map(g => ({ value: g.lob, label: lobLabel(g) }));

// ── State ─────────────────────────────────────────────────────────────
let STATE = {
  sessions:{}, sid:null, tab:"input",
  agentRunning:null, agentOutputs:{},
  loaded:false,
  sideAskQ:"", sideAskResult:null, sideAskLoading:false,
  brainOnline:null,
  // local UI state (not persisted)
  flt:{ q:"",status:"",phase:"",ws:"",owner:"",type:"",entity:"",cp:false },
  enrichLoading:false, enrichResult:null, genResult:null,
  confirmFinalize:false, confirmDeleteId:null,
  editCell:null,
  agentExpanded:{},
  whatIfQ:"", whatIfText:"", whatIfLoading:false,
  kbMessages:[], kbInput:"", kbLoading:false,
  kbUploadBusy:false, kbUploadResult:null, kbPendingFiles:[],
  kbIndustry:"", kbClientNames:"",
  importModal:false, importBusy:false, importErr:"",
  newSessionModal:false,
  sideAskModal:false,
  selected:{},
  showOwnerGap:false,
  contributeStatus:null,
  showEmail:null,
  showLink:null,
  fixTask:null, fixText:"", fixLoading:false,
  aiFlag:{},
  showRicefwAdd:false,
  showIntegAdd:false,
  showTrainingAdd:false,
  showApprovalAdd:false,
  linkModal:{ open:false, taskId:null, url:"", note:"", approver:"", approvedAt:"" },
  emailModal:{ open:false, taskId:null, owner:"", email:"", subject:"", body:"" },
};

let _saveTimer = null;
let _enrichTimer = null;
let _enrichStart = null;
let _enrichAbort = null;
let _genTimer = null;

function startEnrichTimer() {
  _enrichStart = Date.now();
  clearInterval(_enrichTimer);
  _enrichTimer = setInterval(() => {
    const sec = Math.round((Date.now() - _enrichStart) / 1000);
    const fmt = sec >= 60 ? `${Math.floor(sec/60)}m ${sec%60}s` : `${sec}s`;
    const el1 = document.getElementById("enrich-timer");
    const el2 = document.getElementById("enrich-timer-big");
    if (el1) el1.textContent = fmt;
    if (el2) el2.textContent = fmt;
  }, 1000);
}

function stopEnrichTimer() {
  clearInterval(_enrichTimer);
  _enrichTimer = null;
  _enrichStart = null;
}

function gS() {
  return STATE.sessions[STATE.sid] || null;
}
function gP() {
  const s = gS(); return s ? s.project : {};
}
function gPlan() {
  const s = gS(); return s ? (s.state.plan || { tasks:[], finalized:false }) : { tasks:[], finalized:false };
}

function setState(patch, noRender) {
  Object.assign(STATE, patch);
  scheduleSave();
  if (!noRender) render();
}

function updateSession(patch) {
  const s = gS(); if (!s) return;
  Object.assign(s, patch);
  setState({});
}

function updateProject(patch) {
  const s = gS(); if (!s) return;
  Object.assign(s.project, patch);
  setState({});
}

function updatePlan(patch) {
  const s = gS(); if (!s) return;
  if (!s.state.plan) s.state.plan = { tasks:[], finalized:false };
  Object.assign(s.state.plan, patch);
  setState({});
}

function updateTask(id, patch) {
  const plan = gPlan();
  const t = plan.tasks.find(t => t.id === id);
  if (!t) return;
  Object.assign(t, patch);
  scheduleSave();
  // Targeted DOM update for status chip
  if (patch.status) {
    const chip = document.getElementById("sc-" + id);
    if (chip) {
      const sc = STATUS_CFG[patch.status] || STATUS_CFG.PENDING;
      chip.textContent = sc.label;
      chip.style.background = sc.bg;
      chip.style.color = sc.fg;
      chip.style.border = `1px solid ${sc.fg}44`;
    }
  }
  // For other field changes, re-render the table section
  if (!patch.status) render();
}

// ── Storage ───────────────────────────────────────────────────────────
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const val = raw ? JSON.parse(raw) : {};
    return { sessions: val.sessions || {}, sid: val.sid || null };
  } catch(e) { return { sessions:{}, sid:null }; }
}

function saveStore() {
  if (!STATE.loaded) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      sessions: STATE.sessions, sid: STATE.sid
    }));
  } catch(e) {}
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStore, 400);
}

function newSession(project) {
  const sid = "SID-" + Date.now();
  const sess = {
    id: sid,
    project: {
      projectName:"", approach:"Big Bang", landscape:"3-System (Dev → Test → Prod)",
      industry:"", cutoverStartDate:"", cutoverStartTime:"",
      cutoverDurationH:48, goLiveDate:"", downtimeStartDate:"",
      downtimeStartTime:"", downtimeDurationH:8,
      countries:[], legalEntities:[], modules:[], waves:[],
      scopeItems:[], size:"", sizeMode:"", sizingSignals:{},
      ownerEmails:{}, source:"",
      systemLandscape:{}, sapRef:{},
      ...project
    },
    state: {
      plan:{ tasks:[], finalized:false },
      l4Tasks:[], planMeta:{}, waves:[], ricefw:[], interfaces:[],
      training:[], enrich:{}, rehearsal:{}, auditLog:[], approvals:[],
    },
    agents:{},
    status:"ACTIVE",
    createdAt: new Date().toISOString(),
  };
  STATE.sessions[sid] = sess;
  STATE.sid = sid;
  setState({});
}

// ── API ───────────────────────────────────────────────────────────────
async function isBrainAvailable() {
  try {
    const r = await fetch(BRAIN_URL + "/api/status", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch(e) { return false; }
}

async function callAgent(payload) {
  const r = await fetch(BRAIN_URL + "/api/agent", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error("Agent error " + r.status);
  const d = await r.json();
  return d.text || "";
}

async function enrichPlan(body, signal) {
  const r = await fetch(BRAIN_URL + "/api/enrich", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body),
    signal: signal || null
  });
  if (!r.ok) throw new Error("Enrich error " + r.status);
  return r.json();
}

async function askBrain(q, limit) {
  const r = await fetch(BRAIN_URL + "/api/ask", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ q, limit: limit || 8 })
  });
  if (!r.ok) throw new Error("Ask error " + r.status);
  return r.json();
}

async function kbUpload(body) {
  const r = await fetch(BRAIN_URL + "/api/kb-upload", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  return r.json();
}

async function kbStatus(jobId) {
  const r = await fetch(BRAIN_URL + "/api/kb-status/" + jobId);
  return r.json();
}

async function contributePlan(body) {
  const r = await fetch(BRAIN_URL + "/api/contribute-plan", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  return r.json();
}

// ── Helpers ───────────────────────────────────────────────────────────
function toast(msg, type) {
  const id = Date.now();
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " toast-error" : type === "success" ? " toast-success" : "");
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

function safeDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderMarkdown(text) {
  if (!text) return "";
  let h = text
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/^### (.+)$/gm,"<h3>$1</h3>")
    .replace(/^## (.+)$/gm,"<h2>$1</h2>")
    .replace(/^# (.+)$/gm,"<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,"<em>$1</em>")
    .replace(/`([^`]+)`/g,"<code>$1</code>")
    .replace(/^---$/gm,"<hr>")
    .replace(/^> (.+)$/gm,"<blockquote>$1</blockquote>")
    .replace(/^\s*[-*] (.+)$/gm,"<li>$1</li>")
    .replace(/^\s*\d+\. (.+)$/gm,"<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, m => "<ul>" + m + "</ul>")
    .replace(/\n\n+/g,"</p><p>")
    .replace(/\n/g,"<br>");
  return '<div class="md-out"><p>' + h + "</p></div>";
}

function nowStamp() {
  const d = new Date(), p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return iso.replace("T"," ").slice(0,16);
}

function taskSummary(tasks) {
  if (!tasks || !tasks.length) return "No tasks";
  const done = tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const blocked = tasks.filter(t=>t.status==="BLOCKED").length;
  return `${tasks.length} tasks — ${done} complete, ${blocked} blocked`;
}

function phaseChip(ph) {
  const c = PC[ph] || { bg:"#f1f5f9", fg:"#64748b" };
  return `<span class="phase-chip" style="background:${c.bg};color:${c.fg};border:1px solid ${c.fg}33">${escHtml(ph)||"—"}</span>`;
}

function statusChip(status, taskId) {
  const sc = STATUS_CFG[status] || STATUS_CFG.PENDING;
  const click = taskId ? `onclick="APP.cycleStatus('${taskId}')"` : "";
  return `<span id="sc-${taskId||""}" class="status-chip" ${click} style="background:${sc.bg};color:${sc.fg};border:1px solid ${sc.fg}44">${sc.label}</span>`;
}

function priorityDisplay(pr) {
  const col = pr==="HIGH" ? "#b91c1c" : pr==="MEDIUM" ? "#92400e" : "#64748b";
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${col}">
    <span style="width:7px;height:7px;border-radius:50%;background:${col};flex-shrink:0"></span>${escHtml(pr||"—")}
  </span>`;
}

function workstreamBadge(ws) {
  const technical = /\b(basis|technical|development|ricefw|custom|interface|integration|transport)\b/i.test(ws||"");
  const badge = technical
    ? `<span style="font-size:9px;font-weight:700;color:#92400e;border:1px solid #d97706;border-radius:3px;padding:0 4px;margin-right:5px">TECH</span>`
    : `<span style="font-size:9px;font-weight:700;color:#7c3aed;border:1px solid #a78bfa;border-radius:3px;padding:0 4px;margin-right:5px">FUNC</span>`;
  return badge + escHtml(ws||"—");
}

// ── Brain status poll ─────────────────────────────────────────────────
let _brainPollTimer = null;
function startBrainPoll() {
  if (_brainPollTimer) return;
  isBrainAvailable().then(ok => {
    STATE.brainOnline = ok;
    const badge = document.getElementById("brain-badge");
    if (badge) {
      badge.className = "brain-badge " + (ok ? "brain-online" : "brain-offline");
      badge.innerHTML = `<span class="dot ${ok?"dot-green":"dot-red"}"></span>${ok?"Brain Online":"Brain Offline"}`;
    }
  });
  _brainPollTimer = setInterval(() => {
    isBrainAvailable().then(ok => {
      STATE.brainOnline = ok;
      const badge = document.getElementById("brain-badge");
      if (badge) {
        badge.className = "brain-badge " + (ok ? "brain-online" : "brain-offline");
        badge.innerHTML = `<span class="dot ${ok?"dot-green":"dot-red"}"></span>${ok?"Brain Online":"Brain Offline"}`;
      }
    });
  }, 30000);
}

// ── Render: Layout ────────────────────────────────────────────────────
function renderHeader() {
  const p = gP();
  const name = p.projectName || "SAP Cutover Agent";
  return `
  <div class="header-brand">
    <div class="header-brand-icon">✦</div>
    <div>
      <div class="header-brand-name">${escHtml(name)}</div>
      <div class="header-brand-sub">SAP S/4HANA</div>
    </div>
  </div>
  <div class="header-right">
    <span id="brain-badge" class="brain-badge ${STATE.brainOnline===true?"brain-online":STATE.brainOnline===false?"brain-offline":"brain-offline"}">
      <span class="dot ${STATE.brainOnline?"dot-green":"dot-red"}"></span>
      ${STATE.brainOnline?"Brain Online":"Brain Offline"}
    </span>
    <button class="btn btn-secondary btn-sm" onclick="APP.showNewSession()">+ New Session</button>
    ${Object.keys(STATE.sessions).length > 1 ? `<select class="filter-select" onchange="APP.switchSession(this.value)" style="min-width:160px">
      ${Object.values(STATE.sessions).map(s=>`<option value="${s.id}" ${s.id===STATE.sid?"selected":""}>${escHtml(s.project.projectName||s.id)}</option>`).join("")}
    </select>
    <button class="btn btn-sm" style="background:#dc2626;color:#fff;padding:4px 10px;border:none;border-radius:6px;cursor:pointer" onclick="APP.deleteSession()" title="Delete current session">✕ Delete</button>` : ""}
  </div>`;
}

function renderSidebar() {
  let html = "";
  NAV.forEach(grp => {
    html += `<div class="nav-section">${grp.label}</div>`;
    grp.items.forEach(item => {
      const active = STATE.tab === item.id ? "active" : "";
      html += `<button class="nav-item ${active}" onclick="APP.nav('${item.id}')">
        <span class="nav-item-icon">${item.icon}</span>${escHtml(item.label)}
      </button>`;
    });
  });
  // Sidebar KB ask
  html += `
  <div class="side-ask">
    <div class="side-ask-label">Ask Knowledge Base</div>
    <div class="side-ask-row">
      <input type="text" placeholder="Quick question…" id="side-ask-inp"
        value="${escHtml(STATE.sideAskQ)}"
        onkeydown="if(event.key==='Enter')APP.sideAsk()"
        oninput="STATE.sideAskQ=this.value" />
      <button onclick="APP.sideAsk()">${STATE.sideAskLoading?"…":"Ask"}</button>
    </div>
  </div>`;
  return html;
}

// ── Render: Main ──────────────────────────────────────────────────────
function render() {
  document.getElementById("header").innerHTML = renderHeader();
  document.getElementById("sidebar").innerHTML = renderSidebar();
  const tab = STATE.tab;
  let html = "";
  if      (tab==="input")        html = renderInput();
  else if (tab==="tasks")        html = renderTasks();
  else if (tab==="agents")       html = renderAgents();
  else if (tab==="brain")        html = renderBrain();
  else if (tab==="dashboard")    html = renderDashboard();
  else if (tab==="coverage")     html = renderCoverage();
  else if (tab==="command")      html = renderCommand();
  else if (tab==="ricefw")       html = renderRicefw();
  else if (tab==="timeline")     html = renderTimeline();
  else if (tab==="integrations") html = renderIntegrations();
  else if (tab==="training")     html = renderTraining();
  else if (tab==="tower")        html = renderTower();
  else                           html = renderStub(tab);
  document.getElementById("content").innerHTML = html;
  document.getElementById("modal-root").innerHTML = renderModals();
}

// ── Tab: Plan Builder (Input) ─────────────────────────────────────────
function renderInput() {
  const p = gP();
  const s = gS();
  const tasks = s ? (s.state.plan.tasks || []) : [];
  const hasTasks = tasks.length > 0;
  const hasL4 = s && s.state.l4Tasks && s.state.l4Tasks.length > 0;
  const meta = s ? (s.state.planMeta || {}) : {};

  const moduleSel = MODULES_LIST.map(m => {
    const sel = (p.modules||[]).includes(m.value) ? "selected" : "";
    return `<option value="${escHtml(m.value)}" ${sel}>${escHtml(m.label)}</option>`;
  }).join("");

  const modPills = (p.modules||[]).map(m=>`<span class="mod-pill">${escHtml(m)}</span>`).join("") || `<span class="text-muted text-sm">None selected</span>`;

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Plan Builder</div>
    <div class="page-sub">Upload your L4 plan or generate from the SAP Activate library</div>
  </div>

  <!-- L4 Upload -->
  <div class="card">
    <div class="card-header">L4 Plan</div>
    <div class="card-body">
      ${hasTasks ? `
        <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
          <div class="kpi-tile"><div class="kpi-label">Tasks</div><div class="kpi-value">${tasks.length}</div></div>
          <div class="kpi-tile"><div class="kpi-label">Complete</div><div class="kpi-value" style="color:#059669">${tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length}</div></div>
          <div class="kpi-tile"><div class="kpi-label">Blocked</div><div class="kpi-value" style="color:#dc2626">${tasks.filter(t=>t.status==="BLOCKED").length}</div></div>
          <div class="kpi-tile"><div class="kpi-label">Source</div><div class="kpi-value" style="font-size:14px">${escHtml(meta.source||"Library")}</div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="APP.nav('tasks')">View Task Plan →</button>
          <button class="btn btn-secondary" onclick="APP.triggerImport()">Re-import L4</button>
          <button class="btn btn-secondary" onclick="APP.buildPlan()">Regenerate from Library</button>
          <button class="btn btn-danger" style="margin-left:auto" onclick="APP.clearPlan()">🗑 Clear Plan</button>
        </div>
      ` : `
        <p class="text-muted" style="margin-bottom:14px">Upload your SAP L4 workplan to generate a tailored cutover checklist, or generate from the SAP Activate library.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="APP.triggerImport()">⬆ Upload L4 Plan</button>
          <button class="btn btn-secondary" onclick="APP.buildPlan()">Generate from SAP Library</button>
        </div>
      `}
    </div>
  </div>

  <!-- Project Settings -->
  <div class="card pb-compact">
    <div class="card-header">Project Setup</div>
    <div class="card-body">
      <div class="form-row pb-grid-4">
        <div class="form-group">
          <label class="form-label">Project Name</label>
          <input type="text" value="${escHtml(p.projectName||"")}" oninput="APP.upP('projectName',this.value)" placeholder="e.g. ACME S/4HANA Go-Live" />
        </div>
        <div class="form-group">
          <label class="form-label">Industry</label>
          <select onchange="APP.upP('industry',this.value)">
            ${INDUSTRIES_LIST.map(i=>`<option value="${i.k}" ${p.industry===i.k?"selected":""}>${i.label}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Deployment Approach</label>
          <select onchange="APP.upP('approach',this.value)">
            ${["Big Bang","Phased / Wave rollout"].map(v=>`<option value="${v}" ${p.approach===v?"selected":""}>${v}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Countries</label>
          <input type="text" value="${(p.countries||[]).join(", ")}" onblur="APP.upP('countries',this.value.split(',').map(x=>x.trim()).filter(Boolean))" placeholder="US, UK, DE" />
        </div>
      </div>

      <div class="form-row pb-grid-6">
        <div class="form-group">
          <label class="form-label">Cutover Start</label>
          <input type="date" value="${escHtml(p.cutoverStartDate||"")}" onchange="APP.upP('cutoverStartDate',this.value)" />
        </div>
        <div class="form-group">
          <label class="form-label">Start Time</label>
          <input type="time" value="${escHtml(p.cutoverStartTime||"")}" onchange="APP.upP('cutoverStartTime',this.value)" />
        </div>
        <div class="form-group">
          <label class="form-label">Window (h)</label>
          <input type="number" min="1" value="${p.cutoverDurationH||48}" onchange="APP.upP('cutoverDurationH',+this.value)" />
        </div>
        <div class="form-group">
          <label class="form-label">Go-Live Date</label>
          <input type="date" value="${escHtml(p.goLiveDate||"")}" onchange="APP.upP('goLiveDate',this.value)" />
        </div>
        <div class="form-group">
          <label class="form-label">Downtime Start</label>
          <input type="date" value="${escHtml(p.downtimeStartDate||"")}" onchange="APP.upP('downtimeStartDate',this.value)" />
        </div>
        <div class="form-group">
          <label class="form-label">Downtime (h)</label>
          <input type="number" min="0" value="${p.downtimeDurationH||8}" onchange="APP.upP('downtimeDurationH',+this.value)" />
        </div>
      </div>

      <div class="form-row pb-grid-4" style="margin-bottom:6px">
        <div class="form-group">
          <label class="form-label">Legal Entities / Company Codes</label>
          <input type="text" value="${(p.legalEntities||[]).join(", ")}" onblur="APP.upP('legalEntities',this.value.split(',').map(x=>x.trim()).filter(Boolean))" placeholder="1000, 2000" />
        </div>
        <div class="form-group" style="grid-column:span 3">
          <label class="form-label">SAP Modules in Scope — drives which business areas get tasks</label>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="mod-add-sel" class="filter-select" style="font-size:12px;padding:5px 8px">
              <option value="">Add module…</option>
              ${MODULES_LIST.map(m=>`<option value="${escHtml(m.value)}">${escHtml(m.label)}</option>`).join("")}
            </select>
            <button class="btn btn-secondary btn-sm" onclick="APP.addModule()">Add</button>
            ${(p.modules||[]).length
              ? (p.modules||[]).map(m=>`<span class="mod-pill" style="cursor:pointer" onclick="APP.removeModule('${m}')">${escHtml(m)} ✕</span>`).join("")
              : `<span class="text-muted text-sm">None selected — scope items from the L4 will be used instead</span>`}
          </div>
        </div>
      </div>

      <details class="pb-more">
        <summary>System landscape &amp; SAP references — named in generated tasks (legacy system, middleware, non-SAP systems, approver)</summary>
        <div>
          <div class="form-row pb-grid-4">
            <div class="form-group"><label class="form-label">Source System</label>
              <input type="text" value="${escHtml((p.systemLandscape||{}).source||"")}" placeholder="ECC 6.0" onblur="APP.upLandscape('source',this.value)" /></div>
            <div class="form-group"><label class="form-label">Target System</label>
              <input type="text" value="${escHtml((p.systemLandscape||{}).target||"")}" placeholder="S/4HANA 2023" onblur="APP.upLandscape('target',this.value)" /></div>
            <div class="form-group"><label class="form-label">Middleware</label>
              <input type="text" value="${escHtml((p.systemLandscape||{}).middleware||"")}" placeholder="PI/PO, MuleSoft" onblur="APP.upLandscape('middleware',this.value)" /></div>
            <div class="form-group"><label class="form-label">Non-SAP Systems</label>
              <input type="text" value="${escHtml((p.systemLandscape||{}).nonSap||"")}" placeholder="Salesforce, Ariba" onblur="APP.upLandscape('nonSap',this.value)" /></div>
          </div>
          <div class="form-row pb-grid-4" style="margin-bottom:4px">
            <div class="form-group"><label class="form-label">Data Centre / Hosting</label>
              <input type="text" value="${escHtml((p.systemLandscape||{}).hosting||"")}" placeholder="AWS eu-west-1" onblur="APP.upLandscape('hosting',this.value)" /></div>
            <div class="form-group"><label class="form-label">SAP Project Reference</label>
              <input type="text" value="${escHtml((p.sapRef||{}).projectRef||"")}" placeholder="Solution Manager ID" onblur="APP.upSapRef('projectRef',this.value)" /></div>
            <div class="form-group"><label class="form-label">SAP Activate Phase</label>
              <select onchange="APP.upSapRef('activatePhase',this.value)">
                ${["","Discover","Prepare","Explore","Realize","Deploy","Run"].map(ph=>`<option value="${ph}" ${(p.sapRef||{}).activatePhase===ph?"selected":""}>${ph||"Select…"}</option>`).join("")}
              </select></div>
            <div class="form-group"><label class="form-label">Governance Notes</label>
              <input type="text" value="${escHtml((p.sapRef||{}).governance||"")}" placeholder="PMO ticket, SteerCo ref" onblur="APP.upSapRef('governance',this.value)" /></div>
          </div>
        </div>
      </details>
    </div>
  </div>

  <!-- Owners & Emails -->
  <div class="card">
    <div class="card-header">Owners & Emails
      <button class="btn btn-secondary btn-sm" onclick="APP.autoMatchOwners()">Auto-match from Tasks</button>
    </div>
    <div class="card-body">
      <p class="text-muted text-sm" style="margin-bottom:10px">Map owner names to email addresses — used by the ✉ button on each task row.</p>
      <div style="max-height:200px;overflow-y:auto;margin-bottom:10px">
        ${Object.entries(p.ownerEmails||{}).length===0 ? `<p class="text-muted text-sm">No owners mapped yet. Add entries below or click Auto-match.</p>` :
          Object.entries(p.ownerEmails||{}).map(([name,email])=>`
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
            <input type="text" value="${escHtml(name)}" style="width:160px" readonly />
            <input type="email" value="${escHtml(email)}" placeholder="email@company.com"
              style="flex:1" onblur="APP.upOwnerEmail('${escHtml(name)}',this.value)" />
            <button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.removeOwnerEmail('${escHtml(name)}')">✕</button>
          </div>`).join("")}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="oe-name" placeholder="Owner name" style="width:160px" />
        <input type="email" id="oe-email" placeholder="Email address" style="flex:1" />
        <button class="btn btn-secondary btn-sm" onclick="APP.addOwnerEmail()">Add</button>
      </div>
    </div>
  </div>

  <!-- Wave Plan (shown when approach is Phased / Wave rollout) -->
  ${p.approach==="Phased / Wave rollout" ? `
  <div class="card">
    <div class="card-header">Wave Plan
      <button class="btn btn-secondary btn-sm" onclick="APP.addWave()">+ Add Wave</button>
    </div>
    <div class="card-body" style="padding:0">
      ${!(p.waves||[]).length ? `<p class="text-muted text-sm" style="padding:14px">No waves defined. Click "+ Add Wave" to start planning phases.</p>` : `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f8f9fa">
          <th style="padding:8px 12px;text-align:left">Wave</th>
          <th style="padding:8px">Scope</th>
          <th style="padding:8px">Go-Live Date</th>
          <th style="padding:8px">Window (h)</th>
          <th style="padding:8px">Countries/Entities</th>
          <th style="padding:8px;width:50px"></th>
        </tr></thead>
        <tbody>${(p.waves||[]).map((w,i)=>`<tr style="border-top:1px solid #f0f0f4">
          <td style="padding:8px 12px;font-weight:700;color:#A100FF">Wave ${i+1}</td>
          <td style="padding:8px"><input type="text" value="${escHtml(w.scope||"")}" style="width:160px;font-size:11px" onblur="APP.updateWave(${i},'scope',this.value)" placeholder="Scope desc" /></td>
          <td style="padding:8px"><input type="date" value="${escHtml(w.goLiveDate||"")}" style="font-size:11px" onchange="APP.updateWave(${i},'goLiveDate',this.value)" /></td>
          <td style="padding:8px"><input type="number" value="${w.windowH||48}" style="width:60px;font-size:11px" onblur="APP.updateWave(${i},'windowH',+this.value)" /></td>
          <td style="padding:8px"><input type="text" value="${escHtml(w.entities||"")}" style="width:120px;font-size:11px" onblur="APP.updateWave(${i},'entities',this.value)" placeholder="e.g. US, UK" /></td>
          <td style="padding:8px"><button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.deleteWave(${i})">✕</button></td>
        </tr>`).join("")}</tbody>
      </table>`}
    </div>
  </div>` : ""}

  <!-- AI Cutover Brief -->
  ${hasTasks ? `
  <div class="card">
    <div class="card-header">
      AI Cutover Brief
      <button class="btn btn-secondary btn-sm" onclick="APP.genBrief()" id="brief-btn">Generate Brief</button>
    </div>
    <div class="card-body" id="brief-body">
      <p class="text-muted text-sm">Generate an AI-authored summary of this cutover plan for leadership communication.</p>
    </div>
  </div>` : ""}
  </div>`;
}

// ── Tab: Task Plan ────────────────────────────────────────────────────
function renderTasks() {
  const plan = gPlan();
  const tasks = plan.tasks || [];
  const finalized = !!plan.finalized;
  const flt = STATE.flt;
  const flagged = STATE.aiFlag || {};

  // Build sequence map
  const seqMap = {};
  tasks.forEach((t,i) => { seqMap[t.id] = i+1; });

  // Unique values for filter dropdowns
  const allWs     = [...new Set(tasks.map(t=>t.workstream||"").filter(Boolean))].sort();
  const allOwner  = [...new Set(tasks.map(t=>t.owner||"").filter(Boolean))].sort();
  const allEntity = [...new Set(tasks.map(t=>t.entity||"").filter(Boolean))].sort();

  // Filter tasks
  let rows = tasks.filter(t => {
    if (flt.q && !(`${t.task} ${t.owner||""} ${t.id}`).toLowerCase().includes(flt.q.toLowerCase())) return false;
    if (flt.status && t.status !== flt.status) return false;
    if (flt.phase  && t.phase  !== flt.phase)  return false;
    if (flt.ws     && t.workstream !== flt.ws)  return false;
    if (flt.owner  && t.owner !== flt.owner)    return false;
    if (flt.entity && (t.entity||"") !== flt.entity) return false;
    if (flt.type) {
      const isTech = /\b(basis|technical|development|ricefw|custom|interface|integration|transport)\b/i.test(t.workstream||"");
      if (flt.type==="technical" && !isTech) return false;
      if (flt.type==="functional" && isTech)  return false;
    }
    if (flt.cp && !t.critical) return false;
    return true;
  });

  const totalComplete = tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const pct = tasks.length ? Math.round(totalComplete/tasks.length*100) : 0;

  // Enrich result
  const er = STATE.enrichResult;
  // flaggedCount from task.assessment (persisted) + in-memory STATE.aiFlag
  const flaggedCount = tasks.filter(t => t.assessment==="remove" || !!flagged[t.id]).length;
  const assessedCount = tasks.filter(t => t.assessment && t.assessment !== "").length;
  const missingTasks = er ? (er.missing_tasks||[]) : [];
  const brainChunks = er ? (er.brain_chunks || 0) : 0;
  const brainErr = er ? (er.brain_error || "") : "";
  const hasL4 = ((gS()?.state?.l4Tasks) || []).length > 0;

  const gr = STATE.genResult;
  const genBanner = gr ? (gr.error
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:8px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center"><span style="color:#dc2626">⚠ Generation failed: ${escHtml(gr.error)}</span><button onclick="STATE.genResult=null;render()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button></div>`
    : `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center"><span style="color:#15803d">✓ Generated ${gr.count} tasks · ${gr.ricefw} RICEFW items · workstreams: ${escHtml(gr.bws)}</span><button onclick="STATE.genResult=null;render()" style="background:none;border:none;cursor:pointer;color:#15803d">✕</button></div>`)
    : "";

  return `<div class="page" style="max-width:none;padding:18px 20px">
  ${genBanner}
  <!-- Action bar -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
    <div>
      <div class="page-title" style="font-size:16px">Task Plan</div>
      <div class="text-muted text-sm">${tasks.length} tasks · ${pct}% complete ${finalized?"· <span style='color:#059669;font-weight:700'>TRACKING MODE</span>":""}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      ${!finalized ? `
      ${hasL4 ? `<button class="btn btn-sm" style="background:#7c3aed;color:#fff;border:none;" onclick="APP.generateFromL4()" id="gen-l4-btn" title="Generate complete PRE/CUT/HC plan from the full L4 (reads all workstreams)">⚡ Generate from L4</button>` : ""}
      <button class="btn btn-secondary btn-sm" onclick="APP.enrich()" id="enrich-btn" ${STATE.enrichLoading?"disabled":""}>
        ${STATE.enrichLoading ? `<span class="spinner"></span> Reviewing… <span id="enrich-timer" style="font-size:11px;opacity:.7;margin-left:4px"></span>` : "✨ Review & Enrich"}
      </button>
      <button class="btn btn-secondary btn-sm" onclick="APP.showOwnerGap()">👤 Owner Gaps</button>
      <button class="btn btn-secondary btn-sm" onclick="APP.contribute()">🧠 Contribute to Brain</button>
      <button class="btn btn-primary btn-sm" onclick="APP.finalize()">✓ Finalize Plan</button>
      ` : `
      <button class="btn btn-secondary btn-sm" onclick="APP.unfinalize()">✎ Unlock Plan</button>
      `}
      <button class="btn btn-secondary btn-sm" onclick="APP.exportXlsx()">↓ Excel</button>
    </div>
  </div>

  <!-- Progress bar -->
  <div class="progress" style="margin-bottom:12px">
    <div class="progress-fill progress-fill-purple" style="width:${pct}%"></div>
  </div>

  <!-- Enrich status -->
  ${STATE.enrichLoading ? `<div class="alert alert-info" style="margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span><span class="spinner"></span>&nbsp; AI is reviewing ${tasks.length} tasks — this can take 1–3 minutes. Elapsed: <strong id="enrich-timer-big">0s</strong></span>
    <button class="btn btn-sm btn-ghost" onclick="APP.cancelEnrich()">✕ Cancel</button>
  </div>` : ""}
  ${assessedCount>0 && !STATE.enrichLoading ? `<div class="alert alert-info" style="margin-bottom:10px;display:flex;align-items:center;gap:16px;flex-wrap:nowrap;white-space:nowrap">
    <span>✦ AI Assessment complete — <strong>${assessedCount} tasks</strong> reviewed:
      <span style="color:#059669;font-weight:700">${tasks.filter(t=>t.assessment==="keep").length} Keep</span>,
      <span style="color:#d97706;font-weight:700">${tasks.filter(t=>t.assessment==="review").length} Review</span>,
      <span style="color:#dc2626;font-weight:700">${tasks.filter(t=>t.assessment==="remove").length} Remove</span>
      ${brainChunks>0 ? `<span style="color:#6366f1;font-size:11px;margin-left:8px" title="SAP Activate methodology chunks retrieved from Knowledge Base">· 🧠 ${brainChunks} KB chunks</span>` : brainErr ? `<span style="color:#dc2626;font-size:11px;margin-left:8px" title="${escHtml(brainErr)}">· ⚠ brain error (hover)</span>` : `<span style="color:#dc2626;font-size:11px;margin-left:8px">· ⚠ 0 KB chunks</span>`}
    </span>
    ${flaggedCount>0 ? `<span style="color:#92400e">⚠ <strong>${flaggedCount} tasks</strong> marked for removal.</span>
    <button class="btn btn-sm btn-danger" onclick="APP.removeAllFlagged()">🗑 Remove All</button>` : ""}
    <button class="btn btn-sm btn-ghost" style="margin-left:auto" onclick="APP.clearAssessments()">✕ Clear Assessments</button>
  </div>` : ""}
  ${missingTasks.length>0 ? `<div class="alert alert-success" style="margin-bottom:10px;display:flex;align-items:center;gap:12px">
    ✦ AI suggests <strong>${missingTasks.length} missing tasks</strong>.
    <button class="btn btn-sm btn-primary" onclick="APP.addMissing()">＋ Add Suggested Tasks</button>
  </div>` : ""}
  ${STATE.contributeStatus ? `<div class="alert ${STATE.contributeStatus.ok?"alert-success":"alert-danger"}" style="margin-bottom:10px">${STATE.contributeStatus.ok?"✓ Contributed "+STATE.contributeStatus.chunks+" chunks to brain.":STATE.contributeStatus.error}</div>` : ""}

  <!-- Filters -->
  <div class="filter-bar">
    <input type="text" class="filter-search" placeholder="🔍 Search tasks, owner, ID…"
      value="${escHtml(flt.q)}" oninput="APP.setFlt('q',this.value)" style="width:220px" />
    <select class="filter-select ${flt.status?"flt-active":""}" onchange="APP.setFlt('status',this.value)">
      <option value="">All Status</option>
      ${Object.entries(STATUS_CFG).map(([k,v])=>`<option value="${k}" ${flt.status===k?"selected":""}>${v.label}</option>`).join("")}
    </select>
    <select class="filter-select ${flt.phase?"flt-active":""}" onchange="APP.setFlt('phase',this.value)">
      <option value="">All Phases</option>
      ${Object.keys(PC).map(ph=>`<option value="${ph}" ${flt.phase===ph?"selected":""}>${ph}</option>`).join("")}
    </select>
    <select class="filter-select ${flt.ws?"flt-active":""}" onchange="APP.setFlt('ws',this.value)">
      <option value="">All Workstreams</option>
      ${allWs.map(ws=>`<option value="${ws}" ${flt.ws===ws?"selected":""}>${escHtml(ws)}</option>`).join("")}
    </select>
    <select class="filter-select ${flt.type?"flt-active":""}" onchange="APP.setFlt('type',this.value)">
      <option value="">All Types</option>
      <option value="functional" ${flt.type==="functional"?"selected":""}>Functional</option>
      <option value="technical"  ${flt.type==="technical"?"selected":""}>Technical</option>
    </select>
    <select class="filter-select ${flt.owner?"flt-active":""}" onchange="APP.setFlt('owner',this.value)">
      <option value="">All Owners</option>
      ${allOwner.map(o=>`<option value="${o}" ${flt.owner===o?"selected":""}>${escHtml(o)}</option>`).join("")}
    </select>
    ${allEntity.length>0 ? `<select class="filter-select ${flt.entity?"flt-active":""}" onchange="APP.setFlt('entity',this.value)">
      <option value="">All Entities</option>
      ${allEntity.map(e=>`<option value="${e}" ${flt.entity===e?"selected":""}>${escHtml(e)}</option>`).join("")}
    </select>` : ""}
    <button class="btn btn-sm ${flt.cp?"btn-primary":"btn-ghost"}" onclick="APP.setFlt('cp',${!flt.cp})">★ Critical Only</button>
    ${(flt.q||flt.status||flt.phase||flt.ws||flt.type||flt.owner||flt.entity||flt.cp) ? `<button class="btn btn-xs btn-ghost" onclick="APP.clearFlt()">✕ Clear</button>` : ""}
    <span class="text-muted text-xs" style="margin-left:auto">${rows.length}${rows.length!==tasks.length?` of ${tasks.length}`:""} tasks</span>
  </div>

  <!-- Table -->
  ${tasks.length===0 ? `<div class="card"><div class="card-body" style="text-align:center;padding:40px">
    <div style="font-size:32px;margin-bottom:12px">📋</div>
    <div style="font-size:15px;font-weight:600;margin-bottom:8px">No tasks yet</div>
    <p class="text-muted">Upload an L4 plan or generate from the SAP library on the Plan Builder tab.</p>
    <button class="btn btn-primary" style="margin-top:14px" onclick="APP.nav('input')">Go to Plan Builder</button>
  </div></div>` : `
  <div class="scroll-x" style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 310px);background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)">
  <table style="min-width:1900px;border-collapse:collapse;font-size:13px">
    <thead><tr>
      ${!finalized ? `<th style="width:32px"><input type="checkbox" id="chk-all" onchange="APP.selectAll(this.checked)" /></th>` : ""}
      <th style="width:30px;text-align:center;padding:9px 4px">#</th>
      <th style="width:110px">ID</th>
      <th style="width:300px">Task</th>
      <th style="width:60px">Phase</th>
      <th style="width:160px">Workstream</th>
      <th style="width:180px">Owner</th>
      <th style="width:72px">Duration</th>
      <th style="width:115px">Scheduled</th>
      <th style="width:115px">Actual Start</th>
      <th style="width:115px">Actual End</th>
      <th style="width:95px">Variance</th>
      <th style="width:130px">Depends On</th>
      <th style="width:95px">Status</th>
      <th style="width:85px">Priority</th>
      ${!finalized ? `<th style="width:180px">AI Assessment</th>` : ""}
      <th style="width:90px"></th>
    </tr></thead>
    <tbody>
    ${rows.map(t => buildTaskRow(t, seqMap[t.id], finalized, flagged, allWs)).join("")}
    </tbody>
  </table>
  </div>`}

  ${!finalized && STATE.selected && Object.keys(STATE.selected).length>0 ? `
  <div style="position:sticky;bottom:0;background:#fff;border-top:1px solid #e5e7eb;padding:10px 0;display:flex;gap:8px;align-items:center">
    <span class="text-sm text-muted">${Object.keys(STATE.selected).length} selected</span>
    <button class="btn btn-sm btn-danger" onclick="APP.deleteSelected()">🗑 Delete Selected</button>
    <button class="btn btn-sm btn-ghost" onclick="APP.clearSelection()">Deselect All</button>
  </div>` : ""}
  </div>`;
}

function buildTaskRow(t, seq, finalized, flagged, allWs) {
  const isFlagged = !!flagged[t.id];
  const flagReason = flagged[t.id] || "";
  const sc = STATUS_CFG[t.status] || STATUS_CFG.PENDING;
  const borderCol = t.status==="BLOCKED" ? "#b91c1c"
    : isFlagged ? "#f59e0b"
    : t.status==="IN_PROGRESS" ? "#8800d9"
    : (t.status==="COMPLETE"||t.status==="VERIFIED") ? "#059669"
    : t.critical ? "#d97706" : "#e2e8f0";
  const bg = STATE.selected[t.id] ? "rgba(161,0,255,.08)"
    : isFlagged ? "rgba(251,191,36,.06)"
    : t.status==="BLOCKED" ? "rgba(196,43,28,.03)"
    : (t.status==="COMPLETE"||t.status==="VERIFIED") ? "rgba(14,122,11,.03)"
    : "#ffffff";
  const pr = t.priority || "MEDIUM";
  const prCol = pr==="HIGH"?"#b91c1c":pr==="MEDIUM"?"#92400e":"#64748b";

  return `<tr class="task-row" id="row-${t.id}" style="background:${bg};border-left:3px solid ${borderCol}">
    ${!finalized ? `<td style="padding:8px 4px;text-align:center;border-bottom:1px solid #f0f0f4">
      <input type="checkbox" ${STATE.selected[t.id]?"checked":""} onchange="APP.selTask('${t.id}',this.checked)" />
    </td>` : ""}
    <td style="padding:8px 4px;text-align:center;border-bottom:1px solid #f0f0f4;color:#64748b;font-size:11px">${seq||"—"}</td>
    <td style="border-bottom:1px solid #f0f0f4;color:#A100FF;font-family:monospace;font-size:10px;font-weight:700;min-width:100px;word-break:break-all" title="${t.id}">${t.id}</td>
    <td style="border-bottom:1px solid #f0f0f4;min-width:280px">
      ${isFlagged ? `<span class="ai-flag" title="${escHtml(flagReason)}">⚠ AI</span>` : ""}
      ${t.critical ? `<span style="color:#d97706;margin-right:4px" title="Critical path">★</span>` : ""}
      ${finalized
        ? `<span style="white-space:pre-wrap;word-break:break-word">${escHtml(t.task)}</span>`
        : `<textarea class="cell-inp" rows="2" style="width:100%;font-size:12px;resize:vertical;min-height:42px" onblur="APP.saveTask('${t.id}','task',this.value)">${escHtml(t.task)}</textarea>`}
      ${t.notes ? `<div class="text-xs text-muted" style="margin-top:2px;white-space:pre-wrap;word-break:break-word">${escHtml(t.notes)}</div>` : ""}
      ${isFlagged ? `<div class="text-xs" style="color:#b45309;margin-top:2px;font-style:italic">⚠ ${escHtml(flagReason)}</div>` : ""}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap">
      ${finalized ? phaseChip(t.phase) : `<select class="cell-inp" style="width:70px" onchange="APP.saveTask('${t.id}','phase',this.value)">
        ${["PRE","CUT","HC","POST","RAMP"].map(ph=>`<option value="${ph}" ${t.phase===ph?"selected":""}>${ph}</option>`).join("")}
      </select>`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap;font-size:12px">
      ${finalized ? workstreamBadge(t.workstream)
        : `<select class="cell-inp" style="width:150px" onchange="APP.saveTask('${t.id}','workstream',this.value)">
          ${(allWs||[]).map(ws=>`<option value="${ws}" ${t.workstream===ws?"selected":""}>${escHtml(ws)}</option>`).join("")}
          ${!(allWs||[]).includes(t.workstream||"") ? `<option value="${t.workstream||""}" selected>${escHtml(t.workstream||"—")}</option>` : ""}
        </select>`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4">
      ${finalized ? `<span class="text-sm">${escHtml(t.owner||"—")}</span>`
        : `<input type="text" class="cell-inp" value="${escHtml(t.owner||"")}" placeholder="Owner" style="width:168px" onblur="APP.saveTask('${t.id}','owner',this.value)" />`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;text-align:center;font-size:12px">
      ${finalized ? `${t.durationH||"—"}h`
        : `<input type="number" class="cell-inp" value="${t.durationH||""}" min="0" style="width:52px;text-align:center" onblur="APP.saveTask('${t.id}','durationH',+this.value)" />`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap;font-size:11px;color:#64748b;font-family:monospace">
      ${t.scheduledStart ? escHtml(String(t.scheduledStart).replace("T"," ").slice(0,16)) : "—"}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap;font-size:11px">
      ${t.actualStart
        ? `<span style="font-family:monospace;color:#111;cursor:pointer" title="Click to clear" onclick="APP.markStart('${t.id}',null)">${escHtml(String(t.actualStart).replace("T"," ").slice(0,16))}</span>`
        : `<span onclick="APP.markStart('${t.id}')" title="Mark started now" style="color:#64748b;cursor:pointer;border:1px solid #e2e8f0;border-radius:4px;padding:1px 7px;font-size:10px">&#9654; now</span>`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap;font-size:11px">
      ${t.actualEnd
        ? `<span style="font-family:monospace;color:#111;cursor:pointer" title="Click to clear" onclick="APP.markEnd('${t.id}',null)">${escHtml(String(t.actualEnd).replace("T"," ").slice(0,16))}</span>`
        : `<span onclick="APP.markEnd('${t.id}')" title="Mark complete now" style="color:#64748b;cursor:pointer;border:1px solid #e2e8f0;border-radius:4px;padding:1px 7px;font-size:10px">&#9632; now</span>`}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap;font-size:11px">
      ${(()=>{
        if(typeof taskVariance!=="function") return "—";
        const v=taskVariance(t);
        if(v.status==="planned") return '<span style="color:#64748b">—</span>';
        const map={late:`<span style="color:#b91c1c;font-weight:600">${v.delayH>0?"+"+v.delayH+"h late":"late"}</span>`,late_start:`<span style="color:#d97706;font-weight:600">+${v.startDeltaH}h late start</span>`,early:`<span style="color:#059669;font-weight:600">${v.endDeltaH}h early</span>`,on_time:`<span style="color:#059669;font-weight:600">on time</span>`,in_progress:`<span style="color:#8800d9;font-weight:600">in progress</span>`};
        return map[v.status]||`<span style="color:#64748b">${v.status}</span>`;
      })()}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;font-size:10px;color:#64748b;font-family:monospace;min-width:100px;word-break:break-word">
      ${(t.predecessors&&t.predecessors.length)?escHtml(t.predecessors.join(", ")):"—"}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap">
      ${statusChip(t.status, t.id)}
    </td>
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap">
      ${finalized ? priorityDisplay(pr)
        : `<select class="cell-inp" style="width:90px;color:${prCol};font-weight:700" onchange="APP.saveTask('${t.id}','priority',this.value)">
          ${["HIGH","MEDIUM","LOW"].map(p=>`<option value="${p}" ${pr===p?"selected":""}>${p}</option>`).join("")}
        </select>`}
    </td>
    ${!finalized ? `<td style="border-bottom:1px solid #f0f0f4;font-size:11px;min-width:120px">
      ${(()=>{
        const a = t.assessment;
        const reason = t.assessmentReason || flagReason || "";
        const cycleHint = ` title="Click to change verdict"`;
        const cycleStyle = "cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;";
        if (a==="remove" || (isFlagged && !a)) return `<div style="display:flex;align-items:center;gap:3px"><span${cycleHint} style="color:#dc2626;font-weight:700;${cycleStyle}" onclick="APP.cycleAssessment('${t.id}')">✕ Remove</span></div>${reason ? `<div style="color:#b45309;font-size:10px;font-style:italic;margin-top:2px;white-space:normal;word-break:break-word;max-width:180px">${escHtml(reason)}</div>` : ""}`;
        if (a==="review") return `<div style="display:flex;align-items:center;gap:3px"><span${cycleHint} style="color:#d97706;font-weight:700;${cycleStyle}" onclick="APP.cycleAssessment('${t.id}')">⚠ Review</span></div>${reason ? `<div style="color:#92400e;font-size:10px;font-style:italic;margin-top:2px;white-space:normal;word-break:break-word;max-width:180px">${escHtml(reason)}</div>` : ""}`;
        if (a==="keep")   return `<div style="display:flex;align-items:center;gap:3px"><span${cycleHint} style="color:#059669;font-weight:700;${cycleStyle}" onclick="APP.cycleAssessment('${t.id}')">✓ Keep</span></div>`;
        return `<span style="color:#94a3b8">—</span>`;
      })()}
    </td>` : ""}
    <td style="border-bottom:1px solid #f0f0f4;white-space:nowrap">
      <button class="btn btn-xs btn-ghost" onclick="APP.openEmail('${t.id}')" title="Email owner" style="font-size:13px">✉</button>
      <button class="btn btn-xs btn-ghost" onclick="APP.openLink('${t.id}')" title="${t.externalRef&&t.externalRef.url?'Linked':'Attach link/approval'}" style="font-size:13px;color:${t.externalRef&&t.externalRef.url?"#059669":"#64748b"}">⧉</button>
      ${t.status==="BLOCKED" ? `<button class="btn btn-xs btn-danger" onclick="APP.fixTask('${t.id}')" title="AI Fix">💡</button>` : ""}
      ${!finalized ? `<button class="btn btn-xs btn-ghost" onclick="APP.deleteTask('${t.id}')" title="Delete" style="color:#dc2626">✕</button>` : ""}
    </td>
  </tr>`;
}

// ── Tab: Agents ───────────────────────────────────────────────────────
function renderAgents() {
  const session = gS();
  const tasks = session ? (session.state.plan.tasks||[]) : [];
  const p = gP();

  const cards = AGENTS_DEF.map((ag,i) => {
    const isRunning = STATE.agentRunning === ag.key;
    const out = (session && session.agents && session.agents[ag.key]) ? session.agents[ag.key].output : null;
    const isOpen = !!STATE.agentExpanded[ag.key];
    return `<div class="agent-card">
      <div class="agent-card-hd" onclick="APP.toggleAgent('${ag.key}')">
        <div class="agent-card-hd-left">
          <div class="agent-num">${i+1}</div>
          <div>
            <div class="agent-card-name">${escHtml(ag.label)}</div>
            <div class="agent-card-desc">${escHtml(ag.desc)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          ${out ? `<span class="badge badge-green">Done</span>` : ""}
          <button class="btn btn-sm ${out?"btn-secondary":"btn-primary"}" onclick="event.stopPropagation();APP.runAgent('${ag.key}')" ${isRunning?"disabled":""}>
            ${isRunning ? `<span class="spinner"></span> Running…` : (out?"Re-run":"Run")}
          </button>
          <span style="color:#94a3b8">${isOpen?"▲":"▼"}</span>
        </div>
      </div>
      ${(isOpen || isRunning || out) ? `<div class="agent-card-body ${isOpen||isRunning||out?"open":""}">
        ${isRunning ? `<div class="loader"><span class="spinner"></span> Running ${escHtml(ag.label)}…</div>` :
          out ? `<div>${renderMarkdown(out)}</div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn btn-xs btn-secondary" onclick="APP.copyAgent('${ag.key}')">📋 Copy</button>
          </div>`
          : `<p class="text-muted text-sm">Click Run to generate this insight.</p>`}
      </div>` : ""}
    </div>`;
  }).join("");

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">AI Insights</div>
    <div class="page-sub">Run AI agents against your cutover plan for readiness assessment and risk analysis</div>
  </div>
  ${!session || tasks.length===0 ? `<div class="alert alert-warning">Import or generate a task plan first to run AI agents.</div>` : ""}
  ${cards}

  <!-- What-If Simulation -->
  <div class="card" style="margin-top:20px">
    <div class="card-header">What-If Simulation</div>
    <div class="card-body">
      <p class="text-muted text-sm" style="margin-bottom:12px">Describe a scenario — e.g. "What if a key resource is unavailable on cutover day?"</p>
      <textarea id="whatif-inp" rows="3" placeholder="Describe your scenario…" style="margin-bottom:10px">${escHtml(STATE.whatIfQ)}</textarea>
      <button class="btn btn-primary" onclick="APP.runWhatIf()" ${STATE.whatIfLoading?"disabled":""}>
        ${STATE.whatIfLoading ? `<span class="spinner"></span> Simulating…` : "Run Simulation"}
      </button>
      ${STATE.whatIfText ? `<div style="margin-top:16px">${renderMarkdown(STATE.whatIfText)}</div>` : ""}
    </div>
  </div>
  </div>`;
}

// ── Tab: Knowledge Base ───────────────────────────────────────────────
function renderBrain() {
  const msgs = STATE.kbMessages || [];
  const online = STATE.brainOnline;

  const uploadSection = STATE.kbUploadBusy ? `
    <div class="loader"><span class="spinner"></span> Processing files…</div>` :
    STATE.kbUploadResult ? `<div class="alert alert-success">
      ✓ Indexed ${STATE.kbUploadResult.chunks} chunks.
      <button class="btn btn-xs btn-secondary" style="margin-left:10px" onclick="APP.kbReset()">Upload More</button>
    </div>` : `
    <div class="upload-zone" onclick="document.getElementById('kb-file-inp').click()" id="kb-zone">
      <div style="font-size:22px;margin-bottom:8px">📂</div>
      <div style="font-weight:600">Click to upload files</div>
      <div class="text-muted text-sm">PDF, Excel, PowerPoint — SAP cutover plans, methodology docs</div>
      <input type="file" id="kb-file-inp" multiple accept=".pdf,.xlsx,.xls,.pptx,.ppt" style="display:none" onchange="APP.kbFilePick(this.files)" />
    </div>
    ${(STATE.kbPendingFiles||[]).length>0 ? `
    <div style="margin-top:12px">
      <div class="text-sm" style="margin-bottom:8px"><strong>${STATE.kbPendingFiles.length} file(s) selected</strong></div>
      <div style="margin-bottom:10px">
        <label class="form-label">Industry (optional)</label>
        <select class="filter-select" onchange="STATE.kbIndustry=this.value" style="min-width:180px">
          ${INDUSTRIES_LIST.map(i=>`<option value="${i.k}" ${STATE.kbIndustry===i.k?"selected":""}>${i.label}</option>`).join("")}
        </select>
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label">Client name(s) to remove</label>
        <input class="form-input" style="min-width:280px" placeholder="e.g. Acme Corp, Acme"
               value="${escHtml(STATE.kbClientNames||"")}"
               oninput="STATE.kbClientNames=this.value">
        <div class="text-sm" style="color:#64748b;margin-top:4px">
          Comma-separated. These are replaced with [client] everywhere in the file.
          Staff names, emails and owner columns are removed automatically.
        </div>
      </div>
      <button class="btn btn-primary" onclick="APP.kbUpload()">Upload & Process</button>
    </div>` : ""}`;

  const chatMsgs = msgs.map(m => {
    if (m.role==="user") return `<div class="chat-bubble-user">${escHtml(m.text)}</div>`;
    return `<div class="chat-bubble-ai">
      ${renderMarkdown(m.text)}
      ${m.sources && m.sources.length ? `<div class="sources-row">${m.sources.map(s=>`<span class="source-chip">${escHtml(s.heading||s.source||"Source")}</span>`).join("")}</div>` : ""}
    </div>`;
  }).join("");

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Knowledge Base</div>
    <div class="page-sub">Upload reference documents and ask questions about SAP cutover methodology</div>
  </div>

  ${online===false ? `<div class="alert alert-danger">Brain server offline — start the server to use the Knowledge Base.</div>` : ""}

  <div class="form-row form-row-2">
    <div>
      <div class="section-div">Upload Documents</div>
      ${uploadSection}
    </div>
    <div>
      <div class="section-div">Ask the Knowledge Base</div>
      <div class="chat-wrap">
        <div class="chat-messages" id="kb-chat">
          ${msgs.length===0 ? `<p class="text-muted text-sm" style="text-align:center;margin-top:40px">Ask anything about SAP cutover methodology, task sequences, or your uploaded plans.</p>` : chatMsgs}
        </div>
        <div class="chat-bar">
          <input type="text" id="kb-inp" placeholder="Ask a question…"
            value="${escHtml(STATE.kbInput)}"
            onkeydown="if(event.key==='Enter')APP.kbSend()"
            oninput="STATE.kbInput=this.value" />
          <button class="btn btn-primary" onclick="APP.kbSend()" ${STATE.kbLoading?"disabled":""}>
            ${STATE.kbLoading ? `<span class="spinner"></span>` : "Ask"}
          </button>
        </div>
      </div>
    </div>
  </div>
  </div>`;
}

// ── Tab: Dashboard ────────────────────────────────────────────────────
function renderDashboard() {
  const s = gS();
  const tasks = s ? (s.state.plan.tasks||[]) : [];
  const p = gP();

  if (!s || tasks.length===0) {
    return `<div class="page"><div class="page-header"><div class="page-title">Dashboard</div></div>
      <div class="alert alert-info">Import or generate a task plan to see dashboard metrics.</div>
    </div>`;
  }

  // ── Core metrics ──────────────────────────────────────────────────────
  const total    = tasks.length;
  const complete = tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const blocked  = tasks.filter(t=>t.status==="BLOCKED").length;
  const inProg   = tasks.filter(t=>t.status==="IN_PROGRESS").length;
  const pending  = tasks.filter(t=>!t.status||t.status==="PENDING").length;
  const pct      = total ? Math.round(complete/total*100) : 0;
  const highPri  = tasks.filter(t=>t.priority==="HIGH").length;
  const medPri   = tasks.filter(t=>t.priority==="MEDIUM"||!t.priority).length;
  const totalH   = tasks.reduce((a,t)=>a+(t.durationH||0),0);
  const windowH  = p.cutoverDurationH||48;
  const ratio    = windowH ? totalH/windowH : 0;
  const overrun  = ratio > 1;
  const pctFeas  = Math.min(Math.round(ratio*100),999);
  const feasColor= ratio<=1?"#059669":ratio<=1.3?"#d97706":"#dc2626";

  const byPhase = {};
  tasks.forEach(t=>{
    const ph=t.phase||"?";
    if(!byPhase[ph]) byPhase[ph]={total:0,complete:0,blocked:0};
    byPhase[ph].total++;
    if(t.status==="COMPLETE"||t.status==="VERIFIED") byPhase[ph].complete++;
    if(t.status==="BLOCKED") byPhase[ph].blocked++;
  });

  const byWs = {};
  tasks.forEach(t=>{
    const ws=t.workstream||"General";
    if(!byWs[ws]) byWs[ws]={total:0,complete:0,blocked:0};
    byWs[ws].total++;
    if(t.status==="COMPLETE"||t.status==="VERIFIED") byWs[ws].complete++;
    if(t.status==="BLOCKED") byWs[ws].blocked++;
  });

  // ── Phase config ─────────────────────────────────────────────────────
  const PCONF = {
    PRE:  {bg:"#dbeafe",fg:"#1e40af",bar:"#3b82f6",wave:"W0"},
    CUT:  {bg:"#fef3c7",fg:"#92400e",bar:"#f59e0b",wave:"W1"},
    HC:   {bg:"#e0f2fe",fg:"#075985",bar:"#0ea5e9",wave:"W2"},
    POST: {bg:"#dcfce7",fg:"#166534",bar:"#22c55e",wave:"W3"},
  };

  // ── RICEFW tracker ────────────────────────────────────────────────────
  const _tRE = /^transport\s+.+\s+to\s+prod(?:uction)?$/i;
  const _sRE = /^smoke\s+test\s*[—\-–]\s*.+\s+in\s+prod(?:uction)?$/i;
  const tTasks = tasks.filter(t=>_tRE.test(t.task||""));
  const sTasks = tasks.filter(t=>_sRE.test(t.task||""));
  const tDone  = tTasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const sDone  = sTasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const tPct   = tTasks.length ? Math.round(tDone/tTasks.length*100) : 0;
  const sPct   = sTasks.length ? Math.round(sDone/sTasks.length*100) : 0;
  const hasRicefw = tTasks.length>0 || sTasks.length>0;

  // ── Attention items ────────────────────────────────────────────────────
  const blockedAll  = tasks.filter(t=>t.status==="BLOCKED");
  const unownedHigh = tasks.filter(t=>t.priority==="HIGH"&&t.phase==="CUT"&&(!t.owner||!t.owner.trim()));
  const reviewAll   = tasks.filter(t=>(t.assessment||"").toLowerCase()==="review");
  const hasAttention = blockedAll.length>0 || unownedHigh.length>0 || reviewAll.length>0;

  // ── Readiness score (0–100) → A/B/C/D/F ──────────────────────────────
  const doneScore   = Math.round(pct/100*40);
  const blockScore  = blocked===0?25:Math.max(0,25-blocked*8);
  const windowScore = ratio<=1?20:ratio<=1.5?10:ratio<=2?5:0;
  const ownerScore  = unownedHigh.length===0?15:Math.max(0,15-unownedHigh.length*3);
  const readiness   = doneScore+blockScore+windowScore+ownerScore;
  const grade       = readiness>=85?"A":readiness>=70?"B":readiness>=55?"C":readiness>=40?"D":"F";
  const gradeColor  = {A:"#4ade80",B:"#86efac",C:"#fbbf24",D:"#fb923c",F:"#f87171"}[grade];
  const gradeLabel  = {A:"Go-Live Ready",B:"Mostly Ready",C:"Needs Attention",D:"Significant Gaps",F:"Not Ready"}[grade];

  // ── SVG helpers ───────────────────────────────────────────────────────
  const circ = 2*Math.PI*38;
  const dash = `${pct/100*circ} ${circ}`;
  const ringC = pct>=70?"#4ade80":pct>=40?"#fbbf24":"#c084fc";
  const donut = `<svg viewBox="0 0 100 100" width="82" height="82" style="display:block">
    <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="8"/>
    <circle cx="50" cy="50" r="38" fill="none" stroke="${ringC}" stroke-width="8"
      stroke-dasharray="${dash}" stroke-linecap="round" transform="rotate(-90 50 50)"/>
    <text x="50" y="46" text-anchor="middle" fill="white" font-size="17" font-weight="800">${pct}%</text>
    <text x="50" y="58" text-anchor="middle" fill="rgba(255,255,255,.45)" font-size="8">complete</text>
  </svg>`;

  function miniRing(p2, color) {
    const c2=2*Math.PI*24, d2=`${p2/100*c2} ${c2}`;
    return `<svg viewBox="0 0 66 66" width="58" height="58" style="display:block;flex-shrink:0">
      <circle cx="33" cy="33" r="24" fill="none" stroke="#f1f5f9" stroke-width="7"/>
      <circle cx="33" cy="33" r="24" fill="none" stroke="${color}" stroke-width="7"
        stroke-dasharray="${d2}" stroke-linecap="round" transform="rotate(-90 33 33)"/>
      <text x="33" y="37" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="800">${p2}%</text>
    </svg>`;
  }

  // ── Alert banner ──────────────────────────────────────────────────────
  const alertBanner = (overrun||blocked>0) ? `
    <div style="background:${blocked?"#dc2626":"#b45309"};color:white;padding:10px 28px;display:flex;align-items:center;gap:10px;font-size:12px;font-weight:500;flex-shrink:0">
      <span style="font-size:15px">${blocked?"🚨":"⚠️"}</span>
      <span>${blocked?`${blocked} task${blocked>1?"s":""} BLOCKED — immediate action required. `:""}${overrun?`Cutover window overrun — ${totalH}h of tasks vs ${windowH}h window. Parallelise workstreams to reduce critical path.`:""}</span>
    </div>` : "";

  // ── Attention Required panel ──────────────────────────────────────────
  function attRow(task, tag, tagColor) {
    return `<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.07)">
      <span style="font-size:9px;font-weight:700;padding:2px 5px;border-radius:4px;background:${tagColor};color:white;flex-shrink:0;margin-top:1px;white-space:nowrap">${tag}</span>
      <div>
        <div style="color:white;font-size:11px;font-weight:600;line-height:1.35">${escHtml((task.task||"").slice(0,52))}${(task.task||"").length>52?"…":""}</div>
        <div style="color:rgba(255,255,255,.4);font-size:10px;margin-top:2px">${escHtml(task.workstream||"")}${task.owner?" · "+escHtml(task.owner):""}</div>
      </div>
    </div>`;
  }
  const attCols = [blockedAll.length>0,unownedHigh.length>0,reviewAll.length>0].filter(Boolean).length;
  const attPanel = hasAttention ? `
    <div style="background:linear-gradient(135deg,#5c0011 0%,#7f1d1d 100%);border-radius:12px;padding:18px 22px">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:rgba(255,255,255,.55);margin-bottom:14px">⚡ Attention Required</div>
      <div style="display:grid;grid-template-columns:repeat(${Math.max(attCols,1)},1fr);gap:20px">
        ${blockedAll.length?`<div>
          <div style="font-size:10px;font-weight:700;color:#f87171;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">🚨 Blocked (${blockedAll.length})</div>
          ${blockedAll.slice(0,5).map(t=>attRow(t,"BLOCKED","#991b1b")).join("")}
          ${blockedAll.length>5?`<div style="color:rgba(255,255,255,.35);font-size:10px;padding-top:5px">+${blockedAll.length-5} more</div>`:""}
        </div>`:""}
        ${unownedHigh.length?`<div>
          <div style="font-size:10px;font-weight:700;color:#fbbf24;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">⚠ Unowned HIGH·CUT (${unownedHigh.length})</div>
          ${unownedHigh.slice(0,5).map(t=>attRow(t,"NO OWNER","#92400e")).join("")}
          ${unownedHigh.length>5?`<div style="color:rgba(255,255,255,.35);font-size:10px;padding-top:5px">+${unownedHigh.length-5} more</div>`:""}
        </div>`:""}
        ${reviewAll.length?`<div>
          <div style="font-size:10px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px">👁 Needs Review (${reviewAll.length})</div>
          ${reviewAll.slice(0,5).map(t=>attRow(t,"REVIEW","#1e40af")).join("")}
          ${reviewAll.length>5?`<div style="color:rgba(255,255,255,.35);font-size:10px;padding-top:5px">+${reviewAll.length-5} more</div>`:""}
        </div>`:""}
      </div>
    </div>` : "";

  // ── Phase cards ───────────────────────────────────────────────────────
  const phaseCards = ["PRE","CUT","HC","POST"].filter(ph=>byPhase[ph]).map(ph=>{
    const v=byPhase[ph], c=PCONF[ph]||{bg:"#f1f5f9",fg:"#64748b",bar:"#94a3b8",wave:"—"};
    const p2=v.total?Math.round(v.complete/v.total*100):0;
    return `<div style="background:${c.bg};border-radius:12px;padding:18px 20px;flex:1 1 100px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:11px;font-weight:800;color:${c.fg};text-transform:uppercase;letter-spacing:.08em">${ph}</span>
        <span style="background:white;color:${c.fg};font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;opacity:.85">${c.wave}</span>
      </div>
      <div style="font-size:34px;font-weight:900;color:${c.fg};line-height:1">${v.total}</div>
      <div style="font-size:11px;color:${c.fg};opacity:.65;margin:4px 0 12px">tasks · ${p2}% done</div>
      <div style="background:rgba(255,255,255,.55);border-radius:6px;height:5px;overflow:hidden">
        <div style="height:100%;width:${p2}%;background:${c.bar};border-radius:6px"></div>
      </div>
    </div>`;
  }).join("");

  // ── Risk heatmap rows ─────────────────────────────────────────────────
  const hmRows = ["PRE","CUT","HC","POST"].filter(ph=>byPhase[ph]).map(ph=>{
    const pt=tasks.filter(t=>t.phase===ph);
    const lo=pt.filter(t=>t.priority==="LOW").length;
    const me=pt.filter(t=>t.priority==="MEDIUM"||!t.priority).length;
    const hi=pt.filter(t=>t.priority==="HIGH").length;
    const c=(PCONF[ph]||{fg:"#64748b"});
    const badge=(n,bg,fg)=>n?`<span style="background:${bg};color:${fg};padding:3px 10px;border-radius:6px;font-weight:700;font-size:12px;display:inline-block;min-width:32px;text-align:center">${n}</span>`:`<span style="color:#cbd5e1;font-size:12px">—</span>`;
    return `<tr>
      <td style="padding:9px 12px;font-weight:700;color:${c.fg};font-size:12px">${ph}</td>
      <td style="padding:6px 8px;text-align:center">${badge(lo,"#dcfce7","#166534")}</td>
      <td style="padding:6px 8px;text-align:center">${badge(me,"#fef3c7","#92400e")}</td>
      <td style="padding:6px 8px;text-align:center">${badge(hi,"#fee2e2","#991b1b")}</td>
    </tr>`;
  }).join("");

  // ── RICEFW tracker card ───────────────────────────────────────────────
  const tColor = tPct===100?"#059669":tPct>=50?"#f59e0b":"#A100FF";
  const sColor = sPct===100?"#059669":sPct>=50?"#f59e0b":"#0ea5e9";
  const ricefwCard = hasRicefw ? `
    <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
      <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:16px">RICEFW Tracker</div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        ${miniRing(tPct,tColor)}
        <div style="flex:1">
          <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px">Transports to Prod</div>
          <div style="font-size:22px;font-weight:900;color:#0f172a;line-height:1">${tDone}<span style="font-size:13px;font-weight:500;color:#94a3b8"> / ${tTasks.length}</span></div>
          <div style="background:#f1f5f9;border-radius:4px;height:5px;margin-top:8px;overflow:hidden">
            <div style="height:100%;width:${tPct}%;background:${tColor};border-radius:4px"></div>
          </div>
        </div>
      </div>
      <div style="border-top:1px solid #f8fafc;padding-top:14px;display:flex;align-items:center;gap:14px">
        ${miniRing(sPct,sColor)}
        <div style="flex:1">
          <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:4px">Smoke Tests in Prod</div>
          <div style="font-size:22px;font-weight:900;color:#0f172a;line-height:1">${sDone}<span style="font-size:13px;font-weight:500;color:#94a3b8"> / ${sTasks.length}</span></div>
          <div style="background:#f1f5f9;border-radius:4px;height:5px;margin-top:8px;overflow:hidden">
            <div style="height:100%;width:${sPct}%;background:${sColor};border-radius:4px"></div>
          </div>
        </div>
      </div>
    </div>` : "";

  // ── Workstream cards ──────────────────────────────────────────────────
  const wsCards = Object.entries(byWs).sort((a,b)=>b[1].blocked-a[1].blocked||b[1].total-a[1].total).map(([ws,v])=>{
    const p2=v.total?Math.round(v.complete/v.total*100):0;
    const accent=v.blocked?"#dc2626":p2>=70?"#059669":p2>=40?"#f59e0b":"#A100FF";
    return `<div style="background:white;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.07);border-left:4px solid ${accent};display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="font-size:12px;font-weight:700;color:#0f172a;line-height:1.35">${escHtml(ws)}</div>
        ${v.blocked?`<span style="background:#fee2e2;color:#dc2626;font-size:10px;font-weight:700;padding:2px 6px;border-radius:8px;white-space:nowrap;flex-shrink:0">${v.blocked} blocked</span>`:""}
      </div>
      <div style="font-size:30px;font-weight:900;color:${accent};line-height:1">${v.total}</div>
      <div>
        <div style="background:#f1f5f9;border-radius:5px;height:5px;overflow:hidden">
          <div style="height:100%;width:${p2}%;background:${accent};border-radius:5px;transition:width .3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10px;color:#94a3b8">
          <span>${v.complete} of ${v.total} done</span><span>${p2}%</span>
        </div>
      </div>
    </div>`;
  }).join("");

  // ── Priority bar ──────────────────────────────────────────────────────
  const hiPct = total?Math.round(highPri/total*100):0;
  const mePct = total?Math.round(medPri/total*100):0;

  // ── Assemble ──────────────────────────────────────────────────────────
  return `<div style="height:100%;display:flex;flex-direction:column;overflow:hidden;background:#f4f3f8">
  ${alertBanner}
  <div style="flex:1;overflow-y:auto">

    <!-- Dark hero -->
    <div style="background:linear-gradient(135deg,#14082e 0%,#2a1050 55%,#1a0838 100%);padding:24px 28px 28px;flex-shrink:0">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:22px">
        <div>
          <div style="color:rgba(255,255,255,.4);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">SAP Cutover Plan</div>
          <div style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-.01em">${escHtml(p.projectName||"Cutover Project")}</div>
          <div style="color:rgba(255,255,255,.38);font-size:11px;margin-top:5px">${escHtml((p.modules||[]).join(", ")||"SAP S/4HANA")} · ${escHtml(p.approach||"Big Bang")}</div>
        </div>
        <!-- Progress donut + Readiness grade -->
        <div style="display:flex;align-items:center;gap:16px">
          <div style="text-align:center">
            ${donut}
            <div style="color:rgba(255,255,255,.3);font-size:10px;margin-top:3px">progress</div>
          </div>
          <div style="background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px 18px;text-align:center">
            <div style="font-size:46px;font-weight:900;color:${gradeColor};line-height:1">${grade}</div>
            <div style="color:${gradeColor};font-size:10px;font-weight:700;margin-top:5px">${gradeLabel}</div>
            <div style="color:rgba(255,255,255,.28);font-size:9px;margin-top:3px">${readiness} / 100</div>
          </div>
        </div>
      </div>
      <!-- KPI strip (glassmorphism) -->
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">
        ${[
          {label:"Total",       val:total,    color:"#c084fc", sub:total+" tasks"},
          {label:"Complete",    val:complete, color:"#4ade80", sub:pct+"% done"},
          {label:"In Progress", val:inProg,   color:"#60a5fa", sub:"active"},
          {label:"Blocked",     val:blocked,  color:"#f87171", sub:blocked?"action needed":"none"},
          {label:"Pending",     val:pending,  color:"#fbbf24", sub:"not started"},
        ].map(k=>`<div style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:13px 15px">
          <div style="color:rgba(255,255,255,.45);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${k.label}</div>
          <div style="color:${k.color};font-size:26px;font-weight:900;line-height:1;margin-bottom:4px">${k.val}</div>
          <div style="color:rgba(255,255,255,.3);font-size:10px">${k.sub}</div>
        </div>`).join("")}
      </div>
    </div>

    <div style="padding:20px 28px;display:flex;flex-direction:column;gap:20px">

      ${attPanel}

      <!-- Phase breakdown -->
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-bottom:10px">Phase Breakdown</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">${phaseCards}</div>
      </div>

      <!-- Middle row: Priority+Window | Heatmap | RICEFW -->
      <div style="display:grid;grid-template-columns:${hasRicefw?"1fr 1fr 1fr":"1fr 1fr"};gap:16px">

        <!-- Priority distribution + Window feasibility -->
        <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
          <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:14px">Priority Split</div>
          <div style="background:#f1f5f9;border-radius:8px;height:10px;overflow:hidden;display:flex;margin-bottom:8px">
            <div style="height:100%;width:${hiPct}%;background:#dc2626"></div>
            <div style="height:100%;width:${mePct}%;background:#f59e0b"></div>
          </div>
          <div style="display:flex;gap:18px;font-size:11px;color:#64748b;margin-bottom:22px">
            <span><span style="display:inline-block;width:9px;height:9px;background:#dc2626;border-radius:2px;margin-right:5px;vertical-align:middle"></span><strong style="color:#dc2626">${highPri}</strong> HIGH</span>
            <span><span style="display:inline-block;width:9px;height:9px;background:#f59e0b;border-radius:2px;margin-right:5px;vertical-align:middle"></span><strong style="color:#d97706">${medPri}</strong> MEDIUM</span>
          </div>
          <div style="border-top:1px solid #f1f5f9;padding-top:16px">
            <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:12px">Cutover Window</div>
            <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
              <div style="font-size:28px;font-weight:900;color:${feasColor};line-height:1">${totalH}h</div>
              <div>
                <div style="font-size:11px;color:#64748b">vs <strong>${windowH}h</strong> window</div>
                <div style="font-size:11px;font-weight:700;color:${feasColor};margin-top:2px">${pctFeas}% · ${overrun?"parallelise required":"fits in window"}</div>
              </div>
            </div>
            <div style="background:#f1f5f9;border-radius:6px;height:7px;overflow:hidden">
              <div style="height:100%;width:${Math.min(pctFeas,100)}%;background:${feasColor};border-radius:6px"></div>
            </div>
          </div>
        </div>

        <!-- Risk heat map -->
        <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
          <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:14px">Risk Heat Map</div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="border-bottom:1px solid #f1f5f9">
              <th style="text-align:left;padding:6px 12px;font-size:11px;font-weight:600;color:#94a3b8;padding-bottom:10px">Phase</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;color:#059669">Low</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;color:#d97706">Medium</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;color:#dc2626">High</th>
            </tr></thead>
            <tbody>${hmRows}</tbody>
          </table>
        </div>

        ${ricefwCard}
      </div>

      <!-- Workstream grid -->
      <div>
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-bottom:10px">Workstream Health</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px">
          ${wsCards}
        </div>
      </div>

    </div>
  </div>
</div>`;
}

// ── Tab: Readiness / Coverage ─────────────────────────────────────────
function renderCoverage() {
  const s = gS();
  const tasks = s ? (s.state.plan.tasks||[]) : [];
  const ricefw = s ? (s.state.ricefw||[]) : [];
  const training = s ? (s.state.training||[]) : [];
  const interfaces = s ? (s.state.interfaces||[]) : [];
  const approvals = s ? (s.state.approvals||[]) : [];
  const p = gP();

  // Deterministic confidence score
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const blockers = tasks.filter(t=>t.status==="BLOCKED").length;
  const taskPct = totalTasks ? doneTasks/totalTasks : 0;
  const ricefwPct = ricefw.length ? ricefw.filter(r=>r.readiness==="Prod Ready").length/ricefw.length : 1;
  const intPct = interfaces.length ? interfaces.filter(i=>i.readiness==="Prod Ready").length/interfaces.length : 1;
  const trainPct = training.length ? training.filter(t=>t.status==="Complete").length/training.length : 1;
  const approvedGates = approvals.filter(a=>a.status==="Approved").length;
  const totalGates = approvals.length || 1;
  const gateScore = approvedGates / totalGates;
  const score = Math.round(Math.max(0, (taskPct*40 + ricefwPct*20 + intPct*15 + trainPct*15 + gateScore*10) - blockers*2)*100) / 100;
  const scoreLabel = score>=80?"READY":score>=60?"CONDITIONAL GO":"NOT READY";
  const scoreColor = score>=80?"#059669":score>=60?"#d97706":"#dc2626";

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Readiness</div>
    <div class="page-sub">Go/No-Go assessment and cutover coverage</div>
  </div>
  ${tasks.length===0 ? `<div class="alert alert-info">Import or generate a task plan to assess readiness.</div>` : `

  <!-- Confidence Score -->
  <div class="form-row form-row-2" style="margin-bottom:20px">
    <div class="card" style="margin:0">
      <div class="card-header">Go/No-Go Confidence Score</div>
      <div class="card-body" style="display:flex;align-items:center;gap:20px">
        <div style="font-size:52px;font-weight:900;color:${scoreColor};line-height:1">${score}%</div>
        <div>
          <div style="font-size:18px;font-weight:800;color:${scoreColor}">${scoreLabel}</div>
          <div class="text-muted text-sm" style="margin-top:6px">Tasks: ${Math.round(taskPct*100)}% · RICEFW: ${Math.round(ricefwPct*100)}% · Training: ${Math.round(trainPct*100)}%</div>
          ${blockers>0?`<div class="text-xs" style="color:#dc2626;margin-top:4px">⚠ ${blockers} open blocker${blockers>1?"s":""} reducing score</div>`:""}
        </div>
      </div>
    </div>
    <div class="kpi-grid" style="margin:0;grid-template-columns:repeat(2,1fr)">
      <div class="kpi-tile"><div class="kpi-label">Tasks Done</div><div class="kpi-value" style="color:#059669">${doneTasks}/${totalTasks}</div></div>
      <div class="kpi-tile"><div class="kpi-label">Blocked</div><div class="kpi-value" style="color:#dc2626">${blockers}</div></div>
      <div class="kpi-tile"><div class="kpi-label">RICEFW Prod-Ready</div><div class="kpi-value" style="font-size:16px">${ricefw.filter(r=>r.readiness==="Prod Ready").length}/${ricefw.length||0}</div></div>
      <div class="kpi-tile"><div class="kpi-label">Gates Approved</div><div class="kpi-value" style="font-size:16px">${approvedGates}/${approvals.length||0}</div></div>
    </div>
  </div>

  <!-- KPI tiles -->
  <div class="kpi-grid">
    <div class="kpi-tile"><div class="kpi-label">Modules</div><div class="kpi-value" style="font-size:14px">${(p.modules||[]).join(", ")||"—"}</div></div>
    <div class="kpi-tile"><div class="kpi-label">Integrations Tested</div><div class="kpi-value">${interfaces.filter(i=>i.testStatus==="Passed").length}/${interfaces.length||0}</div></div>
    <div class="kpi-tile"><div class="kpi-label">Training Complete</div><div class="kpi-value">${training.filter(t=>t.status==="Complete").length}/${training.length||0}</div></div>
    <div class="kpi-tile"><div class="kpi-label">RICEFW Objects</div><div class="kpi-value">${ricefw.length}</div></div>
  </div>

  <!-- Approvals Register -->
  <div class="card">
    <div class="card-header">Gate Approvals Register
      <button class="btn btn-sm btn-secondary" onclick="APP.showApprovalAdd()">+ Add Gate</button>
    </div>
    <div class="card-body" style="padding:0">
      ${approvals.length===0 ? `<p class="text-muted text-sm" style="padding:16px">No approval gates defined. Add gates to track sign-offs from workstream leads, business owners, and PMO.</p>` : `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f8f9fa">
          <th style="padding:8px 12px;text-align:left">Gate</th>
          <th style="padding:8px">Approver</th>
          <th style="padding:8px">Status</th>
          <th style="padding:8px">Date</th>
          <th style="padding:8px">Notes</th>
          <th style="padding:8px;width:60px"></th>
        </tr></thead>
        <tbody>${approvals.map((a,i)=>{
          const sCol=a.status==="Approved"?"#059669":a.status==="Rejected"?"#dc2626":"#d97706";
          return `<tr style="border-top:1px solid #f0f0f4">
            <td style="padding:8px 12px;font-weight:600">${escHtml(a.gate)}</td>
            <td style="padding:8px">${escHtml(a.approver||"—")}</td>
            <td style="padding:8px"><select style="font-size:11px;color:${sCol};font-weight:700" onchange="APP.updateApproval(${i},'status',this.value)">
              ${["Pending","Approved","Rejected"].map(st=>`<option value="${st}" ${a.status===st?"selected":""}>${st}</option>`).join("")}
            </select></td>
            <td style="padding:8px;font-size:11px">${escHtml(a.date||"—")}</td>
            <td style="padding:8px;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.notes||"")}</td>
            <td style="padding:8px"><button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.deleteApproval(${i})">✕</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`}
    </div>
  </div>

  <!-- AI Go/No-Go -->
  <div class="card">
    <div class="card-header">AI Go/No-Go Assessment
      <button class="btn btn-sm btn-primary" onclick="APP.runAgent('goNoGo')" ${STATE.agentRunning==="goNoGo"?"disabled":""}>
        ${STATE.agentRunning==="goNoGo" ? `<span class="spinner"></span> Assessing…` : "Run Assessment"}
      </button>
    </div>
    <div class="card-body">
      ${STATE.agentRunning==="goNoGo" ? `<div class="loader"><span class="spinner"></span> Running Go/No-Go assessment…</div>` :
        (s&&s.agents&&s.agents.goNoGo ? renderMarkdown(s.agents.goNoGo.output) :
        `<p class="text-muted text-sm">Click "Run Assessment" to get an AI-powered go/no-go recommendation.</p>`)}
    </div>
  </div>
  `}

  <!-- Add Approval Modal -->
  ${STATE.showApprovalAdd ? `<div class="modal-overlay" onclick="if(event.target===this)APP.closeApprovalAdd()">
  <div class="modal modal-md">
    <div class="modal-header"><h2>Add Approval Gate</h2><button class="modal-close" onclick="APP.closeApprovalAdd()">✕</button></div>
    <div class="modal-body">
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Gate Name</label><input type="text" id="ap-gate" placeholder="e.g. FI Workstream Sign-off" /></div>
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Approver</label><input type="text" id="ap-approver" placeholder="Name / role" /></div>
        <div class="form-group"><label class="form-label">Date</label><input type="date" id="ap-date" /></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label><input type="text" id="ap-notes" placeholder="Optional notes" /></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="APP.closeApprovalAdd()">Cancel</button>
      <button class="btn btn-primary" onclick="APP.saveApproval()">Add Gate</button>
    </div>
  </div></div>` : ""}
  </div>`;
}

// ── Tab: Execution (Command Center) ───────────────────────────────────
function renderCommand() {
  const s = gS();
  const tasks = s ? (s.state.plan.tasks||[]) : [];
  const plan = gPlan();
  const complete = tasks.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;
  const inProg   = tasks.filter(t=>t.status==="IN_PROGRESS").length;
  const blocked  = tasks.filter(t=>t.status==="BLOCKED").length;
  const verified = tasks.filter(t=>t.status==="VERIFIED").length;
  const pct = tasks.length ? Math.round(complete/tasks.length*100) : 0;
  const now_ = tasks.filter(t=>t.status==="IN_PROGRESS");
  const next_ = tasks.filter(t=>t.status==="PENDING").slice(0,5);
  const rehearsal = s ? (s.state.rehearsal||{}) : {};

  return `<div class="page" style="max-width:none;padding:18px 20px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
    <div>
      <div class="page-title" style="font-size:16px">Execution</div>
      <div class="page-sub">Live runsheet and cutover execution tracking</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="APP.exportXlsx()">↓ Excel Runsheet</button>
      <button class="btn btn-secondary btn-sm" onclick="APP.exportCsv()">↓ CSV</button>
      ${tasks.length>0 ? `<button class="btn btn-secondary btn-sm" onclick="APP.runAgent('commandCenter')" ${STATE.agentRunning==="commandCenter"?"disabled":""}>
        ${STATE.agentRunning==="commandCenter"?`<span class="spinner"></span> Running…`:"🧠 AI Narrative"}</button>` : ""}
    </div>
  </div>

  ${tasks.length===0 ? `<div class="alert alert-info">No tasks yet. Import a plan first.</div>` : `

  <!-- KPI Bar -->
  <div class="kpi-grid" style="margin-bottom:16px">
    <div class="kpi-tile" style="border-top:3px solid #A100FF"><div class="kpi-label">Total</div><div class="kpi-value">${tasks.length}</div></div>
    <div class="kpi-tile" style="border-top:3px solid #059669"><div class="kpi-label">Complete</div><div class="kpi-value" style="color:#059669">${complete}</div><div class="kpi-sub">${pct}%</div></div>
    <div class="kpi-tile" style="border-top:3px solid #1d4ed8"><div class="kpi-label">In Progress</div><div class="kpi-value" style="color:#1d4ed8">${inProg}</div></div>
    <div class="kpi-tile" style="border-top:3px solid #dc2626"><div class="kpi-label">Blocked</div><div class="kpi-value" style="color:#dc2626">${blocked}</div></div>
    <div class="kpi-tile" style="border-top:3px solid #059669"><div class="kpi-label">Verified</div><div class="kpi-value" style="color:#059669">${verified}</div></div>
  </div>

  <!-- Progress Bar -->
  <div class="progress" style="margin-bottom:16px;height:8px">
    <div class="progress-fill progress-fill-purple" style="width:${pct}%"></div>
  </div>

  <!-- Now & Next -->
  <div class="form-row form-row-2" style="margin-bottom:16px">
    <div class="card" style="margin:0">
      <div class="card-header" style="color:#1d4ed8">▶ Now — In Progress (${now_.length})</div>
      <div class="card-body" style="padding:0">
        ${now_.length===0 ? `<p class="text-muted text-sm" style="padding:12px">No tasks in progress.</p>` :
          now_.map(t=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #f0f0f4">
            <div>
              <div style="font-size:12px;font-weight:600">${escHtml(t.task)}</div>
              <div class="text-xs text-muted">${escHtml(t.owner||"—")} · ${t.durationH||"?"}h</div>
            </div>
            ${statusChip(t.status, t.id)}
          </div>`).join("")}
      </div>
    </div>
    <div class="card" style="margin:0">
      <div class="card-header" style="color:#64748b">⏭ Next Up — Pending</div>
      <div class="card-body" style="padding:0">
        ${next_.length===0 ? `<p class="text-muted text-sm" style="padding:12px">No pending tasks.</p>` :
          next_.map(t=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #f0f0f4">
            <div>
              <div style="font-size:12px;font-weight:600">${escHtml(t.task)}</div>
              <div class="text-xs text-muted">${escHtml(t.owner||"—")} · ${t.durationH||"?"}h</div>
            </div>
            <button class="btn btn-xs btn-primary" onclick="APP.markStart('${t.id}')">▶ Start</button>
          </div>`).join("")}
      </div>
    </div>
  </div>

  <!-- Active Blockers -->
  ${blocked>0 ? `<div class="card" style="margin-bottom:16px;border-left:3px solid #dc2626">
    <div class="card-header" style="color:#dc2626">⛔ Active Blockers (${blocked})</div>
    <div class="card-body" style="padding:0">
      ${tasks.filter(t=>t.status==="BLOCKED").map(t=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid #f0f0f4">
        <div>
          <div style="font-size:12px;font-weight:600">${escHtml(t.task)}</div>
          <div class="text-xs text-muted">${phaseChip(t.phase)} · ${escHtml(t.owner||"No owner")}</div>
        </div>
        <button class="btn btn-xs btn-danger" onclick="APP.fixTask('${t.id}')">💡 AI Fix</button>
      </div>`).join("")}
    </div>
  </div>` : ""}

  <!-- Dress Rehearsal -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-header">Mock Cutover / Dress Rehearsal</div>
    <div class="card-body">
      <div class="form-row form-row-2">
        ${["sim1","sim2"].map((key,i)=>{
          const sim = rehearsal[key]||{};
          return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px">
            <div style="font-weight:700;margin-bottom:10px;color:#64748b">SIM ${i+1}</div>
            <div class="form-group" style="margin-bottom:8px"><label class="form-label text-xs">Start Date/Time</label>
              <input type="datetime-local" style="font-size:11px" value="${escHtml(sim.start||"")}" onchange="APP.updateRehearsal('${key}','start',this.value)" /></div>
            <div class="form-group" style="margin-bottom:8px"><label class="form-label text-xs">End Date/Time</label>
              <input type="datetime-local" style="font-size:11px" value="${escHtml(sim.end||"")}" onchange="APP.updateRehearsal('${key}','end',this.value)" /></div>
            <div class="form-group" style="margin-bottom:8px"><label class="form-label text-xs">Outcome</label>
              <select style="font-size:11px" onchange="APP.updateRehearsal('${key}','outcome',this.value)">
                ${["—","Pass","Fail","Partial"].map(o=>`<option value="${o}" ${(sim.outcome||"—")===o?"selected":""}>${o}</option>`).join("")}
              </select></div>
            <div class="form-group"><label class="form-label text-xs">Notes</label>
              <input type="text" style="font-size:11px" value="${escHtml(sim.notes||"")}" placeholder="Observations…" onblur="APP.updateRehearsal('${key}','notes',this.value)" /></div>
          </div>`;
        }).join("")}
      </div>
    </div>
  </div>

  ${s&&s.agents&&s.agents.commandCenter ? `<div class="card" style="margin-bottom:16px"><div class="card-header">AI Narrative</div><div class="card-body">${renderMarkdown(s.agents.commandCenter.output)}</div></div>` : ""}

  <!-- Full Runsheet Table -->
  <div class="section-div">Full Runsheet</div>
  <div class="table-wrap" style="overflow:auto;max-height:calc(100vh - 280px)">
  <table>
    <thead><tr>
      <th style="width:28px;text-align:center">#</th>
      <th style="width:72px">ID</th>
      <th style="min-width:260px">Task</th>
      <th>Phase</th>
      <th>Workstream</th>
      <th>Owner</th>
      <th>Duration</th>
      <th>Actual Start</th>
      <th>Actual End</th>
      <th>Status</th>
      <th>Priority</th>
    </tr></thead>
    <tbody>
    ${tasks.map((t,i)=>{
      const borderCol=t.status==="BLOCKED"?"#b91c1c":t.status==="IN_PROGRESS"?"#8800d9":(t.status==="COMPLETE"||t.status==="VERIFIED")?"#059669":"#e2e8f0";
      return `<tr class="task-row" style="border-left:3px solid ${borderCol}">
        <td style="text-align:center;color:#64748b;font-size:11px;border-bottom:1px solid #f0f0f4">${i+1}</td>
        <td style="font-family:monospace;font-size:10px;font-weight:700;color:#A100FF;border-bottom:1px solid #f0f0f4">${t.id}</td>
        <td style="border-bottom:1px solid #f0f0f4">${escHtml(t.task)}</td>
        <td style="border-bottom:1px solid #f0f0f4">${phaseChip(t.phase)}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:12px">${escHtml(t.workstream||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:12px">${escHtml(t.owner||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4;text-align:center;font-size:12px">${t.durationH||"—"}h</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:11px;font-family:monospace">${t.actualStart?escHtml(String(t.actualStart).slice(0,16)):`<span onclick="APP.markStart('${t.id}')" style="cursor:pointer;color:#64748b;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;font-size:10px">▶</span>`}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:11px;font-family:monospace">${t.actualEnd?escHtml(String(t.actualEnd).slice(0,16)):`<span onclick="APP.markEnd('${t.id}')" style="cursor:pointer;color:#64748b;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;font-size:10px">■</span>`}</td>
        <td style="border-bottom:1px solid #f0f0f4">${statusChip(t.status,t.id)}</td>
        <td style="border-bottom:1px solid #f0f0f4">${priorityDisplay(t.priority||"MEDIUM")}</td>
      </tr>`;
    }).join("")}
    </tbody>
  </table></div>`}
  </div>`;
}

// ── Tab: RICEFW ───────────────────────────────────────────────────────
function renderRicefw() {
  const s = gS();
  const items = s ? (s.state.ricefw||[]) : [];
  const TYPES = ["Report","Interface","Conversion","Enhancement","Form","Workflow"];
  const READY = ["Not Started","In Development","Unit Test","Transport Created","UAT Signed","Prod Ready"];

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">RICEFW Register</div>
    <div class="page-sub">Custom development object readiness tracker</div>
  </div>
  <div style="margin-bottom:14px;display:flex;gap:8px">
    <button class="btn btn-primary btn-sm" onclick="APP.showRicefwAdd()">+ Add Object</button>
    ${items.length>0 ? `<button class="btn btn-secondary btn-sm" onclick="APP.runAgent('ricefw')" ${STATE.agentRunning==="ricefw"?"disabled":""}>
      ${STATE.agentRunning==="ricefw"?`<span class="spinner"></span>`:"🧠 AI Assessment"}</button>` : ""}
  </div>
  ${items.length===0 ? `<div class="alert alert-info">No RICEFW objects added yet. Click "+ Add Object" to start tracking.</div>` : `
  <div class="table-wrap">
  <table>
    <thead><tr><th>#</th><th>Type</th><th>Name</th><th>Module</th><th>Readiness</th><th>Transport</th><th>Owner</th><th></th></tr></thead>
    <tbody>
    ${items.map((r,i)=>
      `<tr class="task-row">
        <td style="border-bottom:1px solid #f0f0f4;color:#64748b;font-size:11px">${i+1}</td>
        <td style="border-bottom:1px solid #f0f0f4"><span class="badge badge-purple">${escHtml(r.type||"—")}</span></td>
        <td style="border-bottom:1px solid #f0f0f4;font-weight:600">${escHtml(r.name||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4">${escHtml(r.module||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4">${escHtml(r.readiness||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-family:monospace;font-size:11px">${escHtml(r.transport||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4">${escHtml(r.responsible||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4"><button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.deleteRicefw(${i})">✕</button></td>
      </tr>`
    ).join("")}
    </tbody>
  </table></div>
  ${s&&s.agents&&s.agents.ricefw ? `<div class="card" style="margin-top:16px"><div class="card-header">AI Assessment</div><div class="card-body">${renderMarkdown(s.agents.ricefw.output)}</div></div>` : ""}`}
  </div>`;
}

// ── Tab: Timeline ─────────────────────────────────────────────────────
function renderTimeline() {
  const s = gS();
  const tasks = s ? (s.state.plan.tasks||[]) : [];
  const p = gP();
  if (!tasks.length) return `<div class="page"><div class="page-header"><div class="page-title">Timeline</div></div><div class="alert alert-info">Import or generate a task plan to view the timeline.</div></div>`;

  const maxH = tasks.reduce((m,t)=>Math.max(m,(t.esH||0)+(t.durationH||2)),24);
  const windowH = Math.max(maxH, p.cutoverDurationH||48);
  const PX_PER_H = 18;
  const totalPx = windowH * PX_PER_H;
  const phColors = { PRE:"#dbeafe", CUT:"#fef3c7", HC:"#e0f2fe", POST:"#dcfce7", RAMP:"#ede9fe" };
  const phFg = { PRE:"#1d4ed8", CUT:"#b45309", HC:"#0369a1", POST:"#15803d", RAMP:"#7c3aed" };

  // Group by workstream
  const wsMap = {};
  tasks.forEach(t=>{ if (!wsMap[t.workstream||"General"]) wsMap[t.workstream||"General"]=[]; wsMap[t.workstream||"General"].push(t); });

  const labelW = 160;
  const rows = Object.entries(wsMap).map(([ws, wsTasks])=>{
    const bars = wsTasks.map(t=>{
      const start = (t.esH||0) * PX_PER_H;
      const width = Math.max((t.durationH||2)*PX_PER_H, 20);
      const bg = phColors[t.phase]||"#f1f5f9";
      const fg = phFg[t.phase]||"#64748b";
      const done = t.status==="COMPLETE"||t.status==="VERIFIED";
      const blocked = t.status==="BLOCKED";
      return `<div title="${escHtml(t.task)} (${t.durationH||2}h)" style="position:absolute;left:${start}px;top:4px;width:${width}px;height:26px;background:${blocked?"#fee2e2":bg};border:1px solid ${blocked?"#dc2626":fg};border-radius:4px;overflow:hidden;cursor:default">
        <div style="width:${done?100:0}%;height:100%;background:${fg};opacity:0.25;position:absolute;top:0;left:0"></div>
        <div style="position:relative;padding:4px 5px;font-size:9px;font-weight:700;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(t.id)}</div>
      </div>`;
    }).join("");
    return `<div style="display:flex;align-items:center;min-height:36px;border-bottom:1px solid #f0f0f4">
      <div style="width:${labelW}px;flex-shrink:0;font-size:11px;font-weight:600;padding:4px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(ws)}</div>
      <div style="position:relative;flex:1;height:36px;border-left:1px solid #e2e8f0">${bars}</div>
    </div>`;
  }).join("");

  // Hour markers
  const markers = [];
  for (let h=0;h<=windowH;h+=8) {
    markers.push(`<div style="position:absolute;left:${labelW+h*PX_PER_H}px;top:0;height:100%;border-left:1px dashed #e2e8f0;pointer-events:none">
      <span style="position:absolute;top:2px;left:3px;font-size:9px;color:#94a3b8">H+${h}</span></div>`);
  }

  return `<div class="page" style="max-width:none">
  <div class="page-header">
    <div class="page-title">Timeline</div>
    <div class="page-sub">Gantt view — tasks positioned by estimated start hour from cutover T-zero</div>
  </div>
  <div class="card"><div class="card-body" style="padding:0;overflow-x:auto">
    <div style="position:relative;min-width:${labelW+totalPx}px">
      ${markers.join("")}
      <!-- Header row -->
      <div style="display:flex;border-bottom:2px solid #e2e8f0;position:sticky;top:0;background:#fff;z-index:2">
        <div style="width:${labelW}px;flex-shrink:0;font-size:11px;font-weight:700;padding:6px 10px;color:#64748b">Workstream</div>
        <div style="flex:1;height:30px;border-left:1px solid #e2e8f0;position:relative">
          ${Array.from({length:Math.ceil(windowH/8)+1},(_,i)=>i*8).map(h=>`<span style="position:absolute;left:${h*PX_PER_H}px;font-size:10px;color:#64748b;top:8px">H+${h}</span>`).join("")}
        </div>
      </div>
      ${rows}
    </div>
  </div></div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px">
    ${Object.entries(phColors).map(([ph,bg])=>`<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px"><span style="width:14px;height:14px;background:${bg};border:1px solid ${phFg[ph]};border-radius:3px;display:inline-block"></span>${ph}</span>`).join("")}
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px"><span style="width:14px;height:14px;background:#fee2e2;border:1px solid #dc2626;border-radius:3px;display:inline-block"></span>Blocked</span>
  </div>
  </div>`;
}

// ── Tab: Integrations ─────────────────────────────────────────────────
function renderIntegrations() {
  const s = gS();
  const items = s ? (s.state.interfaces||[]) : [];
  const TYPES = ["iDoc","RFC","BAPI","File","API","Other"];
  const READY = ["Not Started","In Dev","Unit Test","SIT","UAT","Prod Ready"];
  const TEST_STATUS = ["Not Tested","In Progress","Passed","Failed"];

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Integrations</div>
    <div class="page-sub">Interface register — track integration objects, readiness, and test status</div>
  </div>
  <div style="margin-bottom:14px;display:flex;gap:8px">
    <button class="btn btn-primary btn-sm" onclick="APP.showIntegAdd()">+ Add Interface</button>
    ${items.length>0 ? `<span class="text-muted text-sm" style="align-self:center">${items.filter(i=>i.readiness==="Prod Ready").length}/${items.length} Prod Ready · ${items.filter(i=>i.testStatus==="Passed").length} Passed</span>` : ""}
  </div>
  ${items.length===0 ? `<div class="alert alert-info">No interfaces added. Click "+ Add Interface" to start tracking integrations.</div>` : `
  <div class="table-wrap">
  <table>
    <thead><tr><th>#</th><th>Interface</th><th>Type</th><th>Source</th><th>Target</th><th>Middleware</th><th>Readiness</th><th>Test Status</th><th>Owner</th><th></th></tr></thead>
    <tbody>
    ${items.map((r,i)=>`<tr class="task-row">
      <td style="border-bottom:1px solid #f0f0f4;color:#64748b;font-size:11px">${i+1}</td>
      <td style="border-bottom:1px solid #f0f0f4;font-weight:600;font-size:12px">${escHtml(r.name||"—")}</td>
      <td style="border-bottom:1px solid #f0f0f4"><span class="badge badge-purple">${escHtml(r.type||"—")}</span></td>
      <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.source||"—")}</td>
      <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.target||"—")}</td>
      <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.middleware||"—")}</td>
      <td style="border-bottom:1px solid #f0f0f4">
        <select style="font-size:11px;color:${r.readiness==="Prod Ready"?"#059669":"#64748b"}" onchange="APP.updateInteg(${i},'readiness',this.value)">
          ${READY.map(rd=>`<option value="${rd}" ${r.readiness===rd?"selected":""}>${rd}</option>`).join("")}
        </select>
      </td>
      <td style="border-bottom:1px solid #f0f0f4">
        <select style="font-size:11px;color:${r.testStatus==="Passed"?"#059669":r.testStatus==="Failed"?"#dc2626":"#64748b"}" onchange="APP.updateInteg(${i},'testStatus',this.value)">
          ${TEST_STATUS.map(ts=>`<option value="${ts}" ${r.testStatus===ts?"selected":""}>${ts}</option>`).join("")}
        </select>
      </td>
      <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.owner||"—")}</td>
      <td style="border-bottom:1px solid #f0f0f4"><button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.deleteInteg(${i})">✕</button></td>
    </tr>`).join("")}
    </tbody>
  </table></div>`}

  <!-- Add Interface Modal -->
  ${STATE.showIntegAdd ? `<div class="modal-overlay" onclick="if(event.target===this)APP.closeIntegAdd()">
  <div class="modal modal-md">
    <div class="modal-header"><h2>Add Interface</h2><button class="modal-close" onclick="APP.closeIntegAdd()">✕</button></div>
    <div class="modal-body">
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Interface Name</label><input type="text" id="in-name" placeholder="e.g. MM-to-WM Stock Transfer" /></div>
        <div class="form-group"><label class="form-label">Type</label>
          <select id="in-type">${TYPES.map(t=>`<option>${t}</option>`).join("")}</select>
        </div>
      </div>
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Source System</label><input type="text" id="in-source" placeholder="e.g. ECC" /></div>
        <div class="form-group"><label class="form-label">Target System</label><input type="text" id="in-target" placeholder="e.g. S/4HANA" /></div>
      </div>
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Middleware</label><input type="text" id="in-mw" placeholder="e.g. PI/PO, MuleSoft" /></div>
        <div class="form-group"><label class="form-label">Owner</label><input type="text" id="in-owner" placeholder="Owner name" /></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="APP.closeIntegAdd()">Cancel</button>
      <button class="btn btn-primary" onclick="APP.saveInteg()">Add Interface</button>
    </div>
  </div></div>` : ""}
  </div>`;
}

// ── Tab: Training ─────────────────────────────────────────────────────
function renderTraining() {
  const s = gS();
  const items = s ? (s.state.training||[]) : [];
  const METHODS = ["eLearning","ILT","Simulation","Job Aid","Super User"];
  const STATUSES = ["Not Started","In Progress","Complete"];

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Training</div>
    <div class="page-sub">User group training readiness tracker</div>
  </div>
  <div style="margin-bottom:14px;display:flex;gap:8px;align-items:center">
    <button class="btn btn-primary btn-sm" onclick="APP.showTrainingAdd()">+ Add Role</button>
    ${items.length>0 ? `
      <span class="text-muted text-sm">${items.filter(t=>t.status==="Complete").length}/${items.length} Complete</span>
      <div style="width:120px;margin-left:8px">
        <div class="progress"><div class="progress-fill progress-fill-green" style="width:${items.length?Math.round(items.filter(t=>t.status==="Complete").length/items.length*100):0}%"></div></div>
      </div>` : ""}
  </div>
  ${items.length===0 ? `<div class="alert alert-info">No training roles added. Click "+ Add Role" to track training readiness by user group.</div>` : `
  <div class="table-wrap">
  <table>
    <thead><tr><th>#</th><th>Role / User Group</th><th>System</th><th>Method</th><th>Trainer</th><th>Scheduled Date</th><th>Completion %</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${items.map((r,i)=>{
      const sCol=r.status==="Complete"?"#059669":r.status==="In Progress"?"#1d4ed8":"#64748b";
      return `<tr class="task-row">
        <td style="border-bottom:1px solid #f0f0f4;color:#64748b;font-size:11px">${i+1}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-weight:600;font-size:12px">${escHtml(r.role||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.system||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4"><span class="badge badge-purple">${escHtml(r.method||"—")}</span></td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.trainer||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4;font-size:11px">${escHtml(r.scheduledDate||"—")}</td>
        <td style="border-bottom:1px solid #f0f0f4">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="progress" style="width:60px"><div class="progress-fill progress-fill-green" style="width:${r.completion||0}%"></div></div>
            <span style="font-size:11px">${r.completion||0}%</span>
          </div>
        </td>
        <td style="border-bottom:1px solid #f0f0f4">
          <select style="font-size:11px;color:${sCol};font-weight:700" onchange="APP.updateTraining(${i},'status',this.value)">
            ${STATUSES.map(st=>`<option value="${st}" ${r.status===st?"selected":""}>${st}</option>`).join("")}
          </select>
        </td>
        <td style="border-bottom:1px solid #f0f0f4"><button class="btn btn-xs btn-ghost" style="color:#dc2626" onclick="APP.deleteTraining(${i})">✕</button></td>
      </tr>`;
    }).join("")}
    </tbody>
  </table></div>`}

  <!-- Add Training Modal -->
  ${STATE.showTrainingAdd ? `<div class="modal-overlay" onclick="if(event.target===this)APP.closeTrainingAdd()">
  <div class="modal modal-md">
    <div class="modal-header"><h2>Add Training Role</h2><button class="modal-close" onclick="APP.closeTrainingAdd()">✕</button></div>
    <div class="modal-body">
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Role / User Group</label><input type="text" id="tr-role" placeholder="e.g. FI Accountants" /></div>
        <div class="form-group"><label class="form-label">System</label><input type="text" id="tr-system" placeholder="e.g. S/4HANA FI" /></div>
      </div>
      <div class="form-row form-row-2">
        <div class="form-group"><label class="form-label">Training Method</label>
          <select id="tr-method">${METHODS.map(m=>`<option>${m}</option>`).join("")}</select>
        </div>
        <div class="form-group"><label class="form-label">Trainer</label><input type="text" id="tr-trainer" placeholder="Trainer name" /></div>
      </div>
      <div class="form-group"><label class="form-label">Scheduled Date</label><input type="date" id="tr-date" /></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="APP.closeTrainingAdd()">Cancel</button>
      <button class="btn btn-primary" onclick="APP.saveTraining()">Add Role</button>
    </div>
  </div></div>` : ""}
  </div>`;
}

// ── Tab: Orchestration / Tower ────────────────────────────────────────
function renderTower() {
  const s = gS();
  const tasks = s ? (s.state.plan.tasks||[]) : [];

  // By phase breakdown
  const phases = ["PRE","CUT","HC","POST"];
  const byPhase = {};
  phases.forEach(ph=>{ byPhase[ph]={total:0,complete:0,blocked:0,inProg:0}; });
  tasks.forEach(t=>{
    const ph=t.phase||"CUT";
    if (!byPhase[ph]) byPhase[ph]={total:0,complete:0,blocked:0,inProg:0};
    byPhase[ph].total++;
    if (t.status==="COMPLETE"||t.status==="VERIFIED") byPhase[ph].complete++;
    if (t.status==="BLOCKED") byPhase[ph].blocked++;
    if (t.status==="IN_PROGRESS") byPhase[ph].inProg++;
  });

  const blockers = tasks.filter(t=>t.status==="BLOCKED");
  const critical = tasks.filter(t=>t.critical);
  const critDone = critical.filter(t=>t.status==="COMPLETE"||t.status==="VERIFIED").length;

  return `<div class="page">
  <div class="page-header">
    <div class="page-title">Orchestration</div>
    <div class="page-sub">Control tower — phase health, critical path, and escalations</div>
  </div>

  ${tasks.length===0 ? `<div class="alert alert-info">Import or generate a task plan to see the orchestration view.</div>` : `

  <!-- Phase Health Cards -->
  <div class="section-div">Phase Health</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
    ${phases.map(ph=>{
      const v=byPhase[ph]||{total:0,complete:0,blocked:0,inProg:0};
      const c=PC[ph]||{bg:"#f1f5f9",fg:"#64748b"};
      const pct=v.total?Math.round(v.complete/v.total*100):0;
      return `<div class="kpi-tile" style="border-top:3px solid ${c.fg}">
        <div class="kpi-label">${phaseChip(ph)}</div>
        <div class="kpi-value" style="font-size:22px">${pct}%</div>
        <div class="kpi-sub">${v.complete}/${v.total} done</div>
        ${v.blocked>0?`<div style="color:#dc2626;font-size:11px;font-weight:700">${v.blocked} blocked</div>`:""}
        ${v.inProg>0?`<div style="color:#1d4ed8;font-size:11px">${v.inProg} in progress</div>`:""}
        <div class="progress" style="margin-top:6px"><div class="progress-fill" style="width:${pct}%;background:${c.fg}"></div></div>
      </div>`;
    }).join("")}
  </div>

  <!-- Critical Path Status -->
  <div class="form-row form-row-2" style="margin-bottom:20px">
    <div class="card" style="margin:0">
      <div class="card-header">Critical Path (${critical.length} tasks)</div>
      <div class="card-body">
        <div style="display:flex;align-items:center;gap:14px">
          <div style="font-size:36px;font-weight:900;color:${critDone===critical.length?"#059669":"#d97706"}">${critical.length?Math.round(critDone/critical.length*100):100}%</div>
          <div>
            <div style="font-weight:700">${critDone}/${critical.length} critical tasks complete</div>
            ${critical.filter(t=>t.status==="BLOCKED").length>0?`<div style="color:#dc2626;font-size:12px;font-weight:700">${critical.filter(t=>t.status==="BLOCKED").length} critical tasks BLOCKED</div>`:""}
          </div>
        </div>
        ${critical.length>0?`<div style="margin-top:10px;max-height:160px;overflow-y:auto">
          ${critical.slice(0,10).map(t=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0f0f4;font-size:11px">
            <span style="color:#A100FF;font-family:monospace;font-weight:700">${t.id}</span>
            <span style="flex:1;margin:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.task)}</span>
            ${statusChip(t.status,t.id)}
          </div>`).join("")}
        </div>`:""}
      </div>
    </div>

    <!-- Escalations -->
    <div class="card" style="margin:0">
      <div class="card-header" style="color:${blockers.length>0?"#dc2626":"#059669"}">
        ${blockers.length>0?"⛔ Escalations / Blockers":"✓ No Blockers"}
      </div>
      <div class="card-body" style="padding:0">
        ${blockers.length===0 ? `<p class="text-muted text-sm" style="padding:12px">All clear — no blocked tasks.</p>` :
          `<div style="max-height:220px;overflow-y:auto">
            ${blockers.map(t=>`<div style="padding:8px 14px;border-bottom:1px solid #f0f0f4">
              <div style="font-size:12px;font-weight:700;color:#dc2626">${escHtml(t.task)}</div>
              <div class="text-xs text-muted">${phaseChip(t.phase)} · ${escHtml(t.workstream||"?")} · ${escHtml(t.owner||"No owner")}</div>
              <button class="btn btn-xs btn-danger" style="margin-top:4px" onclick="APP.fixTask('${t.id}')">💡 AI Fix</button>
            </div>`).join("")}
          </div>`}
      </div>
    </div>
  </div>

  <!-- AI Agents Panel -->
  <div class="section-div">AI Agents Quick Access</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">
    ${["waveOrchestration","readiness","riskMitigation","commandCenter"].map(key=>{
      const ag = AGENTS_DEF.find(a=>a.key===key);
      if (!ag) return "";
      return `<button class="btn btn-secondary btn-sm" onclick="APP.runAgent('${key}');APP.nav('agents')" ${STATE.agentRunning===key?"disabled":""}>
        ${STATE.agentRunning===key?`<span class="spinner"></span> Running…`:ag.label}
      </button>`;
    }).join("")}
    <button class="btn btn-ghost btn-sm" onclick="APP.nav('agents')">View All Agents →</button>
  </div>
  `}
  </div>`;
}

// ── Stub for other tabs ───────────────────────────────────────────────
function renderStub(tab) {
  return `<div class="page">
    <div class="page-header"><div class="page-title" style="text-transform:capitalize">${tab}</div></div>
    <div class="alert alert-info">This section is available in the full version.</div>
  </div>`;
}

// ── Modals ────────────────────────────────────────────────────────────
function renderModals() {
  let html = "";

  // New Session Modal
  if (STATE.newSessionModal) {
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeNewSession()">
    <div class="modal modal-md">
      <div class="modal-header">
        <h2>New Session</h2>
        <button class="modal-close" onclick="APP.closeNewSession()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:14px">
          <label class="form-label">Project Name</label>
          <input type="text" id="ns-name" placeholder="e.g. ACME S/4HANA Phase 1" />
        </div>
        <div class="form-row form-row-2">
          <div class="form-group">
            <label class="form-label">Deployment Approach</label>
            <select id="ns-approach">
              <option>Big Bang</option>
              <option>Phased / Wave rollout</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Industry</label>
            <select id="ns-industry">
              ${INDUSTRIES_LIST.map(i=>`<option value="${i.k}">${i.label}</option>`).join("")}
            </select>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.closeNewSession()">Cancel</button>
        <button class="btn btn-primary" onclick="APP.createSession()">Create Session</button>
      </div>
    </div></div>`;
  }

  // Import Modal
  if (STATE.importModal) {
    html += `<div class="modal-overlay">
    <div class="modal modal-md">
      <div class="modal-header">
        <h2>Import L4 Plan</h2>
        <button class="modal-close" onclick="APP.closeImport()">✕</button>
      </div>
      <div class="modal-body">
        ${STATE.importErr ? `<div class="alert alert-danger" style="margin-bottom:12px">${escHtml(STATE.importErr)}</div>` : ""}
        <div class="upload-zone" onclick="document.getElementById('l4-file-inp').click()">
          <div style="font-size:22px;margin-bottom:8px">📄</div>
          <div style="font-weight:600">Click to select your L4 workplan</div>
          <div class="text-muted text-sm">Excel (.xlsx, .xls) or CSV</div>
          <input type="file" id="l4-file-inp" accept=".xlsx,.xls,.csv,.txt" style="display:none" onchange="APP.importFile(this.files[0])" />
        </div>
        <div class="section-div" style="margin:16px 0 10px">Or paste tab-separated / CSV data</div>
        <textarea id="l4-paste" rows="6" placeholder="Paste rows here…"></textarea>
        ${STATE.importBusy ? `<div class="loader" style="margin-top:10px"><span class="spinner"></span> Parsing plan…</div>` : ""}
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.closeImport()">Cancel</button>
        <button class="btn btn-primary" onclick="APP.importPasted()" ${STATE.importBusy?"disabled":""}>Import Pasted Data</button>
      </div>
    </div></div>`;
  }

  // Owner gap modal
  if (STATE.showOwnerGap) {
    const tasks = gPlan().tasks || [];
    const noOwner = tasks.filter(t=>!t.owner || t.owner.trim()==="");
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeOwnerGap()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>Owner Gaps</h2><button class="modal-close" onclick="APP.closeOwnerGap()">✕</button></div>
      <div class="modal-body">
        ${noOwner.length===0 ? `<div class="alert alert-success">✓ All tasks have owners assigned.</div>` : `
        <div class="alert alert-warning">${noOwner.length} tasks have no owner assigned.</div>
        <div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>ID</th><th>Task</th><th>Phase</th></tr></thead>
          <tbody>${noOwner.map(t=>`<tr class="task-row">
            <td style="font-family:monospace;font-size:10px;color:#A100FF;font-weight:700;border-bottom:1px solid #f0f0f4">${t.id}</td>
            <td style="border-bottom:1px solid #f0f0f4;font-size:12px">${escHtml(t.task)}</td>
            <td style="border-bottom:1px solid #f0f0f4">${phaseChip(t.phase)}</td>
          </tr>`).join("")}</tbody>
        </table></div>`}
      </div>
      <div class="modal-footer"><button class="btn btn-primary" onclick="APP.closeOwnerGap()">Close</button></div>
    </div></div>`;
  }

  // Finalize confirm
  if (STATE.confirmFinalize) {
    html += `<div class="modal-overlay">
    <div class="modal modal-sm">
      <div class="modal-header"><h2>Finalize Plan</h2><button class="modal-close" onclick="APP.cancelFinalize()">✕</button></div>
      <div class="modal-body">
        <p>Finalizing switches the plan into <strong>tracking mode</strong>. Inline editing is disabled — only status and actual times can be updated.</p>
        <div class="alert alert-warning" style="margin-top:12px">This action cannot be undone from the UI.</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.cancelFinalize()">Cancel</button>
        <button class="btn btn-primary" onclick="APP.doFinalize()">✓ Finalize</button>
      </div>
    </div></div>`;
  }

  // Delete confirm
  if (STATE.confirmDeleteId) {
    html += `<div class="modal-overlay">
    <div class="modal modal-sm">
      <div class="modal-header"><h2>Delete Task</h2><button class="modal-close" onclick="APP.cancelDelete()">✕</button></div>
      <div class="modal-body"><p>Delete this task? This cannot be undone.</p></div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.cancelDelete()">Cancel</button>
        <button class="btn btn-danger" onclick="APP.doDelete()">Delete</button>
      </div>
    </div></div>`;
  }

  // AI Fix modal
  if (STATE.fixTask) {
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeFix()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>AI Fix — Blocked Task</h2><button class="modal-close" onclick="APP.closeFix()">✕</button></div>
      <div class="modal-body">
        <p class="text-muted text-sm" style="margin-bottom:12px">Task: <strong>${escHtml(STATE.fixTask.task)}</strong></p>
        ${STATE.fixLoading ? `<div class="loader"><span class="spinner"></span> Getting AI suggestion…</div>` :
          STATE.fixText ? renderMarkdown(STATE.fixText) : ""}
      </div>
      <div class="modal-footer">
        ${STATE.fixText ? `<button class="btn btn-secondary" onclick="navigator.clipboard.writeText(${JSON.stringify(STATE.fixText)}).then(()=>toast('Copied','success'))">📋 Copy</button>` : ""}
        <button class="btn btn-primary" onclick="APP.closeFix()">Close</button>
      </div>
    </div></div>`;
  }

  // RICEFW add modal
  if (STATE.showRicefwAdd) {
    const TYPES = ["Report","Interface","Conversion","Enhancement","Form","Workflow"];
    const READY = ["Not Started","In Development","Unit Test","Transport Created","UAT Signed","Prod Ready"];
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeRicefwAdd()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>Add RICEFW Object</h2><button class="modal-close" onclick="APP.closeRicefwAdd()">✕</button></div>
      <div class="modal-body">
        <div class="form-row form-row-2">
          <div class="form-group"><label class="form-label">Type</label>
            <select id="rf-type"><option value="">Select…</option>${TYPES.map(t=>`<option>${t}</option>`).join("")}</select>
          </div>
          <div class="form-group"><label class="form-label">Module</label>
            <select id="rf-module"><option value="">Select…</option>${MODULES_LIST.map(m=>`<option value="${escHtml(m.value)}">${escHtml(m.label)}</option>`).join("")}</select>
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px"><label class="form-label">Object Name</label><input type="text" id="rf-name" placeholder="e.g. ZFI_GL_REPORT" /></div>
        <div class="form-row form-row-2">
          <div class="form-group"><label class="form-label">Readiness</label>
            <select id="rf-ready">${READY.map(r=>`<option>${r}</option>`).join("")}</select>
          </div>
          <div class="form-group"><label class="form-label">Transport #</label><input type="text" id="rf-transport" placeholder="e.g. DE1K900123" /></div>
        </div>
        <div class="form-group"><label class="form-label">Responsible</label><input type="text" id="rf-owner" placeholder="Owner name" /></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.closeRicefwAdd()">Cancel</button>
        <button class="btn btn-primary" onclick="APP.saveRicefw()">Add Object</button>
      </div>
    </div></div>`;
  }

  // Email modal
  if (STATE.emailModal && STATE.emailModal.open) {
    const em = STATE.emailModal;
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeEmail()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>✉ Email Owner</h2><button class="modal-close" onclick="APP.closeEmail()">✕</button></div>
      <div class="modal-body">
        <div class="form-row form-row-2">
          <div class="form-group"><label class="form-label">To (Owner)</label><input type="text" id="em-owner" value="${escHtml(em.owner||"")}" placeholder="Owner name" /></div>
          <div class="form-group"><label class="form-label">Email Address</label><input type="email" id="em-email" value="${escHtml(em.email||"")}" placeholder="owner@company.com" /></div>
        </div>
        <div class="form-group" style="margin-bottom:12px"><label class="form-label">Subject</label><input type="text" id="em-subject" value="${escHtml(em.subject||"")}" /></div>
        <div class="form-group"><label class="form-label">Message</label><textarea id="em-body" rows="6">${escHtml(em.body||"")}</textarea></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.closeEmail()">Cancel</button>
        <button class="btn btn-secondary" onclick="APP.sendEmailMailto()">Open in Mail App</button>
        <button class="btn btn-primary" onclick="APP.genEmailDraft()">✨ AI Draft</button>
      </div>
    </div></div>`;
  }

  // Link / Approval modal
  if (STATE.linkModal && STATE.linkModal.open) {
    const lm = STATE.linkModal;
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeLink()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>⧉ Link / Approval Ticket</h2><button class="modal-close" onclick="APP.closeLink()">✕</button></div>
      <div class="modal-body">
        <div class="form-group" style="margin-bottom:12px"><label class="form-label">Reference URL / Ticket #</label><input type="text" id="lm-url" value="${escHtml(lm.url||"")}" placeholder="https://jira.company.com/PROJ-123" /></div>
        <div class="form-row form-row-2">
          <div class="form-group"><label class="form-label">Approver</label><input type="text" id="lm-approver" value="${escHtml(lm.approver||"")}" placeholder="Approver name" /></div>
          <div class="form-group"><label class="form-label">Approved At</label><input type="date" id="lm-approvedAt" value="${escHtml(lm.approvedAt||"")}" /></div>
        </div>
        <div class="form-group"><label class="form-label">Note</label><input type="text" id="lm-note" value="${escHtml(lm.note||"")}" placeholder="Approval note or context" /></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="APP.closeLink()">Cancel</button>
        ${lm.url ? `<button class="btn btn-danger btn-sm" onclick="APP.clearLink()">Remove Link</button>` : ""}
        <button class="btn btn-primary" onclick="APP.saveLink()">Save</button>
      </div>
    </div></div>`;
  }

  // Side ask modal
  if (STATE.sideAskModal) {
    html += `<div class="modal-overlay" onclick="if(event.target===this)APP.closeSideAsk()">
    <div class="modal modal-md">
      <div class="modal-header"><h2>Knowledge Base Answer</h2><button class="modal-close" onclick="APP.closeSideAsk()">✕</button></div>
      <div class="modal-body">
        ${STATE.sideAskLoading ? `<div class="loader"><span class="spinner"></span> Searching knowledge base…</div>` :
          STATE.sideAskResult ? renderMarkdown(STATE.sideAskResult) : ""}
      </div>
      <div class="modal-footer"><button class="btn btn-primary" onclick="APP.closeSideAsk()">Close</button></div>
    </div></div>`;
  }

  return html;
}

// ── APP namespace (all action handlers) ──────────────────────────────
const APP = {
  nav(id) {
    STATE.tab = id;
    STATE.flt = { q:"",status:"",phase:"",ws:"",owner:"",type:"",entity:"",cp:false };
    render();
  },
  upP(k,v) { updateProject({ [k]: v }); },
  addModule() {
    const sel = document.getElementById("mod-add-sel");
    if (!sel || !sel.value) return;
    const p = gP();
    const mods = [...(p.modules||[])];
    if (!mods.includes(sel.value)) { mods.push(sel.value); updateProject({ modules: mods }); }
    sel.value = "";
  },
  removeModule(m) {
    const p = gP(); updateProject({ modules: (p.modules||[]).filter(x=>x!==m) });
  },
  showNewSession() { setState({ newSessionModal:true }); },
  closeNewSession() { setState({ newSessionModal:false }); },
  createSession() {
    const name = document.getElementById("ns-name")?.value?.trim() || "New Session";
    const approach = document.getElementById("ns-approach")?.value || "Big Bang";
    const industry = document.getElementById("ns-industry")?.value || "";
    newSession({ projectName:name, approach, industry });
    render();
  },
  switchSession(sid) { STATE.sid = sid; render(); },
  deleteSession() {
    const name = gS()?.project?.projectName || STATE.sid;
    if (!confirm(`Delete session "${name}"? All tasks in this session will be lost.`)) return;
    delete STATE.sessions[STATE.sid];
    const remaining = Object.keys(STATE.sessions);
    if (remaining.length) {
      STATE.sid = remaining[remaining.length - 1];
    } else {
      newSession({});
    }
    setState({});
  },
  clearPlan() {
    if (!confirm("Clear all tasks from this session? This cannot be undone.")) return;
    const ss = gS();
    if (!ss) return;
    ss.state.plan = { tasks:[], finalized:false };
    ss.state.l4Tasks = [];
    ss.state.planMeta = {};
    setState({});
    toast("Plan cleared — you can now re-import or regenerate.", "success");
  },
  triggerImport() { setState({ importModal:true, importErr:"", importBusy:false }); },
  closeImport()  { setState({ importModal:false }); },

  async importFile(file) {
    if (!file) return;
    setState({ importBusy:true, importErr:"" });
    try {
      let matrix;
      if (file.name.match(/\.(xlsx|xls)$/i)) {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type:"array" });
        const ws2 = wb.Sheets[wb.SheetNames[0]];
        matrix = XLSX.utils.sheet_to_json(ws2, { header:1, raw:false, defval:"" });
      } else {
        const txt = await file.text();
        matrix = txt.split("\n").map(r => r.split(/[,\t]/).map(c=>c.trim()));
      }
      this._processMatrix(matrix);
    } catch(e) {
      setState({ importBusy:false, importErr: e.message || "Parse error" });
    }
  },

  importPasted() {
    const txt = document.getElementById("l4-paste")?.value?.trim();
    if (!txt) return;
    setState({ importBusy:true, importErr:"" });
    try {
      const matrix = txt.split("\n").map(r => r.split(/[,\t]/).map(c=>c.trim()));
      this._processMatrix(matrix);
    } catch(e) {
      setState({ importBusy:false, importErr: e.message || "Parse error" });
    }
  },

  _processMatrix(matrix) {
    const s = gS();
    if (!s) { newSession({}); }
    let tasks = [];
    try {
      if (typeof looksLikeL4 === "function" && looksLikeL4(matrix) && typeof parseL4Workbook === "function") {
        // L4 format: show the user's own tasks directly; store l4Tasks for KB scope if they later hit Regenerate
        const parsed = parseL4Workbook(matrix);
        const rawL4 = (parsed.tasks || []).map(t => Object.assign({}, t,
          { workstream: t.workstream || t.category || "" }));
        const ss = gS();
        // Store raw L4 tasks for scope derivation (used by Regenerate from Library)
        if (ss) ss.state.l4Tasks = rawL4;
        // 1. Filter to Deploy/Run phases only — exclude Prepare/Explore/Realize L1 rows
        //    parseL4Workbook stores the L1 phase in t.phase; postProcessCutoverTasks overwrites it so filter first
        const _EXCL_L1 = /prepare|explore|realize|blueprint|build|\bsit\b|uat\s*(?:mgmt|milestone|sign|phase|test)?/i;
        const _KEEP_L1 = /deploy|run|go.?live|golive/i;
        tasks = rawL4.filter(t => {
          const p = String(t.phase || "").trim();
          if (!p) return true;                        // no phase column → keep
          if (_KEEP_L1.test(p)) return true;          // explicitly cutover phase → keep
          if (_EXCL_L1.test(p)) return false;         // explicitly pre-cutover → drop
          return true;                                // unknown phase value → keep
        });

        // 2. Dedup by WBS ID
        const _seenWbs = new Set();
        tasks = tasks.filter(t => {
          const key = String(t.id || "").trim();
          if (!key) return true;
          if (_seenWbs.has(key)) return false;
          _seenWbs.add(key); return true;
        });

        // 3. Apply phase/wave/priority rules and remove scope creep (EUT/KUT/UAT/PM)
        if (typeof postProcessCutoverTasks === "function") tasks = postProcessCutoverTasks(tasks);
      } else if (typeof ingestL4Plan === "function") {
        // Non-L4 format: ingestL4Plan normalizes + filters to cutover tasks
        const result = ingestL4Plan(matrix, gP());
        const rawL4 = (result.tasks || []).map(t => Object.assign({}, t,
          { workstream: t.workstream || t.category || "" }));

        // 1. Filter Prepare/Explore/Realize L1 phases — only Deploy/Run belong in cutover
        const _DEPLOY_L1 = new Set(["deploy", "run", "go-live", "golive", ""]);
        tasks = rawL4.filter(t => {
          const l1 = String(t.l1Phase || "").toLowerCase().trim();
          return !l1 || _DEPLOY_L1.has(l1);
        });

        // 2. Dedup by WBS ID — source plans sometimes have the same ID with different task content
        const _seenIds = new Set();
        tasks = tasks.filter(t => {
          const key = String(t.id || "").trim();
          if (!key) return true;
          if (_seenIds.has(key)) return false;
          _seenIds.add(key); return true;
        });

        // 3. Apply phase/wave/priority rules and remove scope creep (EUT/KUT/UAT/PM)
        if (typeof postProcessCutoverTasks === "function") tasks = postProcessCutoverTasks(tasks);

        const ss = gS();
        if (ss) {
          // Store the PRE-postProcess raw tasks for scope derivation — postProcessCutoverTasks
          // normalises workstream names which breaks deriveCutoverScopeFromL4 matching.
          ss.state.l4Tasks = rawL4;
          if (result.ricefw && result.ricefw.length) ss.state.ricefw = result.ricefw;
          if (result.inferred) {
            const inf = result.inferred;
            if (inf.cutoverStartDate) ss.project.cutoverStartDate = inf.cutoverStartDate;
            if (inf.goLiveDate)       ss.project.goLiveDate = inf.goLiveDate;
            if (inf.spanH)            ss.project.cutoverDurationH = inf.spanH;
          }
        }
      } else {
        // Raw fallback: treat each row as a task
        tasks = matrix.slice(1).filter(r=>r[0]).map((r,i) => ({
          id: `T-${String(i+1).padStart(3,"0")}`, task: r[0]||"",
          workstream: r[1]||"General", phase: r[2]||"CUT", owner: r[3]||"",
          durationH: +(r[4]||2), status:"PENDING", priority:"MEDIUM", wave:1, predecessors:[]
        }));
      }
    } catch(e) { console.error(e); tasks = []; }
    const _ss = gS();
    if (_ss) _ss.state.enrich = { locked: {} };  // clear locks — new plan imported
    updatePlan({ tasks, finalized:false });
    STATE.importModal = false;
    STATE.importBusy = false;
    STATE.tab = "tasks";
    toast(`Imported ${tasks.length} tasks`, "success");
    render();
  },

  async buildPlan() {
    const p = gP(); const s = gS();
    if (!s) { newSession({}); }
    let tasks = [];
    try {
      if (typeof buildDetailedCutover === "function") {
        const l4 = (s && s.state.l4Tasks) || [];
        const result = buildDetailedCutover(p, l4);
        tasks = result.tasks || [];
        if (typeof postProcessCutoverTasks === "function") tasks = postProcessCutoverTasks(tasks);
      } else {
        toast("Build function not available — import an L4 plan instead.", "error"); return;
      }
    } catch(e) { toast("Build error: " + e.message, "error"); return; }
    updatePlan({ tasks, finalized:false });
    STATE.tab = "tasks";
    toast(`Generated ${tasks.length} tasks`, "success");
    render();
  },

  async genBrief() {
    const btn = document.getElementById("brief-btn");
    const body = document.getElementById("brief-body");
    if (!body) return;
    body.innerHTML = `<div class="loader"><span class="spinner"></span> Generating brief…</div>`;
    const p = gP(); const tasks = gPlan().tasks || [];
    try {
      const text = await callAgent({
        key:"cutoverBrief", project_name: p.projectName||"SAP Project",
        modules: p.modules||[], task_summary: taskSummary(tasks),
        extra: `Approach:${p.approach||"Big Bang"}, Go-live:${p.goLiveDate||"TBD"}, Window:${p.cutoverDurationH||48}h`
      });
      body.innerHTML = renderMarkdown(text);
      const s = gS(); if (s) { if (!s.agents) s.agents={}; s.agents.cutoverBrief = { output:text, completedAt:new Date().toISOString() }; scheduleSave(); }
    } catch(e) { body.innerHTML = `<div class="alert alert-danger">${escHtml(e.message)}</div>`; }
  },

  setFlt(k,v) { STATE.flt = { ...STATE.flt, [k]:v }; render(); },
  clearFlt()  { STATE.flt = { q:"",status:"",phase:"",ws:"",owner:"",type:"",entity:"",cp:false }; render(); },

  cycleStatus(id) {
    const plan = gPlan();
    const t = plan.tasks.find(t=>t.id===id);
    if (!t) return;
    const idx = STATUS_CYCLE.indexOf(t.status);
    const next = STATUS_CYCLE[(idx+1) % STATUS_CYCLE.length];
    updateTask(id, { status:next });
  },

  markStart(id, val) {
    const stamp = val !== undefined ? val : nowStamp();
    const patch = { actualStart: stamp };
    // Auto-advance status to IN_PROGRESS when marking start
    if (stamp !== null) {
      const t = (gPlan().tasks||[]).find(t=>t.id===id);
      if (t && t.status==="PENDING") patch.status = "IN_PROGRESS";
    }
    updateTask(id, patch);
  },

  markEnd(id, val) {
    const stamp = val !== undefined ? val : nowStamp();
    const patch = { actualEnd: stamp };
    // Auto-advance status to COMPLETE when marking end
    if (stamp !== null) {
      const t = (gPlan().tasks||[]).find(t=>t.id===id);
      if (t && !["COMPLETE","VERIFIED"].includes(t.status)) patch.status = "COMPLETE";
    }
    updateTask(id, patch);
  },

  saveTask(id, field, value) {
    const plan = gPlan();
    const t = plan.tasks.find(t=>t.id===id);
    if (!t || t[field] === value) return;
    t[field] = value;
    scheduleSave();
  },

  deleteTask(id) { STATE.confirmDeleteId = id; render(); },
  cancelDelete() { STATE.confirmDeleteId = null; render(); },
  doDelete() {
    const id = STATE.confirmDeleteId;
    if (!id) return;
    const plan = gPlan();
    plan.tasks = plan.tasks.filter(t=>t.id!==id);
    delete STATE.aiFlag[id];
    delete STATE.selected[id];
    STATE.confirmDeleteId = null;
    scheduleSave();
    render();
    toast("Task deleted");
  },

  selectAll(checked) {
    const rows = gPlan().tasks || [];
    if (checked) rows.forEach(t => { STATE.selected[t.id] = true; });
    else STATE.selected = {};
    render();
  },
  selTask(id, checked) {
    if (checked) STATE.selected[id] = true; else delete STATE.selected[id];
    const allChk = document.getElementById("chk-all");
    const tasks = gPlan().tasks||[];
    if (allChk) allChk.indeterminate = Object.keys(STATE.selected).length > 0 && Object.keys(STATE.selected).length < tasks.length;
  },
  clearSelection() { STATE.selected = {}; render(); },
  deleteSelected() {
    const ids = Object.keys(STATE.selected);
    const plan = gPlan();
    plan.tasks = plan.tasks.filter(t=>!ids.includes(t.id));
    ids.forEach(id => { delete STATE.aiFlag[id]; delete STATE.selected[id]; });
    scheduleSave();
    render(); toast(`Deleted ${ids.length} tasks`);
  },

  finalize()      { setState({ confirmFinalize:true }); },
  cancelFinalize(){ setState({ confirmFinalize:false }); },
  doFinalize() {
    updatePlan({ finalized:true, finalizedAt:new Date().toISOString() });
    STATE.confirmFinalize = false;
    toast("Plan finalized — tracking mode active", "success");
    render();
  },
  unfinalize() {
    updatePlan({ finalized:false });
    toast("Plan unlocked — editing re-enabled", "success");
  },

  showOwnerGap()  { setState({ showOwnerGap:true }); },
  closeOwnerGap() { setState({ showOwnerGap:false }); },

  async generateFromL4() {
    const ss = gS(); if (!ss) return;
    const l4Tasks = ss.state.l4Tasks || [];
    if (!l4Tasks.length) { toast("No full L4 data found — re-import the plan file", "error"); return; }
    const p = gP();
    const wsSet = [...new Set(l4Tasks.map(t => t.workstream||"").filter(Boolean))];
    const scopeSet = [...new Set(l4Tasks.map(t => (t.scopeItem||"").trim()).filter(Boolean))];
    const btn = document.getElementById("gen-l4-btn");
    const _genStart = Date.now();
    clearInterval(_genTimer);
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Generating… 0s"; }
    _genTimer = setInterval(() => {
      if (!btn) return;
      const sec = Math.round((Date.now() - _genStart) / 1000);
      btn.textContent = `⏳ Generating… ${sec >= 60 ? Math.floor(sec/60)+"m "+sec%60+"s" : sec+"s"}`;
    }, 1000);
    try {
      const resp = await fetch(BRAIN_URL + "/api/generate-from-l4", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          project_name: p.projectName||"",
          modules: p.modules||[], industry: p.industry||"",
          scope_items: scopeSet,
          // Everything the Plan Builder collects, so generated tasks can name
          // this project's countries, company codes, systems and windows.
          project_context: {
            approach:        p.approach||"",
            cutover_start:   [p.cutoverStartDate||"", p.cutoverStartTime||""].filter(Boolean).join(" "),
            cutover_window_h:p.cutoverDurationH||0,
            go_live_date:    p.goLiveDate||"",
            downtime_start:  p.downtimeStartDate||"",
            downtime_h:      p.downtimeDurationH||0,
            countries:       p.countries||[],
            legal_entities:  p.legalEntities||[],
            source_system:   (p.systemLandscape||{}).source||"",
            target_system:   (p.systemLandscape||{}).target||"",
            middleware:      (p.systemLandscape||{}).middleware||"",
            non_sap:         (p.systemLandscape||{}).nonSap||"",
            hosting:         (p.systemLandscape||{}).hosting||"",
            project_ref:     (p.sapRef||{}).projectRef||"",
            activate_phase:  (p.sapRef||{}).activatePhase||"",
            governance:      (p.sapRef||{}).governance||"",
            waves:           (p.waves||[]).map(w=>({ scope:w.scope||"", goLiveDate:w.goLiveDate||"",
                                                     windowH:w.windowH||0, entities:w.entities||"" })),
          },
          l4_tasks: l4Tasks.map(t => ({ task: t.task||"", workstream: t.workstream||"", phase: t.phase||"", scopeItem: t.scopeItem||"" }))
        })
      });
      if (!resp.ok) throw new Error("Generate error " + resp.status);
      const data = await resp.json();
      const newTasks = (data.tasks || []).map((t, i) => ({
        id: `G-${String(i+1).padStart(3,"0")}`,
        task: t.task, workstream: (typeof normWs==="function" ? normWs(t.workstream||"Cutover") : t.workstream||"Cutover"),
        phase: t.phase||"CUT", priority: t.priority||"HIGH",
        wave: t.wave ?? 1, owner:"", durationH: t.durationH ?? (t.phase==="CUT"?4:t.phase==="HC"?8:8),
        status:"PENDING", origin:"generated",
        // server returns tasks in execution order; predIdx points at the
        // predecessor's position, and ids are assigned by that same order
        predecessors: (t.predIdx != null && t.predIdx >= 0)
          ? [`G-${String(t.predIdx+1).padStart(3,"0")}`] : [],
        assessment: t.assessment||"keep", assessmentReason: t.assessmentReason||""
      }));
      if (!newTasks.length) { toast("No tasks generated — check Claude response", "error"); return; }
      ss.state.plan = { tasks: newTasks, finalized: false };
      ss.state.enrich = {};
      STATE.enrichResult = null;
      STATE.genResult = { count: newTasks.length, ricefw: data.ricefw_count||0, bws: (data.bws||[]).join(", ")||"detected" };
      scheduleSave();
      render();
    } catch(e) {
      STATE.genResult = { error: e.message };
      render();
      toast("Generate failed: " + e.message, "error");
    } finally {
      clearInterval(_genTimer);
      if (btn) { btn.disabled = false; btn.textContent = "⚡ Generate from L4"; }
    }
  },

  async contribute() {
    const s = gS(); if (!s) return;
    const tasks = gPlan().tasks||[];
    const p = gP();
    setState({ contributeStatus:null });
    try {
      const result = await contributePlan({
        label: p.projectName||"Cutover Plan",
        modules: p.modules||[], approach: p.approach||"",
        size: p.size||"",
        tasks: tasks.map(t=>({ task:t.task, workstream:t.workstream, phase:t.phase,
          priority:t.priority, status:t.status, durationH:t.durationH, notes:t.notes||"" }))
      });
      setState({ contributeStatus: result });
      toast(result.ok ? "Plan contributed to brain" : "Contribute failed: "+result.error, result.ok?"success":"error");
    } catch(e) { setState({ contributeStatus:{ ok:false, error:e.message } }); }
  },

  async enrich() {
    const s = gS(); if (!s) return;
    const tasks = gPlan().tasks||[];
    const p = gP();
    STATE.enrichLoading = true; STATE.enrichResult = null;
    _enrichAbort = new AbortController();
    startEnrichTimer();
    render();
    try {
      // Send non-Deploy L4 tasks as context so Claude can identify RICEFW items
      // and generate transport/smoke-test pairs for each one.
      const rawL4 = (gS()?.state?.l4Tasks || []);
      const _DEPLOY_PHASE_RE = /deploy|run|go.?live/i;
      const l4Context = rawL4
        .filter(t => !_DEPLOY_PHASE_RE.test(String(t.phase||"").trim()))
        .map(t => ({ task: t.task||"", workstream: t.workstream||"", phase: t.phase||"" }))
        .slice(0, 120); // cap to keep prompt lean
      const result = await enrichPlan({
        project_name: p.projectName||"",
        modules: p.modules||[], industry: p.industry||"",
        task_summary: taskSummary(tasks),
        existing_tasks: tasks.map(t=>({ id:t.id, task:t.task, workstream:t.workstream||"", phase:t.phase||"", priority:t.priority||"MEDIUM", wave:t.wave??0 })),
        locked_assessments: {},
        include_missing: true,
        extra: p.approach||"",
        l4_context: l4Context
      }, _enrichAbort.signal);
      stopEnrichTimer();
      STATE.enrichLoading = false;
      STATE.enrichResult = result;
      // Build flagged map
      const newFlags = {};
      const flaggedIds = new Set();
      (result.flagged_tasks||[]).forEach(f => {
        newFlags[f.id] = f.reason||"Flagged by AI";
        flaggedIds.add(f.id);
      });
      STATE.aiFlag = newFlags;
      // Persist assessment on each task object so it survives page refresh
      const plan = gPlan();
      (plan.tasks||[]).forEach(t => {
        if (flaggedIds.has(t.id)) {
          t.assessment = "remove";
          t.assessmentReason = newFlags[t.id];
        } else if (!t.assessment || t.assessment === "remove") {
          // Only reset to "keep" if not previously manually set to "review"
          t.assessment = "keep";
          t.assessmentReason = "";
        }
      });
      scheduleSave();
      render();
      const brainChunks = result.brain_chunks || 0;
      const brainErr = result.brain_error || "";
      const brainNote = brainChunks > 0 ? ` · ${brainChunks} brain chunks used` : brainErr ? ` · ⚠ brain error: ${brainErr}` : " · ⚠ brain KB returned 0 chunks";
      toast(`Review complete: ${flaggedIds.size} to remove, ${(result.missing_tasks||[]).length} suggested${brainNote}`, "success");
    } catch(e) {
      stopEnrichTimer();
      STATE.enrichLoading = false;
      if (e.name !== "AbortError") toast("Enrich error: " + e.message, "error");
      render();
    }
  },

  cancelEnrich() {
    if (_enrichAbort) { _enrichAbort.abort(); _enrichAbort = null; }
    stopEnrichTimer();
    STATE.enrichLoading = false;
    toast("Review cancelled");
    render();
  },

  removeAllFlagged() {
    const plan = gPlan();
    const before = plan.tasks.length;
    plan.tasks = plan.tasks.filter(t => t.assessment !== "remove" && !STATE.aiFlag[t.id]);
    STATE.aiFlag = {};
    STATE.enrichResult = null;
    scheduleSave();
    render(); toast(`Removed ${before - plan.tasks.length} flagged tasks`);
  },

  cycleAssessment(id) {
    const ss = gS(); if (!ss) return;
    const task = (ss.state.plan?.tasks || []).find(t => t.id === id);
    if (!task) return;
    const order = ["keep", "review", "remove"];
    const cur = (task.assessment || "keep").toLowerCase();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    task.assessment = next;
    scheduleSave(); render();
    toast(`${id} verdict changed to "${next}"`, "info");
  },


  clearAssessments() {
    const plan = gPlan();
    (plan.tasks||[]).forEach(t => { delete t.assessment; delete t.assessmentReason; });
    STATE.aiFlag = {};
    STATE.enrichResult = null;
    scheduleSave();
    render(); toast("Assessments cleared");
  },

  addMissing() {
    const er = STATE.enrichResult;
    if (!er || !er.missing_tasks || !er.missing_tasks.length) return;
    const plan = gPlan();
    const tasks = plan.tasks;
    const maxNum = tasks.reduce((m,t)=>{ const n=parseInt((t.id||"").split("-").pop()); return isNaN(n)?m:Math.max(m,n); },0);
    er.missing_tasks.forEach((m,i) => {
      tasks.push({
        id: `AI-${String(maxNum+i+1).padStart(3,"0")}`,
        task: m.task, workstream: (typeof normWs==="function" ? normWs(m.workstream||"General") : m.workstream||"General"),
        phase: m.phase||"CUT", owner:"", durationH:2,
        status:"PENDING", priority:(m.priority||"MEDIUM").toUpperCase(),
        wave: m.wave ?? 1, predecessors:[], origin:"suggested",
        assessment:"keep", assessmentReason:"AI-suggested task"
      });
    });
    STATE.enrichResult = null;
    render(); toast(`Added ${er.missing_tasks.length} suggested tasks`, "success");
  },

  exportXlsx() {
    const tasks = gPlan().tasks||[];
    if (!tasks.length) { toast("No tasks to export","error"); return; }
    try {
      const header = ["#","ID","Task","Phase","Workstream","Owner","Duration (h)","Status","Priority","Predecessors","Notes","AI Assessment","Assessment Reason"];
      const s = v => { const x = (v == null || Array.isArray(v) || typeof v === "object") ? "" : v; return String(x); };
      const n = v => { const x = Number(v); return isFinite(x) ? x : 0; };
      const fmtAssess = a => a === "keep" ? "✓ Keep" : a === "remove" ? "✕ Remove" : a === "review" ? "⚠ Review" : "";
      const rows = tasks.map((t,i)=>[i+1, s(t.id), s(t.task), s(t.phase), s(t.workstream), s(t.owner), n(t.durationH), s(t.status||"PENDING"), s(t.priority||"MEDIUM"), (t.predecessors||[]).join(", "), s(t.notes), fmtAssess(t.assessment), s(t.assessmentReason)]);
      const wb = XLSX.utils.book_new();
      const ws2 = XLSX.utils.aoa_to_sheet([header,...rows]);
      XLSX.utils.book_append_sheet(wb, ws2, "Tasks");
      const buf = XLSX.write(wb,{bookType:"xlsx",type:"array"});
      safeDownload(new Blob([buf],{type:"application/octet-stream"}),"cutover-task-plan.xlsx");
      toast("Exported","success");
    } catch(e) { toast("Export error: "+e.message,"error"); }
  },

  exportCsv() {
    const tasks = gPlan().tasks||[];
    if (!tasks.length) { toast("No tasks to export","error"); return; }
    const header = ["ID","Task","Phase","Workstream","Owner","Duration(h)","Status","Priority","Notes"];
    const esc = v => '"'+String(v||"").replace(/"/g,'""')+'"';
    const csv = [header.map(esc).join(","), ...tasks.map(t=>[t.id,t.task,t.phase,t.workstream,t.owner||"",t.durationH||0,t.status,t.priority||"MEDIUM",t.notes||""].map(esc).join(","))].join("\n");
    safeDownload(new Blob([csv],{type:"text/csv"}),"cutover-runsheet.csv");
    toast("CSV exported","success");
  },

  toggleAgent(key) {
    STATE.agentExpanded = { ...STATE.agentExpanded, [key]:!STATE.agentExpanded[key] };
    render();
  },

  async runAgent(key) {
    const s = gS();
    if (!s) { toast("No active session — create one first.", "error"); return; }
    const tasks = s ? (s.state.plan.tasks||[]) : [];
    const p = gP();
    STATE.agentRunning = key;
    if (!STATE.agentExpanded[key]) STATE.agentExpanded[key] = true;
    render();
    try {
      const text = await callAgent({
        key, project_name: p.projectName||"SAP Project",
        modules: p.modules||[], task_summary: taskSummary(tasks),
        extra: `Approach:${p.approach||"Big Bang"}`
      });
      STATE.agentRunning = null;
      if (!s.agents) s.agents = {};
      s.agents[key] = { output:text, completedAt:new Date().toISOString() };
      scheduleSave(); render();
      toast(key.replace(/([A-Z])/g," $1").trim()+" complete","success");
    } catch(e) {
      STATE.agentRunning = null;
      toast("Agent error: "+e.message,"error"); render();
    }
  },

  copyAgent(key) {
    const s = gS();
    const out = s && s.agents && s.agents[key] ? s.agents[key].output : "";
    if (out) { navigator.clipboard.writeText(out).then(()=>toast("Copied","success")); }
  },

  async runWhatIf() {
    const q = document.getElementById("whatif-inp")?.value?.trim();
    if (!q) { toast("Enter a scenario first","error"); return; }
    STATE.whatIfQ = q; STATE.whatIfText = ""; STATE.whatIfLoading = true; render();
    const p = gP(); const tasks = gPlan().tasks||[];
    try {
      const text = await callAgent({ key:"whatIf", project_name:p.projectName||"", modules:p.modules||[], task_summary:taskSummary(tasks), extra:q });
      STATE.whatIfLoading = false; STATE.whatIfText = text; render();
    } catch(e) { STATE.whatIfLoading = false; toast("Error: "+e.message,"error"); render(); }
  },

  kbFilePick(files) {
    STATE.kbPendingFiles = Array.from(files||[]); render();
  },

  async kbUpload() {
    const files = STATE.kbPendingFiles || [];
    if (!files.length) return;
    STATE.kbUploadBusy = true; render();
    try {
      const encoded = await Promise.all(files.map(f => new Promise((res,rej)=>{
        const r = new FileReader();
        r.onload = e => res({ name:f.name, ext:f.name.split(".").pop().toLowerCase(), base64: e.target.result.split(",")[1] });
        r.onerror = rej;
        r.readAsDataURL(f);
      })));
      const result = await kbUpload({ files:encoded, industry:STATE.kbIndustry||"",
                                      scrub:true, client_names:STATE.kbClientNames||"" });
      if (result.ok) {
        const poll = setInterval(async()=>{
          try {
            const st = await kbStatus(result.jobId);
            if (st.done || st.status==="done") {
              clearInterval(poll);
              STATE.kbUploadBusy = false;
              STATE.kbUploadResult = { ok:true, chunks: st.result ? st.result.chunks : "?" };
              STATE.kbPendingFiles = [];
              render(); toast("Indexed successfully","success");
            }
          } catch(e2) { clearInterval(poll); STATE.kbUploadBusy=false; render(); }
        }, 2000);
      } else {
        STATE.kbUploadBusy = false;
        toast("Upload error: "+(result.error||"unknown"),"error"); render();
      }
    } catch(e) {
      STATE.kbUploadBusy = false; toast("Upload error: "+e.message,"error"); render();
    }
  },

  kbReset() {
    STATE.kbUploadResult = null; STATE.kbPendingFiles = []; render();
  },

  async kbSend() {
    const inp = document.getElementById("kb-inp");
    const q = inp ? inp.value.trim() : STATE.kbInput.trim();
    if (!q) return;
    STATE.kbMessages = [...STATE.kbMessages, { role:"user", text:q }];
    STATE.kbInput = ""; STATE.kbLoading = true; render();
    try {
      const d = await askBrain(q, 8);
      STATE.kbMessages = [...STATE.kbMessages, { role:"assistant", text:d.answer||"No answer found.", sources:d.sources||[] }];
      STATE.kbLoading = false; render();
      const chat = document.getElementById("kb-chat");
      if (chat) chat.scrollTop = chat.scrollHeight;
    } catch(e) {
      STATE.kbMessages = [...STATE.kbMessages, { role:"assistant", text:"Error: "+e.message, sources:[] }];
      STATE.kbLoading = false; render();
    }
  },

  async sideAsk() {
    const inp = document.getElementById("side-ask-inp");
    const q = inp ? inp.value.trim() : STATE.sideAskQ.trim();
    if (!q) return;
    STATE.sideAskQ = q; STATE.sideAskLoading = true; STATE.sideAskModal = true; STATE.sideAskResult = null;
    render();
    try {
      const d = await askBrain(q, 6);
      STATE.sideAskLoading = false; STATE.sideAskResult = d.answer||"No answer found."; render();
    } catch(e) {
      STATE.sideAskLoading = false; STATE.sideAskResult = "Error: "+e.message; render();
    }
  },
  closeSideAsk() { STATE.sideAskModal = false; render(); },

  fixTask(id) {
    const tasks = gPlan().tasks||[];
    const t = tasks.find(t=>t.id===id);
    if (!t) return;
    STATE.fixTask = t; STATE.fixText = ""; STATE.fixLoading = true;
    render();
    const p = gP();
    callAgent({ key:"taskBlocker", project_name:p.projectName||"", modules:p.modules||[], task_summary:"", extra:"Blocked task: "+t.task })
      .then(text=>{ STATE.fixLoading=false; STATE.fixText=text; render(); })
      .catch(e=>{ STATE.fixLoading=false; STATE.fixText="Error: "+e.message; render(); });
  },
  closeFix() { STATE.fixTask=null; STATE.fixText=""; render(); },

  showRicefwAdd() { STATE.showRicefwAdd=true; render(); },
  closeRicefwAdd(){ STATE.showRicefwAdd=false; render(); },
  saveRicefw() {
    const type = document.getElementById("rf-type")?.value;
    const name = document.getElementById("rf-name")?.value?.trim();
    if (!name) { toast("Object name required","error"); return; }
    const s = gS(); if (!s) return;
    if (!s.state.ricefw) s.state.ricefw=[];
    s.state.ricefw.push({
      type: document.getElementById("rf-type")?.value||"",
      name,
      module: document.getElementById("rf-module")?.value||"",
      readiness: document.getElementById("rf-ready")?.value||"Not Started",
      transport: document.getElementById("rf-transport")?.value||"",
      responsible: document.getElementById("rf-owner")?.value||"",
    });
    STATE.showRicefwAdd=false; scheduleSave(); render(); toast("Object added","success");
  },
  deleteRicefw(i) {
    const s=gS(); if(!s||!s.state.ricefw) return;
    s.state.ricefw.splice(i,1); scheduleSave(); render();
  },

  // -- Integrations --
  showIntegAdd()  { STATE.showIntegAdd=true;  render(); },
  closeIntegAdd() { STATE.showIntegAdd=false; render(); },
  saveInteg() {
    const name=document.getElementById("in-name")?.value?.trim();
    if(!name){toast("Interface name required","error");return;}
    const s=gS(); if(!s)return;
    if(!s.state.interfaces) s.state.interfaces=[];
    s.state.interfaces.push({
      name, type:document.getElementById("in-type")?.value||"",
      source:document.getElementById("in-source")?.value||"",
      target:document.getElementById("in-target")?.value||"",
      middleware:document.getElementById("in-mw")?.value||"",
      owner:document.getElementById("in-owner")?.value||"",
      readiness:"Not Started", testStatus:"Not Tested"
    });
    STATE.showIntegAdd=false; scheduleSave(); render(); toast("Interface added","success");
  },
  updateInteg(i,field,value) {
    const s=gS(); if(!s||!s.state.interfaces) return;
    if(s.state.interfaces[i]) s.state.interfaces[i][field]=value;
    scheduleSave();
  },
  deleteInteg(i) {
    const s=gS(); if(!s||!s.state.interfaces) return;
    s.state.interfaces.splice(i,1); scheduleSave(); render();
  },

  // -- Training --
  showTrainingAdd()  { STATE.showTrainingAdd=true;  render(); },
  closeTrainingAdd() { STATE.showTrainingAdd=false; render(); },
  saveTraining() {
    const role=document.getElementById("tr-role")?.value?.trim();
    if(!role){toast("Role name required","error");return;}
    const s=gS(); if(!s)return;
    if(!s.state.training) s.state.training=[];
    s.state.training.push({
      role, system:document.getElementById("tr-system")?.value||"",
      method:document.getElementById("tr-method")?.value||"eLearning",
      trainer:document.getElementById("tr-trainer")?.value||"",
      scheduledDate:document.getElementById("tr-date")?.value||"",
      completion:0, status:"Not Started"
    });
    STATE.showTrainingAdd=false; scheduleSave(); render(); toast("Training role added","success");
  },
  updateTraining(i,field,value) {
    const s=gS(); if(!s||!s.state.training) return;
    if(s.state.training[i]) s.state.training[i][field]=value;
    scheduleSave();
  },
  deleteTraining(i) {
    const s=gS(); if(!s||!s.state.training) return;
    s.state.training.splice(i,1); scheduleSave(); render();
  },

  // -- Approvals --
  showApprovalAdd()  { STATE.showApprovalAdd=true;  render(); },
  closeApprovalAdd() { STATE.showApprovalAdd=false; render(); },
  saveApproval() {
    const gate=document.getElementById("ap-gate")?.value?.trim();
    if(!gate){toast("Gate name required","error");return;}
    const s=gS(); if(!s)return;
    if(!s.state.approvals) s.state.approvals=[];
    s.state.approvals.push({
      gate, approver:document.getElementById("ap-approver")?.value||"",
      date:document.getElementById("ap-date")?.value||"",
      notes:document.getElementById("ap-notes")?.value||"",
      status:"Pending"
    });
    STATE.showApprovalAdd=false; scheduleSave(); render(); toast("Gate added","success");
  },
  updateApproval(i,field,value) {
    const s=gS(); if(!s||!s.state.approvals) return;
    if(s.state.approvals[i]) s.state.approvals[i][field]=value;
    scheduleSave(); render();
  },
  deleteApproval(i) {
    const s=gS(); if(!s||!s.state.approvals) return;
    s.state.approvals.splice(i,1); scheduleSave(); render();
  },

  // -- Email --
  openEmail(id) {
    const t=(gPlan().tasks||[]).find(t=>t.id===id);
    const p=gP();
    const ownerEmails=p.ownerEmails||{};
    const owner=t?t.owner||"":"";
    const email=ownerEmails[owner]||"";
    const subject=t?`Action Required: ${t.task} [Cutover Task ${t.id}]`:"";
    const body=t?`Dear ${owner||"Team"},\n\nThis is a reminder that the following cutover task requires your attention:\n\nTask: ${t.task}\nPhase: ${t.phase}\nWorkstream: ${t.workstream}\nDuration: ${t.durationH}h\nStatus: ${t.status}\n\nPlease confirm readiness or raise blockers immediately.\n\nRegards,\n${p.projectName||"SAP Cutover Team"}`:"";
    STATE.emailModal={ open:true, taskId:id, owner, email, subject, body };
    render();
  },
  closeEmail() { STATE.emailModal={ open:false, taskId:null, owner:"", email:"", subject:"", body:"" }; render(); },
  sendEmailMailto() {
    const em=STATE.emailModal;
    const to=document.getElementById("em-email")?.value||em.email;
    const sub=encodeURIComponent(document.getElementById("em-subject")?.value||em.subject);
    const body=encodeURIComponent(document.getElementById("em-body")?.value||em.body);
    window.location.href=`mailto:${to}?subject=${sub}&body=${body}`;
  },
  async genEmailDraft() {
    const em=STATE.emailModal;
    const p=gP();
    const t=(gPlan().tasks||[]).find(t=>t.id===em.taskId);
    if(!t)return;
    try {
      const text=await callAgent({key:"taskBlocker",project_name:p.projectName||"",modules:p.modules||[],task_summary:"",extra:`Draft a professional email to ${em.owner||"the owner"} about their cutover task: ${t.task}. Phase: ${t.phase}, Status: ${t.status}`});
      const bodyEl=document.getElementById("em-body");
      if(bodyEl) bodyEl.value=text;
      STATE.emailModal.body=text;
      toast("Draft generated","success");
    } catch(e){toast("AI draft error: "+e.message,"error");}
  },

  // -- Link / Approval Ticket --
  openLink(id) {
    const t=(gPlan().tasks||[]).find(t=>t.id===id);
    const ref=t?(t.externalRef||{}):{};
    STATE.linkModal={ open:true, taskId:id, url:ref.url||"", note:ref.note||"", approver:ref.approver||"", approvedAt:ref.approvedAt||"" };
    render();
  },
  closeLink() { STATE.linkModal={ open:false, taskId:null, url:"", note:"", approver:"", approvedAt:"" }; render(); },
  clearLink() {
    const id=STATE.linkModal.taskId;
    if(id) updateTask(id,{externalRef:{}});
    this.closeLink();
  },
  saveLink() {
    const id=STATE.linkModal.taskId;
    const url=document.getElementById("lm-url")?.value||"";
    const approver=document.getElementById("lm-approver")?.value||"";
    const approvedAt=document.getElementById("lm-approvedAt")?.value||"";
    const note=document.getElementById("lm-note")?.value||"";
    if(id) updateTask(id,{externalRef:{url,approver,approvedAt,note}});
    this.closeLink();
    toast("Link saved","success");
  },

  // -- Dress Rehearsal --
  updateRehearsal(key,field,value) {
    const s=gS(); if(!s)return;
    if(!s.state.rehearsal) s.state.rehearsal={};
    if(!s.state.rehearsal[key]) s.state.rehearsal[key]={};
    s.state.rehearsal[key][field]=value;
    scheduleSave();
  },

  // -- System Landscape / Input fields --
  upLandscape(field,value) {
    const p=gP();
    const sl=Object.assign({},p.systemLandscape||{},{[field]:value});
    updateProject({systemLandscape:sl});
  },
  upSapRef(field,value) {
    const p=gP();
    const sr=Object.assign({},p.sapRef||{},{[field]:value});
    updateProject({sapRef:sr});
  },

  // -- Owner Emails --
  addOwnerEmail() {
    const name=document.getElementById("oe-name")?.value?.trim();
    const email=document.getElementById("oe-email")?.value?.trim();
    if(!name||!email){toast("Name and email required","error");return;}
    const p=gP();
    const oe=Object.assign({},p.ownerEmails||{},{[name]:email});
    updateProject({ownerEmails:oe});
    const n=document.getElementById("oe-name"); if(n) n.value="";
    const e=document.getElementById("oe-email"); if(e) e.value="";
  },
  upOwnerEmail(name,email) {
    const p=gP();
    const oe=Object.assign({},p.ownerEmails||{},{[name]:email});
    updateProject({ownerEmails:oe});
  },
  removeOwnerEmail(name) {
    const p=gP();
    const oe=Object.assign({},p.ownerEmails||{});
    delete oe[name];
    updateProject({ownerEmails:oe});
  },
  autoMatchOwners() {
    const tasks=gPlan().tasks||[];
    const p=gP();
    const oe=Object.assign({},p.ownerEmails||{});
    let added=0;
    tasks.forEach(t=>{if(t.owner&&t.owner.trim()&&!oe[t.owner]){oe[t.owner]="";added++;}});
    updateProject({ownerEmails:oe});
    toast(added>0?`Auto-matched ${added} owners — add their emails`:"All owners already matched","success");
  },

  // -- Wave Plan --
  addWave() {
    const p=gP();
    const waves=[...(p.waves||[]),{scope:"",goLiveDate:"",windowH:48,entities:""}];
    updateProject({waves});
  },
  updateWave(i,field,value) {
    const p=gP();
    const waves=[...(p.waves||[])];
    if(waves[i]) waves[i][field]=value;
    updateProject({waves});
  },
  deleteWave(i) {
    const p=gP();
    const waves=[...(p.waves||[])];
    waves.splice(i,1);
    updateProject({waves});
  },
};

// Make STATE global for inline event handlers that reference it
window.STATE = STATE;
window.APP = APP;

// ── Initialization ────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Load from localStorage
  const stored = loadStore();
  STATE.sessions = stored.sessions || {};
  STATE.sid      = stored.sid || null;
  STATE.loaded   = true;

  // One-time wave correction for stored sessions: CUT phase waves must be recomputed
  // from task name, not preserved from source (source files use 0-indexed waves that
  // collide with PRE numbering). Apply the same logic as postProcessCutoverTasks.
  Object.values(STATE.sessions).forEach(sess => {
    const tasks = (sess.state && sess.state.plan && sess.state.plan.tasks) || [];
    tasks.forEach(t => {
      if (t.phase === "CUT") {
        if (typeof _HC_TASK_RE !== "undefined" && _HC_TASK_RE.test(t.task || "")) {
          t.phase = "HC"; t.wave = 2;
        } else if (typeof _CUT_PREP_RE !== "undefined") {
          t.wave = _CUT_PREP_RE.test(t.task || "") ? 0 : 1;
        }
      }
    });
  });

  // If no session, prompt new session or auto-create
  if (!STATE.sid || !STATE.sessions[STATE.sid]) {
    if (Object.keys(STATE.sessions).length > 0) {
      STATE.sid = Object.keys(STATE.sessions)[0];
    } else {
      newSession({ projectName:"SAP Cutover Project" });
    }
  }

  // Initial render
  render();

  // Brain status poll
  startBrainPoll();
});
