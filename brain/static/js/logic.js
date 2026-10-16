// SAP Cutover Agent — Business Logic (extracted from App.jsx)
// All pure JS: constants, parsers, schedulers, coverage analysers
// XLSX is expected as a global (loaded via script tag)
"use strict";

// ─── Constants ───────────────────────────────────────────────────
const STORE_KEY = "sap_cc_v3";

const C = {
  bg: "#f1f5f9", surface: "#ffffff", hi: "#f8fafc",
  border: "#e2e8f0", text: "#0f172a", muted: "#64748b",
  accent: "#A100FF", accentHi: "#8B00E0",
  green: "#16a34a", greenHi: "#15803d",
  amber: "#b45309", amberHi: "#92400e",
  red: "#dc2626", redHi: "#b91c1c",
  headerBg: "#160040", headerText: "#ffffff",
};

const PHASE_COLORS = {
  PRE:  { bg: "#dbeafe", fg: "#1d4ed8" },
  CUT:  { bg: "#fef3c7", fg: "#b45309" },
  POST: { bg: "#dcfce7", fg: "#15803d" },
  RAMP: { bg: "#ede9fe", fg: "#7c3aed" },
};

const STATUS = {
  PENDING:     { bg: "#f1f5f9", fg: "#64748b", label: "Pending" },
  IN_PROGRESS: { bg: "#dbeafe", fg: "#1d4ed8", label: "In Progress" },
  COMPLETE:    { bg: "#dcfce7", fg: "#16a34a", label: "Complete" },
  VERIFIED:    { bg: "#d1fae5", fg: "#059669", label: "Verified" },
  BLOCKED:     { bg: "#fee2e2", fg: "#dc2626", label: "Blocked" },
  SKIPPED:     { bg: "#f1f5f9", fg: "#94a3b8", label: "Skipped" },
};
const STATUS_CYCLE = ["PENDING", "IN_PROGRESS", "COMPLETE", "BLOCKED", "VERIFIED"];

// Industry vertical — drives industry-specific task filtering (generation) + Enrich context (brain).
// Add L4 industry tasks to KB_ACTIVITIES with e.g. ind:["utilities"]; untagged tasks are universal.
const INDUSTRIES = [
  { k: "",             label: "Cross-industry (all)" },
  { k: "utilities",    label: "Utilities" },
  { k: "consumer",     label: "Consumer Goods / Retail" },
  { k: "manufacturing",label: "Manufacturing" },
  { k: "lifesciences", label: "Life Sciences / Pharma" },
  { k: "publicsector", label: "Public Sector" },
  { k: "oilgas",       label: "Oil & Gas / Energy" },
  { k: "financial",    label: "Financial Services" },
  { k: "automotive",   label: "Automotive" },
];

// Shared table cell styles (used across Task Plan, Input, Coverage tables)
const thStyle = { padding: "9px 12px", textAlign: "left", color: "#64748b", fontWeight: 700, fontSize: 10, letterSpacing: "0.07em", textTransform: "uppercase", background: "#f9fafb", borderBottom: `2px solid #e2e8f0`, whiteSpace: "nowrap", position: "sticky", top: 0 };
const tdStyle = { padding: "8px 12px", borderBottom: `1px solid #f0f0f4` };

const PHASES = ["PRE", "CUT", "HC"];   // canonical task phases — matches generator & normaliser (SIM runs live on lifecycle)
const READINESS = ["NOT_STARTED","IN_DEVELOPMENT","UNIT_TEST","TRANSPORT_CREATED","TRANSPORT_RELEASED","INT_TEST","UAT_SIGNED","PROD_READY"];
const READINESS_COLOR = { NOT_STARTED: C.muted, IN_DEVELOPMENT: C.amberHi, UNIT_TEST: C.amberHi, TRANSPORT_CREATED: C.accentHi, TRANSPORT_RELEASED: C.accentHi, INT_TEST: C.accentHi, UAT_SIGNED: C.greenHi, PROD_READY: C.greenHi };
const AGENTS_LIST = [
  { key: "waveOrchestration", label: "Wave Orchestrator",   desc: "Sequences all cutover waves, validates phase dependencies, and recommends the optimal execution order across workstreams." },
  { key: "readiness",         label: "Readiness Assessor",  desc: "Evaluates go-live readiness across all workstreams against SAP Activate criteria and surfaces gaps requiring action." },
  { key: "goNoGo",            label: "Go/No-Go Judge",      desc: "Makes the final AI go-live recommendation with a confidence score and evidence-based rationale grounded in SAP methodology." },
  { key: "riskMitigation",    label: "Risk & Mitigation",   desc: "Identifies the top cutover risks by severity and generates SAP-grounded mitigation and contingency plans." },
  { key: "rollbackPlan",      label: "Rollback Planner",    desc: "Generates a phase-by-phase rollback strategy with decision triggers, ownership assignments, and recovery timelines." },
  { key: "executiveReport",   label: "Executive Report",    desc: "Produces a sponsor-ready executive summary of cutover status, confidence level, and go-live recommendation." },
  { key: "dataValidation",    label: "Data Validation",     desc: "Verifies data migration completeness, reconciliation status, and cutover data quality risks." },
  { key: "ricefw",            label: "RICEFW Agent",        desc: "Assesses custom development object readiness, testing gaps, and transport status risks." },
  { key: "commandCenter",     label: "Command Center",      desc: "Reviews live execution status, flags active blockers, and produces a real-time cutover war-room narrative." },
  { key: "retrospective",     label: "Retrospective",       desc: "Captures lessons learned, compares actuals vs plan, and generates reusable improvement recommendations." },
  { key: "hypercare",         label: "Hypercare Planner",   desc: "Designs the post go-live hypercare model: support schedule, escalation framework, war-room roster, and stabilisation KPIs." },
];

// ═══════════════════════════════════════════════════════════════════
// PURE CORE START  —  vanilla JS only (no React / DOM / browser globals).
// Everything between the START/END markers is deterministic and unit-tested
// by tests/core.test.mjs (extracted verbatim via tests/extract-core.mjs).
// Do NOT add React, window, document, or fetch references in this block.
// ═══════════════════════════════════════════════════════════════════

// Canonical task-level phases. (SIM1/SIM2 are simulation *runs*, not task
// phases — they live on lifecycle, not on task.phase. This keeps the
// generator, normaliser and the Task Plan filter in agreement.)
const CORE_PHASES   = ["PRE", "CUT", "HC"];
const CORE_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETE", "VERIFIED", "BLOCKED", "SKIPPED"];
const CORE_PRIORITY = ["HIGH", "MEDIUM", "LOW"];
const DONE_STATUSES = ["COMPLETE", "VERIFIED"];

function uid() { return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6); }

function fmtDur(h) {
  h = Number(h) || 0;
  const hr = Math.floor(h), mn = Math.round((h - hr) * 60);
  if (hr > 0 && mn > 0) return `${hr}h ${mn}m`;
  if (hr > 0) return `${hr}h`;
  if (mn > 0) return `${mn}m`;
  return "–";
}

// --- Tolerant JSON extraction & parsing --------------------------------
// LLM output is unreliable: it may or may not fence the JSON, may wrap it in
// prose, and (because per-call max_tokens is small) may be TRUNCATED mid-array.
// extractJsonBlock finds the JSON payload; parseTasksTolerant salvages every
// complete task object even when the array is cut off before its closing ].

function extractJsonBlock(text) {
  if (!text || typeof text !== "string") return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  return text.slice(start).trim();
}

// Walk a possibly-truncated JSON string and return every top-level object
// inside the first array (or the objects of a bare object), tolerating an
// unterminated final object. Never throws.
function salvageObjects(jsonish) {
  const out = [];
  if (!jsonish) return out;
  const s = jsonish;
  let i = 0;
  // find first '[' if present, else treat whole thing as object stream
  const arrIdx = s.indexOf("[");
  const objIdx = s.indexOf("{");
  if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) i = arrIdx + 1;
  while (i < s.length) {
    while (i < s.length && s[i] !== "{") i++;
    if (i >= s.length) break;
    let depth = 0, inStr = false, esc = false, startObj = i;
    let closed = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { i++; closed = true; break; } }
      }
    }
    if (closed) {
      const chunk = s.slice(startObj, i);
      try { out.push(JSON.parse(chunk)); } catch (e) { /* skip malformed */ }
    } else {
      break; // truncated final object — stop cleanly
    }
  }
  return out;
}

// Returns an array of raw task objects from arbitrary model text. Order:
//  1) strict parse of the extracted block (handles the happy path + {"tasks":[…]})
//  2) salvage of complete objects (handles truncation / trailing prose)
function parseTasksTolerant(text) {
  const block = extractJsonBlock(text);
  if (!block) return [];
  try {
    const parsed = JSON.parse(block);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch (e) { /* fall through to salvage */ }
  return salvageObjects(block);
}

// --- Normalisation -----------------------------------------------------
// Coerce whatever the model returned into the shape the UI/engines rely on.
// Guarantees: unique id, whitelisted phase/status/priority, numeric duration,
// predecessors remapped to the (possibly rewritten) ids WITHIN this batch.

function up(v, fallback, set) {
  const u = String(v == null ? "" : v).toUpperCase().trim().replace(/[\s-]+/g, "_");
  return set.includes(u) ? u : fallback;
}

function normalizeTasks(rawArr, opts = {}) {
  const prefix = opts.prefix ? String(opts.prefix) : "";
  const arr = Array.isArray(rawArr) ? rawArr : [];
  const idMap = {};            // original id  -> new id (for predecessor remap)
  const tasks = arr.map((raw, idx) => {
    const r = raw && typeof raw === "object" ? raw : {};
    const n = idx + 1;
    const newId = (prefix ? prefix + "-" : "") + "T" + String(n).padStart(3, "0");
    if (r.id != null && r.id !== "") idMap[String(r.id)] = newId;
    let dur = Number(r.durationH != null ? r.durationH : r.duration);
    if (!isFinite(dur) || dur < 0) dur = 1;
    return {
      id: newId,
      task: String(r.task || r.name || "Untitled task").slice(0, 400),
      phase: up(r.phase, "PRE", CORE_PHASES),
      category: r.category ? String(r.category) : "",
      workstream: r.workstream ? String(r.workstream) : "Other",
      owner: r.owner ? String(r.owner) : "",
      durationH: dur,
      status: up(r.status, "PENDING", CORE_STATUSES),
      priority: up(r.priority, "MEDIUM", CORE_PRIORITY),
      predecessors: Array.isArray(r.predecessors) ? r.predecessors.map(String) : [],
      notes: r.notes ? String(r.notes) : "",
    };
  });
  // remap predecessors to rewritten ids; drop unresolved refs
  tasks.forEach(t => {
    t.predecessors = t.predecessors.map(p => idMap[p]).filter(Boolean);
  });
  return tasks;
}

// Combine batches (e.g. one per phase) into one plan with globally-unique,
// re-sequenced ids. Predecessors are remapped across the merge so intra-plan
// links survive renumbering.
function mergeTaskBatches(batches) {
  const flat = [];
  (batches || []).forEach(b => { if (Array.isArray(b)) flat.push(...b); });
  const idMap = {};
  const merged = flat.map((t, idx) => {
    const newId = "T" + String(idx + 1).padStart(3, "0");
    idMap[t.id] = newId;
    return { ...t, id: newId };
  });
  merged.forEach(t => { t.predecessors = (t.predecessors || []).map(p => idMap[p]).filter(Boolean); });
  return merged;
}

// --- Rollups / filters / export (extracted from the components) --------
function isDone(t) { return DONE_STATUSES.includes(t.status); }

function computeKpis(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const total = list.length;
  const done  = list.filter(isDone).length;
  const prog  = list.filter(t => t.status === "IN_PROGRESS").length;
  const blk   = list.filter(t => t.status === "BLOCKED").length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  return { total, done, prog, blk, pct };
}

function computeWorkstreamRollup(tasks, limit = 10) {
  const map = {};
  (tasks || []).forEach(t => {
    const w = t.workstream || "Other";
    map[w] = map[w] || { done: 0, total: 0, blocked: 0 };
    map[w].total++;
    if (isDone(t)) map[w].done++;
    if (t.status === "BLOCKED") map[w].blocked++;
  });
  return Object.entries(map).sort((a, b) => b[1].total - a[1].total).slice(0, limit);
}

function computePhaseRollup(tasks) {
  const map = {};
  (tasks || []).forEach(t => {
    const ph = t.phase || "OTHER";
    map[ph] = map[ph] || { done: 0, total: 0 };
    map[ph].total++;
    if (isDone(t)) map[ph].done++;
  });
  return map;
}

function filterTasks(tasks, flt) {
  const f = flt || {};
  const q = (f.q || "").toLowerCase();
  return (tasks || []).filter(t => {
    if (f.status && f.status !== "ALL" && t.status !== f.status) return false;
    if (f.phase  && f.phase  !== "ALL" && t.phase  !== f.phase)  return false;
    if (f.ws     && f.ws     !== "ALL" && t.workstream !== f.ws)  return false;
    if (q && !(t.task || "").toLowerCase().includes(q) && !(t.id || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

function csvCell(v) { return `"${String(v == null ? "" : v).replace(/"/g, '""')}"`; }

function buildRunsheetCsv(tasks) {
  const hdr = ["ID","Task","Phase","Workstream","Owner","Duration(h)","Status","Priority","Notes"];
  const rows = (tasks || []).map(t =>
    [t.id, t.task, t.phase, t.workstream, t.owner, t.durationH, t.status, t.priority, t.notes].map(csvCell).join(",")
  );
  return [hdr.join(","), ...rows].join("\n");
}

// Richer runsheet as an array-of-arrays (header + rows) — used for XLSX export.
function buildRunsheetMatrix(tasks) {
  const hdr = ["ID", "Task", "Phase", "Workstream", "Type", "Owner", "Entity", "Duration (h)", "Scheduled Start", "Scheduled End", "Actual Start", "Actual End", "Variance", "Status", "Priority", "Depends On", "Notes"];
  const rows = (tasks || []).map(t => {
    const v = taskVariance(t);
    const varTxt = v.status === "planned" ? "" : v.status === "late" ? ("+" + (v.delayH || 0) + "h late") : v.status === "late_start" ? ("+" + (v.startDeltaH || 0) + "h late start") : v.status === "early" ? ((v.endDeltaH || 0) + "h early") : v.status === "on_time" ? "on time" : v.status === "in_progress" ? "in progress" : v.status;
    return [
      t.id || "", t.task || "", t.phase || "", t.workstream || "",
      workstreamMeta(t.workstream).type, t.owner || "", t.entity || "",
      t.durationH != null ? t.durationH : "", t.scheduledStart || "", t.scheduledEnd || "",
      (t.actualStart || "").replace("T", " "), (t.actualEnd || "").replace("T", " "), varTxt,
      t.status || "", t.priority || "", (t.predecessors || []).join(" "), t.notes || "",
    ];
  });
  return [hdr, ...rows];
}

// ─── SAP Cutover Knowledge Base (grounding corpus) ───────────────────
// Seeded from the SAP Activate cutover accelerators — S4H_403 Cutover
// Template, FP_45 Cutover Strategy, S4H_747 Remote Cutover — and the
// activity-level dependency library. Durations are ILLUSTRATIVE planning
// seeds only (≈Medium size). SAP publishes no activity-level durations;
// they MUST be measured and refined through ≥3 dress rehearsals. Every
// activity carries an owner and Finish-to-Start dependencies.
const KB_DURATION_BASIS = "Illustrative planning seeds (≈Medium). Not SAP-prescribed — refine via ≥3 dress rehearsals.";

const KB_STREAMS = {
  TECH: "Infrastructure & Technical Readiness",
  CONF: "Transport & Configuration Activation",
  SEC:  "Security & Authorizations",
  LEG:  "Legacy Freeze & Closing",
  DM:   "Data Migration",
  INT:  "Integration Activation",
  BTP:  "BTP Side-by-Side Extensions",
  RICE: "RICEFW Validation",
  GONG: "Go/No-Go & Ramp-Up",
};

// Implementation-size model (indicative — SAP publishes no fixed S/M/L table).
// window_h = representative cutover window; mult scales baseline durations.
const KB_SIZES = {
  S: { key:"S", label:"Small",  window_h:48,  mult:0.7, rehearsals:3, criteria:"Single country · 1–3 scope clusters · <100K master records · minimal extensions · 1–2 integrations" },
  M: { key:"M", label:"Medium", window_h:72,  mult:1.0, rehearsals:3, criteria:"2–5 countries · 4–8 clusters · moderate volume · several integrations · key-user extensibility · BTP apps" },
  L: { key:"L", label:"Large",  window_h:120, mult:1.5, rehearsals:4, criteria:"Multi-country/multi-wave · 8+ clusters · high volume · developer extensibility (3SL) · multiple BTP · complex integrations" },
};

// Hard sequencing rules (SAP Activate). mode "barrier" = every `before` must
// FINISH before any `after` STARTS; mode "structural" = every `after` must
// transitively depend on some `before`.
const KB_SEQ_RULES = [
  { id:"UAT_BEFORE_CUTOVER",   mode:"barrier",    before:"uatSignoff",       after:"cutoverExec",      sev:"HARD", msg:"UAT sign-off must complete before cutover execution",                 src:"SAP Activate · S4H_747" },
  { id:"FREEZE_BEFORE_DM",     mode:"barrier",    before:"legacyFreeze",     after:"dmLoad",           sev:"HARD", msg:"Legacy freeze must precede all data-migration loads",                 src:"SAP Activate" },
  { id:"MASTER_BEFORE_TX",     mode:"structural", before:"masterData",       after:"txData",           sev:"HARD", msg:"Master data must precede the transactional data that references it",  src:"SAP Activate · Migration Cockpit" },
  { id:"CONFIG_BEFORE_USERS",  mode:"barrier",    before:"configActivation", after:"userProvisioning", sev:"HARD", msg:"Configuration activation must precede production user creation",      src:"SAP Activate" },
  { id:"GONG_BEFORE_RAMP",     mode:"barrier",    before:"goNoGo",           after:"ramp",             sev:"HARD", msg:"Go/No-Go decision must precede ramp-up and user unlock",              src:"SAP Activate · FP_45" },
];

// Activity library. Schema: {id, s:stream, ph:phase, o:owner, n:name,
// dep:[predecessor ids], d:baseline hours, k:[kinds], sz:[sizes]|omitted=all}
const KB_ACTIVITIES = [
  // Stream 1 — Infrastructure & Technical Readiness
  {id:"TECH-01",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate Production tenant provisioned & accessible",dep:[],d:2},
  {id:"TECH-02",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate SSL & SSO configuration",dep:["TECH-01"],d:2},
  {id:"TECH-03",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate logon groups & operation modes",dep:["TECH-01"],d:1},
  {id:"TECH-04",s:"TECH",ph:"PRE",o:"Basis/Integration Lead",n:"Validate RFC connections (Prod↔BTP↔Integration Suite)",dep:["TECH-01"],d:2},
  {id:"TECH-05",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate TMS config & transport routes",dep:["TECH-01"],d:1},
  {id:"TECH-06",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Verify add-ons & scope item activations",dep:["TECH-01"],d:2},
  {id:"TECH-07",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate client settings & logical system",dep:["TECH-01"],d:1},
  {id:"TECH-08",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Confirm backups scheduled; verify DR",dep:["TECH-01"],d:1},
  {id:"TECH-09",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Enable SAP support connections & launchpad URL",dep:["TECH-02"],d:1},
  {id:"TECH-10",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Validate & schedule mandatory batch jobs",dep:["TECH-01"],d:2},
  {id:"TECH-11",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Implement system parameter tuning",dep:["TECH-06"],d:2},
  {id:"TECH-12",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Verify SCOT settings (email output)",dep:["TECH-01"],d:1},
  {id:"TECH-13",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Verify ADS configuration",dep:["TECH-01"],d:1},
  {id:"TECH-14",s:"TECH",ph:"PRE",o:"Basis/Analytics Lead",n:"Activate Embedded Analytics queries & CDS views",dep:["TECH-06"],d:2},
  {id:"TECH-15",s:"TECH",ph:"PRE",o:"Basis/Analytics Lead",n:"Run BW initial setup; validate info objects",dep:["TECH-14"],d:2},
  {id:"TECH-16",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Run Enterprise Search initial setup",dep:["TECH-06"],d:1},
  {id:"TECH-17",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Re-index ESH connectors; consistency check",dep:["TECH-16"],d:1},
  {id:"TECH-18",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Run Fiori backend catalog sync reports",dep:["TECH-06"],d:1},
  {id:"TECH-19",s:"TECH",ph:"PRE",o:"Basis Lead",n:"Run app index; invalidate client/global caches",dep:["TECH-18"],d:1},
  {id:"TECH-20",s:"TECH",ph:"PRE",o:"Project Manager",n:"Verify hypercare staffing readiness",dep:["TECH-01"],d:1},
  // Stream 2 — Transport & Configuration Activation
  {id:"CONF-01",s:"CONF",ph:"CUT",o:"Technical Lead",n:"Confirm RICEFW & config transports promoted to Prod",dep:["TECH-05"],d:3,k:["configActivation"]},
  {id:"CONF-02",s:"CONF",ph:"CUT",o:"Technical Lead",n:"Validate transport content — no conflicts/missing objects",dep:["CONF-01"],d:2,k:["configActivation"]},
  {id:"CONF-03",s:"CONF",ph:"CUT",o:"Technical Lead",n:"Document manual steps for transport import",dep:["CONF-01"],d:1},
  {id:"CONF-04",s:"CONF",ph:"CUT",o:"Functional Lead",n:"Validate org structure customizing",dep:["CONF-02"],d:3},
  {id:"CONF-05",s:"CONF",ph:"CUT",o:"Functional Lead",n:"Validate document types & number ranges",dep:["CONF-04"],d:2},
  {id:"CONF-06",s:"CONF",ph:"CUT",o:"Finance Lead",n:"Maintain posting periods (GL/AA/CO/MM)",dep:["CONF-04"],d:1},
  {id:"CONF-07",s:"CONF",ph:"CUT",o:"MM/SD Lead",n:"Create condition records (MM/SD)",dep:["CONF-04"],d:2},
  {id:"CONF-08",s:"CONF",ph:"CUT",o:"Finance/SD Lead",n:"Validate tax config & pricing procedures",dep:["CONF-04"],d:2},
  {id:"CONF-09",s:"CONF",ph:"CUT",o:"MM/SD Lead",n:"Validate output messages (Procurement/Sales)",dep:["CONF-04"],d:1},
  {id:"CONF-10",s:"CONF",ph:"CUT",o:"MM Lead",n:"Validate movement types updated",dep:["CONF-04"],d:1},
  {id:"CONF-11",s:"CONF",ph:"CUT",o:"Finance Lead",n:"Validate House Banks & Bank Accounts apps",dep:["CONF-04"],d:1},
  {id:"CONF-12",s:"CONF",ph:"CUT",o:"Integration Lead",n:"Integration smoke test to adjacent systems",dep:["CONF-02","INT-05"],d:2},
  {id:"CONF-13",s:"CONF",ph:"CUT",o:"Technical Lead",n:"3SL: verify no staging 'Activation in Progress'",dep:["CONF-01"],d:1,sz:["L"]},
  {id:"CONF-14",s:"CONF",ph:"CUT",o:"Basis/Security Lead",n:"Activate inactive Fiori apps (IAM); New Experience switch",dep:["CONF-02","SEC-04"],d:2},
  // Stream 3 — Security & Authorizations
  {id:"SEC-01",s:"SEC",ph:"CUT",o:"Security Lead",n:"Finalize & validate authorization matrix",dep:["CONF-04"],d:3},
  {id:"SEC-02",s:"SEC",ph:"CUT",o:"Security Lead",n:"Build, assign & test security roles",dep:["SEC-01"],d:2},
  {id:"SEC-03",s:"SEC",ph:"CUT",o:"Security Lead",n:"Assign BP roles (HCM/SF employee BPs)",dep:["SEC-02"],d:1},
  {id:"SEC-04",s:"SEC",ph:"CUT",o:"Security Lead",n:"Create production users; assign business roles",dep:["SEC-02","CONF-02"],d:3,k:["userProvisioning"]},
  {id:"SEC-05",s:"SEC",ph:"CUT",o:"Security Lead",n:"Validate all users can log in; role match",dep:["SEC-04"],d:2},
  {id:"SEC-06",s:"SEC",ph:"CUT",o:"Security Lead",n:"Confirm cutover task owners have needed rights",dep:["SEC-04"],d:1},
  {id:"SEC-07",s:"SEC",ph:"CUT",o:"Security Lead",n:"Disable legacy access (phased — Finance last)",dep:["LEG-03"],d:1},
  {id:"SEC-08",s:"SEC",ph:"CUT",o:"OCM/Basis Lead",n:"End-users clear browser cache for latest Fiori",dep:["TECH-19","SEC-04"],d:1},
  // Stream 4 — Legacy Freeze & Closing
  {id:"LEG-01",s:"LEG",ph:"PRE",o:"Project Manager",n:"Communicate cutover & freeze timeline",dep:[],d:1},
  {id:"LEG-02",s:"LEG",ph:"CUT",o:"MM Lead",n:"Freeze legacy procurement transactions",dep:["LEG-01"],d:2,k:["legacyFreeze"]},
  {id:"LEG-03",s:"LEG",ph:"CUT",o:"SD Lead",n:"Freeze legacy sales transactions",dep:["LEG-01"],d:2,k:["legacyFreeze"]},
  {id:"LEG-04",s:"LEG",ph:"CUT",o:"Warehouse Lead",n:"Freeze legacy inventory movements",dep:["LEG-01"],d:2,k:["legacyFreeze"]},
  {id:"LEG-05",s:"LEG",ph:"CUT",o:"Finance Lead",n:"Legacy finance closing (phased lockout)",dep:["LEG-01"],d:4,k:["legacyFreeze"]},
  {id:"LEG-06",s:"LEG",ph:"CUT",o:"HR Lead",n:"Freeze legacy HR master data",dep:["LEG-01"],d:1,k:["legacyFreeze"]},
  {id:"LEG-07",s:"LEG",ph:"CUT",o:"Project Manager",n:"Confirm no active legacy txns; document freeze",dep:["LEG-02","LEG-03","LEG-04","LEG-05","LEG-06"],d:1,k:["legacyFreeze"]},
  {id:"LEG-08",s:"LEG",ph:"CUT",o:"Integration Lead",n:"Shut down legacy outbound interfaces",dep:["LEG-07","INT-04"],d:1},
  {id:"LEG-09",s:"LEG",ph:"CUT",o:"Security Lead",n:"Disable legacy user access (with SEC-07)",dep:["LEG-07"],d:1},
  // Stream 5 — Data Migration (Migration Cockpit)
  {id:"DM-01",s:"DM",ph:"PRE",o:"DM Lead",n:"Finalize data migration approach/strategy",dep:[],d:1},
  {id:"DM-02",s:"DM",ph:"PRE",o:"DM/Basis Lead",n:"Confirm Cloud Connector for Direct Transfer (BH3)",dep:["TECH-04"],d:3},
  {id:"DM-03",s:"DM",ph:"PRE",o:"DM Lead",n:"Confirm comm arrangement SAP_COM_0816 active",dep:["DM-02","TECH-01"],d:1},
  {id:"DM-04",s:"DM",ph:"CUT",o:"DM Lead",n:"Verify user profiles for uploads (date/decimal)",dep:["SEC-04"],d:1},
  {id:"DM-05",s:"DM",ph:"CUT",o:"Finance Lead",n:"Upload historical exchange rates",dep:["CONF-06","DM-04"],d:1},
  {id:"DM-06",s:"DM",ph:"CUT",o:"DM Lead",n:"Final data cleanse & quality check",dep:["LEG-07"],d:4},
  {id:"DM-07",s:"DM",ph:"CUT",o:"DM Lead",n:"Create migration project; select objects",dep:["DM-03","DM-06"],d:1},
  {id:"DM-08",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: CO area, company codes, CoA, centers",dep:["DM-07","CONF-04"],d:4,k:["masterData","dmLoad"]},
  {id:"DM-09",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: Business Partner (Cust/Vendor/Bank)",dep:["DM-08"],d:4,k:["masterData","dmLoad"]},
  {id:"DM-10",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: Material Master",dep:["DM-08"],d:4,k:["masterData","dmLoad"]},
  {id:"DM-11",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: Fixed Assets",dep:["DM-08"],d:3,k:["masterData","dmLoad"]},
  {id:"DM-12",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: Banks/House Banks/Accounts",dep:["DM-09"],d:2,k:["masterData","dmLoad"]},
  {id:"DM-13",s:"DM",ph:"CUT",o:"DM Lead",n:"Load master: Prod versions, task lists, equipment",dep:["DM-10"],d:3,k:["masterData","dmLoad"]},
  {id:"DM-14",s:"DM",ph:"CUT",o:"DM/Business Leads",n:"Validate master data loads (reconciliation)",dep:["DM-09","DM-10","DM-11","DM-12","DM-13"],d:4,k:["masterData","dmLoad"]},
  {id:"DM-15",s:"DM",ph:"CUT",o:"Finance/DM Lead",n:"Load tx: initial GL/AA balances",dep:["DM-14"],d:3,k:["txData","dmLoad"]},
  {id:"DM-16",s:"DM",ph:"CUT",o:"Finance/DM Lead",n:"Load tx: open AP/AR items",dep:["DM-15"],d:3,k:["txData","dmLoad"]},
  {id:"DM-17",s:"DM",ph:"CUT",o:"MM/DM Lead",n:"Load tx: open POs & scheduling agreements",dep:["DM-14","LEG-02"],d:3,k:["txData","dmLoad"]},
  {id:"DM-18",s:"DM",ph:"CUT",o:"SD/DM Lead",n:"Load tx: open sales orders",dep:["DM-14","LEG-03"],d:3,k:["txData","dmLoad"]},
  {id:"DM-19",s:"DM",ph:"CUT",o:"Warehouse/DM Lead",n:"Load tx: inventory/stock & batch",dep:["DM-14","LEG-04"],d:3,k:["txData","dmLoad"]},
  {id:"DM-20",s:"DM",ph:"CUT",o:"PM/DM Lead",n:"Load tx: work orders & maintenance plans",dep:["DM-13"],d:2,k:["txData","dmLoad"]},
  {id:"DM-21",s:"DM",ph:"CUT",o:"DM Lead",n:"Simulate all objects (dry run)",dep:["DM-15","DM-16","DM-17","DM-18","DM-19","DM-20"],d:3,k:["dmLoad"]},
  {id:"DM-22",s:"DM",ph:"CUT",o:"DM Lead",n:"Execute final production migration run",dep:["DM-21"],d:4,k:["dmLoad","cutoverExec"]},
  {id:"DM-23",s:"DM",ph:"CUT",o:"DM Lead",n:"Review migration logs",dep:["DM-22"],d:2},
  {id:"DM-24",s:"DM",ph:"CUT",o:"DM/Finance Lead",n:"Quantitative reconciliation",dep:["DM-23"],d:3},
  {id:"DM-25",s:"DM",ph:"CUT",o:"Business Owners",n:"Qualitative spot checks",dep:["DM-24"],d:3},
  {id:"DM-26",s:"DM",ph:"CUT",o:"Business Owners",n:"Downstream process testing",dep:["DM-25"],d:4},
  {id:"DM-27",s:"DM",ph:"CUT",o:"Finance Lead/PM",n:"DM reconciliation report sign-off",dep:["DM-26"],d:1},
  // Stream 6 — Integration Activation
  {id:"INT-01",s:"INT",ph:"CUT",o:"Integration Lead",n:"Activate SAP Best Practices integrations",dep:["CONF-02"],d:2},
  {id:"INT-02",s:"INT",ph:"CUT",o:"Integration Lead",n:"Update iFlow endpoints to Prod URLs",dep:["TECH-04"],d:2},
  {id:"INT-03",s:"INT",ph:"CUT",o:"Integration Lead",n:"Update OAuth creds, API keys, certificates",dep:["INT-02"],d:2},
  {id:"INT-04",s:"INT",ph:"CUT",o:"Integration Lead",n:"Activate outbound iFlows",dep:["INT-02","INT-03"],d:2},
  {id:"INT-05",s:"INT",ph:"CUT",o:"Integration Lead",n:"Activate inbound iFlows",dep:["INT-02","INT-03"],d:2},
  {id:"INT-06",s:"INT",ph:"CUT",o:"Integration Lead",n:"Activate EDI partner profiles",dep:["INT-04"],d:1},
  {id:"INT-07",s:"INT",ph:"CUT",o:"Integration Lead",n:"Notify trading partners; switch EDI gateway",dep:["INT-06"],d:1},
  {id:"INT-08",s:"INT",ph:"CUT",o:"Integration/Business",n:"E2E integration smoke tests",dep:["INT-04","INT-05","DM-14"],d:3},
  {id:"INT-09",s:"INT",ph:"CUT",o:"Analytics Lead",n:"Validate SAC live connection to Prod",dep:["INT-04","DM-27"],d:2},
  {id:"INT-10",s:"INT",ph:"CUT",o:"Finance/Integration",n:"Validate SAP Concur connector",dep:["INT-04","DM-14"],d:1},
  {id:"INT-11",s:"INT",ph:"CUT",o:"HR/Integration",n:"Validate SuccessFactors EC integration",dep:["INT-04","DM-14"],d:2},
  {id:"INT-12",s:"INT",ph:"CUT",o:"Finance/Integration",n:"Validate tax engine (Vertex/Avalara)",dep:["INT-04","DM-15"],d:1},
  {id:"INT-13",s:"INT",ph:"CUT",o:"Integration Lead",n:"Confirm no inbound msgs to legacy post-cutover",dep:["LEG-08","INT-04"],d:1},
  {id:"INT-14",s:"INT",ph:"CUT",o:"Basis/Integration",n:"Configure Cloud ALM integration monitoring",dep:["TECH-01","INT-04"],d:2},
  // Stream 7 — BTP Side-by-Side Extensions
  {id:"BTP-01",s:"BTP",ph:"CUT",o:"BTP Lead",n:"Deploy BTP extensions to Prod subaccount",dep:["CONF-02"],d:3},
  {id:"BTP-02",s:"BTP",ph:"CUT",o:"BTP Lead",n:"Update BTP destinations to Prod S/4HANA",dep:["BTP-01","TECH-04"],d:2},
  {id:"BTP-03",s:"BTP",ph:"CUT",o:"BTP Lead",n:"Update OAuth2 & trust for Prod IAS",dep:["BTP-02"],d:1},
  {id:"BTP-04",s:"BTP",ph:"CUT",o:"Security/BTP Lead",n:"Validate IAS Prod: SSO & provisioning",dep:["BTP-03","SEC-04"],d:2},
  {id:"BTP-05",s:"BTP",ph:"CUT",o:"BTP Lead",n:"Activate Build Process Automation workflows",dep:["BTP-01","SEC-04"],d:2},
  {id:"BTP-06",s:"BTP",ph:"CUT",o:"BTP/Integration",n:"Update Event Mesh topic; validate events",dep:["BTP-01","INT-04"],d:2},
  {id:"BTP-07",s:"BTP",ph:"CUT",o:"BTP/MM Lead",n:"Deploy PO/PR approval apps; validate chain",dep:["BTP-02","SEC-04","INT-08"],d:2},
  {id:"BTP-08",s:"BTP",ph:"CUT",o:"BTP/Integration",n:"Deploy Supplier Self-Service portal",dep:["BTP-02","INT-04"],d:2},
  {id:"BTP-09",s:"BTP",ph:"CUT",o:"BTP/SD Lead",n:"Deploy Customer Returns portal",dep:["BTP-02","DM-18"],d:2},
  {id:"BTP-10",s:"BTP",ph:"CUT",o:"BTP Lead",n:"Configure DMS repository; link doc types",dep:["BTP-02","DM-14"],d:1},
  {id:"BTP-11",s:"BTP",ph:"CUT",o:"BTP/PM Lead",n:"Deploy Mobile Field Service app",dep:["BTP-02","DM-20"],d:1},
  {id:"BTP-12",s:"BTP",ph:"CUT",o:"BTP/Analytics",n:"Switch AI Core/Datasphere endpoint to Prod",dep:["BTP-02","INT-09"],d:2},
  {id:"BTP-13",s:"BTP",ph:"CUT",o:"BTP Lead",n:"API health checks for all BTP extensions",dep:["BTP-01","BTP-02","BTP-03","BTP-04","BTP-05","BTP-06","BTP-07","BTP-08","BTP-09","BTP-10","BTP-11","BTP-12"],d:2},
  // Stream 8 — RICEFW Validation
  {id:"RICE-01",s:"RICE",ph:"CUT",o:"Technical/Business",n:"Validate custom reports vs legacy output",dep:["CONF-02","DM-27"],d:3},
  {id:"RICE-02",s:"RICE",ph:"CUT",o:"Technical/Integration",n:"Activate IDoc message control & partner profiles",dep:["CONF-02","INT-06"],d:2},
  {id:"RICE-03",s:"RICE",ph:"CUT",o:"DM Lead",n:"Final conversion program runs; validate counts",dep:["DM-22","DM-23"],d:3},
  {id:"RICE-04",s:"RICE",ph:"CUT",o:"Technical Lead",n:"Smoke test custom enhancements (BAdIs/exits)",dep:["CONF-02"],d:2},
  {id:"RICE-05",s:"RICE",ph:"CUT",o:"Technical/Business",n:"Validate output forms; print test docs",dep:["CONF-02","DM-14"],d:2},
  {id:"RICE-06",s:"RICE",ph:"CUT",o:"Technical/Business",n:"Test workflows (PO/invoice/leave)",dep:["SEC-04","DM-16","DM-17"],d:2},
  {id:"RICE-07",s:"RICE",ph:"CUT",o:"Technical Lead",n:"Validate Key User extensibility transports",dep:["CONF-02"],d:1},
  {id:"RICE-08",s:"RICE",ph:"CUT",o:"Technical Lead",n:"Validate OData service configurations",dep:["CONF-02"],d:1},
  // Stream 9 — Go/No-Go & Ramp-Up
  {id:"GONG-01",s:"GONG",ph:"PRE",o:"Test Lead/Business",n:"Confirm UAT sign-off; no open P1 issues",dep:[],d:1,k:["uatSignoff"]},
  {id:"GONG-02",s:"GONG",ph:"PRE",o:"OCM Lead",n:"Confirm end-user training threshold met",dep:[],d:1},
  {id:"GONG-03",s:"GONG",ph:"CUT",o:"DM Lead",n:"Confirm DM reconciliation signed off",dep:["DM-27"],d:0.5},
  {id:"GONG-04",s:"GONG",ph:"CUT",o:"Integration Lead",n:"Confirm integration smoke tests passed",dep:["INT-08","INT-09","INT-10","INT-11","INT-12","INT-13"],d:0.5},
  {id:"GONG-05",s:"GONG",ph:"CUT",o:"BTP Lead",n:"Confirm BTP health checks passed",dep:["BTP-13"],d:0.5},
  {id:"GONG-06",s:"GONG",ph:"CUT",o:"Technical Lead",n:"Confirm RICEFW validations complete",dep:["RICE-01","RICE-02","RICE-03","RICE-04","RICE-05","RICE-06","RICE-07","RICE-08"],d:0.5},
  {id:"GONG-07",s:"GONG",ph:"CUT",o:"Security Lead",n:"Confirm security validated; users can log in",dep:["SEC-05"],d:0.5},
  {id:"GONG-08",s:"GONG",ph:"CUT",o:"Basis Lead",n:"Confirm technical checklist complete",dep:["TECH-15","TECH-17","TECH-19"],d:0.5},
  {id:"GONG-09",s:"GONG",ph:"CUT",o:"Project Manager",n:"Go/No-Go decision meeting (documented)",dep:["GONG-01","GONG-02","GONG-03","GONG-04","GONG-05","GONG-06","GONG-07","GONG-08"],d:1,k:["goNoGo"]},
  {id:"GONG-10",s:"GONG",ph:"CUT",o:"Project Manager",n:"If Go: unlock users; communicate go-live",dep:["GONG-09"],d:1,k:["cutoverExec"]},
  {id:"GONG-11",s:"GONG",ph:"CUT",o:"Project Manager",n:"If No-Go: rollback recommendation; contingency",dep:["GONG-09"],d:0,k:["contingency"]},
  {id:"RAMP-01",s:"GONG",ph:"HC",o:"Basis Lead",n:"Activate & validate batch jobs",dep:["GONG-10"],d:2,k:["ramp"]},
  {id:"RAMP-02",s:"GONG",ph:"HC",o:"Integration Lead",n:"Activate interfaces; confirm queues",dep:["GONG-10","INT-04"],d:1,k:["ramp"]},
  {id:"RAMP-03",s:"GONG",ph:"HC",o:"Business Owners",n:"Business process validation (key txns)",dep:["GONG-10"],d:4,k:["ramp"]},
  {id:"RAMP-04",s:"GONG",ph:"HC",o:"Basis/Integration",n:"Hypercare monitoring (Day 1–5)",dep:["RAMP-01","RAMP-02"],d:0,k:["ramp"]},
  {id:"RAMP-05",s:"GONG",ph:"HC",o:"SAP/Basis Lead",n:"SAP CQC go-live verification",dep:["RAMP-03"],d:0,k:["ramp"]},
  {id:"RAMP-06",s:"GONG",ph:"HC",o:"SAP/Business",n:"BPPO review (post go-live)",dep:["RAMP-05"],d:0,k:["ramp"]},
];

const CUTOVER_KB = {
  version: "kb-2025.1",
  basis: KB_DURATION_BASIS,
  sizes: KB_SIZES,
  streams: KB_STREAMS,
  seqRules: KB_SEQ_RULES,
  activities: KB_ACTIVITIES,
  sources: [
    "SAP Activate Cutover Template (S4H_403)",
    "SAP Activate Cutover Strategy (FP_45)",
    "SAP Activate Remote Cutover Guide (S4H_747)",
    "SAP Activate Roadmap Viewer — S/4HANA Cloud Public Edition",
    "SAP Migration Cockpit / Data Migration in SAP Activate",
  ],
};

// ─── Scheduling & dependency engines (deterministic — no LLM) ─────────
function taskKinds(x) {
  if (!x) return [];
  if (Array.isArray(x.k)) return x.k;
  if (Array.isArray(x.kind)) return x.kind;
  if (x.kind) return [x.kind];
  return [];
}

function activitiesForSize(acts, size) {
  return (acts || []).filter(a => !a.sz || a.sz.includes(size));
}

// Baseline hours scaled by size, unless an explicit per-size override exists.
function pickDurationH(act, size) {
  if (act && act.dur && act.dur[size] != null) return act.dur[size];
  const base = act && act.d != null ? Number(act.d) : (act && act.durationH != null ? Number(act.durationH) : 1);
  const mult = (KB_SIZES[size] && KB_SIZES[size].mult) || 1;
  return Math.round(base * mult * 100) / 100;
}

// Kahn topological sort. nodes: [{id, dep:[] | predecessors:[]}].
// Returns {order:[ids], cycles:[ids]}. cycles non-empty ⇒ not a DAG.
function topoSort(nodes) {
  const preds = {}, indeg = {}, ids = [], succ = {};
  (nodes || []).forEach(n => { preds[n.id] = (n.dep || n.predecessors || []); ids.push(n.id); });
  const present = new Set(ids);
  ids.forEach(id => { indeg[id] = 0; succ[id] = []; });
  ids.forEach(id => preds[id].forEach(p => { if (present.has(p)) { indeg[id]++; succ[p].push(id); } }));
  const q = ids.filter(id => indeg[id] === 0).sort();
  const order = [];
  while (q.length) {
    const id = q.shift(); order.push(id);
    succ[id].sort().forEach(s => { if (--indeg[s] === 0) q.push(s); });
  }
  return { order, cycles: ids.filter(id => order.indexOf(id) === -1) };
}

// Transitive predecessor set for a node id (reads .predecessors or .dep).
function transitivePreds(id, byId) {
  const seen = new Set();
  const start = (byId[id] && (byId[id].predecessors || byId[id].dep)) || [];
  const stack = start.slice();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p) || !byId[p]) continue;
    seen.add(p);
    ((byId[p].predecessors || byId[p].dep) || []).forEach(x => stack.push(x));
  }
  return seen;
}

// Instantiate a plan from the KB for a size → task-schema objects.
function instantiatePlanFromKB(kb, opts) {
  const size = (opts && opts.size) || "M";
  const industry = (opts && opts.industry) || "";
  const hi = ["legacyFreeze", "masterData", "txData", "goNoGo", "cutoverExec"];
  // Industry filter: keep universal (untagged) tasks always; industry-tagged tasks only when they match.
  // Dormant until KB_ACTIVITIES tasks carry an `ind:[...]` tag.
  const industryActivities = kb.activities.filter(a =>
    !a.ind || a.ind.length === 0 || (industry && a.ind.includes(industry))
  );
  return activitiesForSize(industryActivities, size).map(a => ({
    id: a.id,
    task: a.n || a.id,
    phase: a.ph || "CUT",
    category: KB_STREAMS[a.s] || a.s,
    workstream: a.s,
    stream: a.s,
    owner: a.o || "",
    durationH: pickDurationH(a, size),
    status: "PENDING",
    priority: taskKinds(a).some(k => hi.indexOf(k) !== -1) ? "HIGH" : "MEDIUM",
    predecessors: (a.dep || []).slice(),
    kind: taskKinds(a),
    notes: "",
  }));
}

// Dependency-aware scheduler (as-soon-as-possible, resource-unconstrained).
// tasks: [{id, predecessors:[], durationH}]. opts: {windowStartMs} OR
// {goLiveDate, goLiveTime, windowH, size}. Times are computed in UTC for
// determinism. Returns tasks (topo order) + {esH, efH, scheduledStart/End}.
function scheduleActivities(tasks, opts) {
  opts = opts || {};
  const { order, cycles } = topoSort(tasks);
  if (cycles.length) throw new Error("Cannot schedule: dependency cycle among " + cycles.slice(0, 6).join(", "));
  const byId = {}; tasks.forEach(t => { byId[t.id] = Object.assign({}, t); });
  order.forEach(id => {
    const t = byId[id];
    const preds = (t.predecessors || []).filter(p => byId[p]);
    const esH = preds.length ? Math.max.apply(null, preds.map(p => byId[p].efH)) : 0;
    t.esH = esH;
    t.efH = esH + (Number(t.durationH) || 0);
  });
  let startMs = null;
  if (opts.windowStartMs != null) startMs = opts.windowStartMs;
  else if (opts.goLiveDate) {
    const gl = new Date(opts.goLiveDate + "T" + (opts.goLiveTime || "06:00") + ":00Z").getTime();
    const winH = opts.windowH != null ? opts.windowH : ((KB_SIZES[opts.size] && KB_SIZES[opts.size].window_h) || 72);
    startMs = gl - winH * 3600000;
  }
  const iso = ms => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  return order.map(id => {
    const t = byId[id];
    if (startMs != null) {
      t.scheduledStart = iso(startMs + t.esH * 3600000);
      t.scheduledEnd = iso(startMs + t.efH * 3600000);
    }
    return t;
  });
}

// Critical Path (CPM): backward pass over a scheduled plan → slack + flag.
function criticalPath(scheduled) {
  const byId = {}; scheduled.forEach(t => { byId[t.id] = Object.assign({}, t); });
  const ids = scheduled.map(t => t.id);
  const succ = {}; ids.forEach(id => succ[id] = []);
  ids.forEach(id => (byId[id].predecessors || []).forEach(p => { if (byId[p]) succ[p].push(id); }));
  const projEnd = ids.length ? Math.max.apply(null, ids.map(id => byId[id].efH || 0)) : 0;
  const EPS = 1e-6;
  // Reverse-topological order guarantees every successor is processed before
  // its predecessor (an efH sort mis-orders ties from 0-duration milestones).
  const order = topoSort(scheduled).order;
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i], t = byId[id], ss = succ[id];
    t.lfH = ss.length ? Math.min.apply(null, ss.map(s => byId[s].lsH)) : projEnd;
    t.lsH = t.lfH - (Number(t.durationH) || 0);
    t.slackH = Math.round((t.lsH - t.esH) * 1000) / 1000;
    t.critical = t.slackH <= EPS;
  }
  return {
    tasks: ids.map(id => byId[id]),
    projectDurationH: projEnd,
    criticalIds: ids.filter(id => byId[id].critical),
  };
}

// Deterministic SAP sequencing validation → list of violations.
function validateSequencing(scheduled, rules) {
  const byId = {}; scheduled.forEach(t => { byId[t.id] = t; });
  const EPS = 1e-6;
  const out = [];
  (rules || []).forEach(rule => {
    const befores = scheduled.filter(t => taskKinds(t).indexOf(rule.before) !== -1);
    const afters = scheduled.filter(t => taskKinds(t).indexOf(rule.after) !== -1);
    if (!befores.length || !afters.length) return;
    if (rule.mode === "structural") {
      const beforeIds = new Set(befores.map(b => b.id));
      afters.forEach(a => {
        const anc = transitivePreds(a.id, byId);
        let ok = false; anc.forEach(x => { if (beforeIds.has(x)) ok = true; });
        if (!ok) out.push({ ruleId: rule.id, severity: rule.sev, offenders: [a.id], msg: rule.msg, src: rule.src });
      });
    } else {
      const maxBeforeEf = Math.max.apply(null, befores.map(t => t.efH || 0));
      afters.forEach(a => {
        if ((a.esH || 0) < maxBeforeEf - EPS) out.push({ ruleId: rule.id, severity: rule.sev, offenders: [a.id], msg: rule.msg, src: rule.src });
      });
    }
  });
  return out;
}
// ─── Corpus learning & wave alignment (deterministic) ────────────────
// "Training" here = deriving a keyword taxonomy from a corpus of common
// cutover activities, not gradient training. The classifier maps free-text
// tasks (however messy) onto the KB's stream/kind/phase vocabulary so any
// consolidated list can be understood and aligned to a wave plan.

// Ordered keyword rules — first match wins. Derived from the SAP KB plus the
// consolidated corpus vocabulary. {re, s:stream, k:kind, ph:phase}
const CLASSIFIER_RULES = [
  { re: /freeze|last invoic|last inventory|last pay|end of legacy|legacy.*(post|freeze|lock)/i, s: "LEG", k: "legacyFreeze", ph: "CUT" },
  { re: /go\/?no[- ]?go|no[- ]?go decision/i,                                                   s: "GONG", k: "goNoGo",       ph: "CUT" },
  { re: /go[- ]?live|ramp ?up|hyper ?care|post go/i,                                             s: "GONG", k: "ramp",         ph: "HC"  },
  { re: /cutover (checklist|plan|activit)|production cutover|start of .*cutover|tech(nical)? cutover/i, s: "GONG", k: "cutoverExec", ph: "CUT" },
  { re: /user creation|r&r|\brole\b|authoriz|security/i,                                         s: "SEC",  k: "userProvisioning", ph: "CUT" },
  { re: /transport|tr movement|\btrs?\b|cab approval|rfc creation/i,                             s: "CONF", k: "configActivation", ph: "CUT" },
  { re: /manual config|configuration|config \(/i,                                               s: "CONF", k: "configActivation", ph: "CUT" },
  { re: /batch job/i,                                                                            s: "TECH", k: "",             ph: "PRE" },
  { re: /upgrad|enablement|tenant|fiori|backup|analytics|rfc connection|\bscot\b|\bads\b/i,      s: "TECH", k: "",             ph: "PRE" },
  { re: /integration|iflow|interface|\bedi\b|\bapi\b|certificate|url exchange|tibco|intercompany connection|connection setup|odata.*connection|penny.*test/i, s: "INT", k: "", ph: "CUT" },
  { re: /\bbtp\b|extension|build apps|event mesh|\bias\b/i,                                       s: "BTP",  k: "",             ph: "CUT" },
  { re: /open (sales|purchase|po|ar|ap)|open item|accounts (payable|receivable)|purchase order|sales order|balance|inventory|stock|condition contract|settlement|goods receipt|billing|delivery/i, s: "DM", k: "txData", ph: "CUT" },
  { re: /exchange rate/i,                                                                        s: "DM",   k: "masterData", ph: "CUT" },
  { re: /master data|bank key|profit center|cost center|product|customer|supplier|vendor|material|fixed asset|\bbom\b|chart of account|\bcoa\b|gl account|info record|condition record|hierarchy|classification/i, s: "DM", k: "masterData", ph: "CUT" },
  { re: /data migration|\bload\b|valid|sign ?off|reconcil/i,                                     s: "DM",   k: "",             ph: "CUT" },
];

function classifyActivity(text) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  for (let i = 0; i < CLASSIFIER_RULES.length; i++) {
    if (CLASSIFIER_RULES[i].re.test(t)) {
      const r = CLASSIFIER_RULES[i];
      return { stream: r.s, kind: r.k, phase: r.ph, matched: true };
    }
  }
  return { stream: "OTHER", kind: "", phase: "CUT", matched: false };
}

function canonicalStatus(raw) {
  const v = String(raw == null ? "" : raw).toLowerCase().trim();
  if (/^(complete|completed|done|closed)$/.test(v)) return "COMPLETE";
  if (/(in ?progress|in ?process|\bwip\b|ongoing)/.test(v)) return "IN_PROGRESS";
  if (/(blocked|on ?hold|stuck)/.test(v)) return "BLOCKED";
  if (/(skip|n\/a|cancel)/.test(v)) return "SKIPPED";
  return "PENDING"; // not started / open / planned / blank / nan / nat
}

function parseISODate(x) {
  if (x == null) return null;
  const s = String(x).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const KIND_HOURS = { legacyFreeze: 2, masterData: 4, txData: 3, userProvisioning: 3, configActivation: 2, cutoverExec: 4, goNoGo: 1, ramp: 2, contingency: 0 };
function kindDefaultHours(kind) { return KIND_HOURS[kind] != null ? KIND_HOURS[kind] : 2; }

// Sequence rank encodes the SAP execution order so free-text tasks (which
// lack explicit predecessors) still sort into a correct cutover sequence.
const KIND_RANK = { configActivation: 20, userProvisioning: 25, legacyFreeze: 30, masterData: 40, dmLoad: 45, txData: 50, cutoverExec: 60, goNoGo: 70, ramp: 80, contingency: 65 };
function sequenceRank(task) {
  const kinds = taskKinds(task);
  let best = null;
  kinds.forEach(k => { if (KIND_RANK[k] != null) best = best == null ? KIND_RANK[k] : Math.min(best, KIND_RANK[k]); });
  if (best != null) return best;
  const ph = task.phase || "CUT";
  return ph === "PRE" ? 5 : ph === "HC" ? 85 : 45;
}

// Normalise a consolidated list (rows = arrays [cat,task,start,end,status]
// or record objects) into clean, classified tasks. Carries owner, WBS-based
// id, Finish-to-Start predecessors, and per-size duration when present.
function normalizeConsolidated(rows, opts) {
  const size = (opts && KB_SIZES[opts.size]) ? opts.size : "M";
  const seen = new Set();
  const bad = new Set(["", "nan", "nat", "none", "null"]);
  const out = [];
  let n = 0;
  (rows || []).forEach(row => {
    const r = Array.isArray(row)
      ? { category: row[0], task: row[1], start: row[2], end: row[3], status: row[4] }
      : (row || {});
    const task = String(r.task == null ? "" : r.task).replace(/\s+/g, " ").trim();
    if (bad.has(task.toLowerCase())) return;
    const start = parseISODate(r.start);
    const end = parseISODate(r.end);
    const dupKey = task + "|" + (start || "") + "|" + (end || "");
    if (seen.has(dupKey)) return;
    seen.add(dupKey);
    let category = String(r.category == null ? "" : r.category).trim();
    if (bad.has(category.toLowerCase())) category = "";
    const cls = classifyActivity(task + " " + category);
    n++;
    const wbs = r.wbs != null && String(r.wbs).trim() && !bad.has(String(r.wbs).toLowerCase()) ? String(r.wbs).trim() : "";
    const preds = r.dependsOn != null
      ? String(r.dependsOn).split(/[,;]+/).map(x => x.trim()).filter(x => x && !bad.has(x.toLowerCase()))
      : [];
    const durH = r.dur && r.dur[size] != null ? r.dur[size] : kindDefaultHours(cls.kind);
    out.push({
      id: wbs || ("C" + String(n).padStart(4, "0")),
      task, category,
      stream: cls.stream, kind: cls.kind ? [cls.kind] : [], phase: cls.phase,
      classified: cls.matched,
      owner: r.owner != null && !bad.has(String(r.owner).toLowerCase()) ? String(r.owner).trim() : "",
      start, end,
      status: canonicalStatus(r.status),
      durationH: durH,
      predecessors: preds,
      // Pass-through fields used for import-time filtering and enrichment
      goLiveRelevance: r.goLiveRelevance != null ? String(r.goLiveRelevance).trim() : undefined,
      l1Phase:         r.l1Phase        != null ? String(r.l1Phase).trim()        : undefined,
      scopeItemId:     r.scopeItemId    != null ? String(r.scopeItemId).trim()    : undefined,
    });
  });
  return out;
}

// --- L4 plan ingestion: table parsing → records → classified tasks ----
function parseDurationToH(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  const m = s.match(/([\d.]+)/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num)) return null;
  if (/week/.test(s)) return num * 168;
  if (/day|\bd\b/.test(s)) return num * 24;
  return num; // hours or bare number
}

// CSV/TSV parser (RFC-4180-ish): quotes, escaped quotes, embedded newlines.
// Auto-detects tab vs comma delimiter. Returns array of rows (arrays of cells).
function parseTable(text, delimiter) {
  const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (!s.trim()) return [];
  const firstLine = s.split("\n")[0];
  const delim = delimiter || ((firstLine.split("\t").length - 1) >= (firstLine.split(",").length - 1) && firstLine.indexOf("\t") !== -1 ? "\t" : ",");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Header alias map → canonical record fields. Handles the consolidated format
// (Task Category/Task/Start/End/Status) and the L4 format (Phase/WBS/L4
// Activity/Small/Medium/Large/Dependency Type/Depends On/Owner).
const HEADER_ALIASES = {
  category:       ["task category", "category", "phase", "stream", "workstream", "area", "scope area", "scope", "l2 workstream", "l2\nworkstream"],
  task:           ["task", "l4 task", "l4 task (activity description)", "l4 activity", "activity", "cutover activity", "description", "name", "step"],
  start:          ["start", "start date", "planned start", "scheduled start", "start date/time"],
  end:            ["end", "end date", "finish", "finish date", "planned end", "scheduled end", "end date/time"],
  status:         ["status", "state"],
  owner:          ["owner", "responsible", "assignee", "lead", "resource"],
  dependsOn:      ["depends on", "predecessor", "predecessors", "dependency", "dependencies"],
  wbs:            ["wbs", "wbs id", "task id", "id", "seq", "sequence"],
  durS:           ["small"], durM: ["medium"], durL: ["large"],
  goLiveRelevance:["go-live relevance", "go live relevance", "go-live\nrelevance", "golive relevance", "relevance"],
  l1Phase:        ["l1\nphase", "l1 phase", "phase (l1)", "project phase"],
  scopeItemId:    ["scope\nitem id", "scope item id", "scope item", "scopeid", "scope id"],
};
function headerField(h) {
  const x = String(h == null ? "" : h).toLowerCase().trim();
  for (const f in HEADER_ALIASES) { if (HEADER_ALIASES[f].indexOf(x) !== -1) return f; }
  return null;
}
function matrixToRecords(matrix) {
  const rows = (matrix || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? "" : c).trim() !== ""));
  if (!rows.length) return [];
  // L4 SAP Activate plans have a title row first and real column headers in row 3.
  // Find the header row by picking the row (within first 6) with the most recognized field names.
  let headerIdx = 0, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const score = rows[i].filter(c => headerField(c) !== null).length;
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  const header = rows[headerIdx].map(headerField);
  const hasTask = header.indexOf("task") !== -1;
  return rows.slice(headerIdx + 1).map(r => {
    const rec = {};
    header.forEach((f, i) => { if (f && rec[f] === undefined) rec[f] = r[i]; });
    if (rec.durS !== undefined || rec.durM !== undefined || rec.durL !== undefined) {
      rec.dur = { S: parseDurationToH(rec.durS), M: parseDurationToH(rec.durM), L: parseDurationToH(rec.durL) };
    }
    if (!hasTask) { rec.category = r[0]; rec.task = r[1]; rec.start = r[2]; rec.end = r[3]; rec.status = r[4]; }
    return rec;
  });
}

// RICEFW classification (Reports/Interfaces/Conversions/Enhancements/Forms/
// Workflows). Only tags genuine RICEFW objects — plain master/tx loads → "".
const RICEFW_RULES = [
  { re: /\breport\b|aged (ar|ap)|valuation report|expense report|custom report/i, t: "R" },
  { re: /interface|\bidoc\b|\bedi\b|iflow|partner profile|message control/i, t: "I" },
  { re: /conversion|migration (object|program)/i, t: "C" },
  { re: /enhancement|\bbadi\b|user ?exit|\bexit\b|custom field|extensib|key user/i, t: "E" },
  { re: /\bform\b|smartform|adobe form|output (form|type)|invoice output|po output|delivery note|print (test|document)/i, t: "F" },
  { re: /workflow|approval (chain|workflow|app)/i, t: "W" },
];
function classifyRicefw(text) {
  const t = String(text == null ? "" : text);
  for (let i = 0; i < RICEFW_RULES.length; i++) if (RICEFW_RULES[i].re.test(t)) return RICEFW_RULES[i].t;
  return "";
}

// ── Cutover activity pre-filter ────────────────────────────────────────────
// Primary rule (L4 SAP Activate plan format):
//   The "GO-LIVE RELEVANCE" column is the authoritative signal.
//   Keep: Mandatory (must-do pre-go-live tasks) + Deploy phase (cutover execution).
//   Drop: Milestone (project gates), Optional (scope activations), empty (pure project work).
//
// Fallback rule (other plan formats without that column):
//   Drop tasks whose primary verb is clearly build/project work with no cutover verb.

const _NON_CUTOVER_VERB_RE = /^\s*(?:the\s+|a\s+)?(?:develop(?:ing|ment)?|design(?:ing)?|build(?:ing)?|creat(?:e|ing)|implement(?:ing)?|establish(?:ing)?|conduct\s+(?:a\s+)?(?:workshop|training|session|meeting)|deliver\s+(?:training|workshop)|facilitate\s+(?:a\s+)?(?:workshop|session)|prepare\s+(?:training|documentation|materials))\b/i;
const _CUTOVER_VERB_RE = /\b(?:verify|validate|confirm|check|test|activate|execute|freeze|lock|restrict|cutover|migrate|convert|sign.?off|go.?(?:live|no.?go)|reconcil|monitor|revoke|disable|transport|promote)\b/i;

// Phase / workstream patterns that indicate a cutover or go-live execution context.
// These are broad enough to cover common SAP Activate naming variants across clients:
//   Phase: "Deploy", "Deployment", "Go-Live", "Cutover", "Production Run", "Hypercare"
//   Workstream: "Cutover", "Go-Live", "Deployment", "Production Cutover"
// Mandatory GO-LIVE RELEVANCE + a strong execution verb is a secondary signal.
const _CUTOVER_PHASE_RE = /\b(?:deploy(?:ment)?|go[\s-]?live|cutover|hypercare|production[\s-]?(?:run|go[\s-]?live))\b/i;
const _CUTOVER_WS_RE    = /\b(?:cutover|go[\s-]?live|deploy(?:ment)?|production[\s-]?(?:cutover|deployment))\b/i;
const _CUTOVER_EXEC_RE  = /\b(?:freeze|lock[\s-]?(?:down|system)|system[\s-]?(?:shutdown|startup|shutdown)|transport[\s-]to[\s-]prod|activate[\s-]in[\s-]prod|sign[\s-]?off|parallel[\s-]?run|go[\s-]?(?:live|no[\s-]?go)|downtime|migrate[\s-](?:to[\s-])?prod|cutover)\b/i;

// Shared test used by both the matrixToRecords path and the looksLikeL4 workbook path.
function isCutoverRelevantL4Task(t) {
  if (_CUTOVER_WS_RE.test(t.workstream || ""))  return true;
  if (_CUTOVER_PHASE_RE.test(t.phase || ""))    return true;
  // Mandatory flag alone is too broad; require a strong execution verb as confirmation.
  if (/mandatory/i.test(t.goLive || "") && _CUTOVER_EXEC_RE.test(t.task || "")) return true;
  return false;
}

function isCutoverTask(rec) {
  const t = (rec.task || "").trim();
  const l1Phase    = (rec.l1Phase  || "").trim();
  const workstream = (rec.category || "").trim();
  const hasGoLiveCol = rec.goLiveRelevance !== undefined;

  if (hasGoLiveCol) {
    if (_CUTOVER_WS_RE.test(workstream))  return true;
    if (_CUTOVER_PHASE_RE.test(l1Phase))  return true;
    if (/mandatory/i.test(rec.goLiveRelevance || "") && _CUTOVER_EXEC_RE.test(t)) return true;
    return false;
  }

  // Fallback for generic plan formats (no GO-LIVE RELEVANCE column):
  // drop obvious build/project tasks by verb
  if (_NON_CUTOVER_VERB_RE.test(t) && !_CUTOVER_VERB_RE.test(t)) return false;
  return true;
}

// Ingest an L4 plan (matrix rows OR records) → classified tasks + RICEFW tags
// + inferred schedule fields (to populate the session) + a RICEFW register.
// Non-cutover tasks are stripped at ingestion; filteredOut count reported in toast.
function ingestL4Plan(rows, opts) {
  opts = opts || {};
  const records = (Array.isArray(rows) && Array.isArray(rows[0])) ? matrixToRecords(rows) : rows;

  // DEBUG — open browser DevTools → Console to see this output
  console.log("[L4 import] raw matrix rows:", Array.isArray(rows) ? rows.length : "not matrix");
  console.log("[L4 import] header row (rows[0]):", Array.isArray(rows) && rows[0] ? rows[0].slice(0,10) : "n/a");
  console.log("[L4 import] records produced:", records.length);
  if (records.length > 0) {
    console.log("[L4 import] first record sample:", JSON.stringify(records[0]));
    console.log("[L4 import] second record sample:", JSON.stringify(records[1]));
    // Check if our key fields are present
    const sample = records[0] || {};
    console.log("[L4 import] goLiveRelevance present?", "goLiveRelevance" in sample, "value:", sample.goLiveRelevance);
    console.log("[L4 import] l1Phase present?", "l1Phase" in sample, "value:", sample.l1Phase);
    console.log("[L4 import] category (L2 Workstream):", sample.category);
    console.log("[L4 import] task:", (sample.task || "").slice(0, 80));
  }

  const allTasks = normalizeConsolidated(records, { size: opts.size });
  allTasks.forEach(t => { t.ricefwType = classifyRicefw(t.task + " " + (t.category || "")); });

  console.log("[L4 import] allTasks after normalize:", allTasks.length);
  if (allTasks.length > 0) {
    console.log("[L4 import] first normalized task:", JSON.stringify(allTasks[0]));
    const s = allTasks[0];
    console.log("[L4 import] filter check on first task — goLiveRelevance:", s.goLiveRelevance, "l1Phase:", s.l1Phase, "category:", s.category);
  }

  // Split: genuine cutover tasks vs project/non-cutover tasks
  const tasks = allTasks.filter(t => isCutoverTask(t));
  const filteredOut = allTasks.filter(t => !isCutoverTask(t));
  console.log("[L4 import] KEPT:", tasks.length, "FILTERED OUT:", filteredOut.length);

  const starts = tasks.map(t => t.start).filter(Boolean).sort();
  const ends = tasks.map(t => t.end).filter(Boolean).sort();
  const cutoverStartDate = starts[0] || "";
  const goLiveDate = ends.length ? ends[ends.length - 1] : "";
  let spanH = 0;
  if (cutoverStartDate && goLiveDate) {
    spanH = Math.max(0, Math.round((msFromDateTime(goLiveDate, "06:00") - msFromDateTime(cutoverStartDate, "00:00")) / 3600000));
  }
  // RICEFW register: include both kept tasks AND filtered-out RICEFW objects
  // (the objects still need transport tracking even if removed as tasks)
  const ricefwSource = [...tasks, ...filteredOut].filter(t => t.ricefwType);
  const ricefw = ricefwSource.map(t => ({
    id: "RF-" + t.id, type: t.ricefwType, name: t.task.slice(0, 90), module: t.stream,
    readiness: t.status === "COMPLETE" ? "PROD_READY" : "NOT_STARTED", transport: "", responsible: t.owner || "",
  }));
  return { tasks, filteredOut, inferred: { cutoverStartDate, cutoverStartTime: "00:00", goLiveDate, goLiveTime: "06:00", spanH }, ricefw };
}

// --- Gap analysis: imported plan vs the SAP cutover library (KB) ------
const COV_STOP = new Set(["load","loads","validate","validation","confirm","activate","create","check","update","review","final","data","master","transactional","system","legacy","production","cutover","plan","test","tests","open","setup","verify"]);
function kbKeywords(name) {
  return String(name || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !COV_STOP.has(w));
}
function analyzeCoverage(clientTasks, kb) {
  const acts = kb.activities;
  const critKinds = ["legacyFreeze", "configActivation", "userProvisioning", "masterData", "txData", "cutoverExec", "goNoGo", "ramp"];
  const byStreamClient = {};
  (clientTasks || []).forEach(ct => { (byStreamClient[ct.stream] = byStreamClient[ct.stream] || []).push(ct); });
  const clientKinds = new Set();
  (clientTasks || []).forEach(ct => taskKinds(ct).forEach(k => clientKinds.add(k)));
  const covers = act => {
    const pool = byStreamClient[act.s] || [];
    if (!pool.length) return false;
    const kws = kbKeywords(act.n);
    return pool.some(ct => {
      if (taskKinds(act).some(k => taskKinds(ct).indexOf(k) !== -1)) return true;
      const ctl = (ct.task || "").toLowerCase();
      return kws.some(w => ctl.indexOf(w) !== -1);
    });
  };
  let covered = 0; const missing = [];
  acts.forEach(a => {
    if (covers(a)) covered++;
    else missing.push({ id: a.id, name: a.n, stream: a.s, kind: taskKinds(a), critical: taskKinds(a).some(k => critKinds.indexOf(k) !== -1) });
  });
  const byStream = {};
  Object.keys(kb.streams).forEach(s => {
    const streamActs = acts.filter(a => a.s === s);
    const cov = streamActs.filter(covers).length;
    byStream[s] = { kbTotal: streamActs.length, covered: cov, pct: streamActs.length ? Math.round(cov / streamActs.length * 100) : 0, clientCount: (byStreamClient[s] || []).length };
  });
  const requirementKinds = critKinds.map(k => ({ kind: k, present: clientKinds.has(k), clientCount: (clientTasks || []).filter(ct => taskKinds(ct).indexOf(k) !== -1).length }));
  const unmappedAll = (clientTasks || []).filter(ct => ct.stream === "OTHER" || ct.classified === false);
  return {
    kbActivityCount: acts.length, coveredActivityCount: covered,
    activityCoveragePct: acts.length ? Math.round(covered / acts.length * 100) : 0,
    byStream, requirementKinds,
    criticalMissingKinds: requirementKinds.filter(r => !r.present).map(r => r.kind),
    missingActivities: missing, criticalMissing: missing.filter(m => m.critical),
    unmappedCount: unmappedAll.length, unmappedSample: unmappedAll.map(ct => ct.task).slice(0, 50),
    score: acts.length ? Math.round(covered / acts.length * 100) : 0,
  };
}

// Corpus learning: derive the taxonomy/distribution from a normalised list.
// This is the "self-trained" knowledge object the learning agent keeps.
function learnCorpus(tasks) {
  const inc = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const byStream = {}, byKind = {}, byPhase = {}, byStatus = {};
  const unresolved = [];
  (tasks || []).forEach(t => {
    inc(byStream, t.stream || "OTHER");
    (taskKinds(t).length ? taskKinds(t) : ["(none)"]).forEach(k => inc(byKind, k));
    inc(byPhase, t.phase || "?");
    inc(byStatus, t.status || "?");
    if (t.stream === "OTHER" || t.classified === false) { if (unresolved.length < 25) unresolved.push(t.task); }
  });
  return { count: (tasks || []).length, byStream, byKind, byPhase, byStatus, unresolvedCount: (tasks || []).filter(t => t.stream === "OTHER" || t.classified === false).length, unresolvedSample: unresolved };
}

// Multi-wave model (SAP Activate). Informational rules the alignment applies.
const WAVE_MODEL = {
  rules: [
    "Master data loaded in an earlier wave is the foundation for later-wave transactional data — freeze policies coordinated across waves.",
    "Interfaces & BTP extensions from earlier waves may need reconfiguration/endpoint updates for later-wave scope.",
    "Each wave has its own Go/No-Go decision and acceptance criteria.",
    "You cannot scope more than five countries/regions across main + parallel line before deploying them.",
  ],
  goNoGoCriteria: ["UAT sign-off / integration tests", "End-user training threshold", "No open Priority-1 issues", "Data migration reconciliation validated"],
  src: "SAP Activate · 2nd-Wave/Multi-Wave · FP_45",
};

// Align classified tasks to a wave plan. waves: [{id,label,match?}] where
// match = {streams?:[], kinds?:[], phases?:[], endBefore?:ISO, endAfter?:ISO}.
// A task joins the first wave it matches (waterfall); unmatched → unassigned.
function alignToWaves(tasks, waves) {
  const wlist = (waves && waves.length) ? waves : [{ id: "W1", label: "Wave 1" }];
  const matches = (t, m) => {
    if (!m) return true;
    if (m.streams && m.streams.indexOf(t.stream) === -1) return false;
    if (m.phases && m.phases.indexOf(t.phase) === -1) return false;
    if (m.kinds && !taskKinds(t).some(k => m.kinds.indexOf(k) !== -1)) return false;
    if (m.endBefore && !(t.end && t.end < m.endBefore)) return false;
    if (m.endAfter && !(t.end && t.end >= m.endAfter)) return false;
    return true;
  };
  const buckets = {}; wlist.forEach(w => buckets[w.id] = []);
  const unassigned = [];
  (tasks || []).forEach(t => {
    const w = wlist.find(w => matches(t, w.match));
    if (w) buckets[w.id].push(t); else unassigned.push(t);
  });
  const result = wlist.map((w, i) => ({
    id: w.id,
    label: w.label || w.id,
    tasks: buckets[w.id].slice().sort((a, b) =>
      sequenceRank(a) - sequenceRank(b) || String(a.start || "").localeCompare(String(b.start || "")) || String(a.task).localeCompare(String(b.task))),
    goNoGoGate: { id: w.id + "-GONG", label: (w.label || w.id) + " Go/No-Go", criteria: WAVE_MODEL.goNoGoCriteria.slice() },
    crossWaveDeps: i === 0 ? [] : [{ wave: w.id, dependsOn: wlist[i - 1].id, note: "Later-wave master data depends on prior-wave sign-off; coordinate legacy-freeze policy across waves.", src: WAVE_MODEL.src }],
  }));
  return { waves: result, unassigned };
}
// ─── L4 plan orchestrator (deterministic — the "generate" replacement) ─
// Takes the project inputs (implementation size + cutover start/duration +
// downtime start/duration + go-live), instantiates the SAP L4 activity plan,
// schedules it dependency-aware from the cutover start, computes the critical
// path, and flags every task that falls inside the business downtime window.
function msFromDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr + "T" + (timeStr || "00:00") + ":00Z").getTime();
  return isNaN(t) ? null : t;
}

// Mark tasks whose scheduled window overlaps [dtStartH, dtStartH+dtDurationH).
function flagDowntime(tasks, dtStartH, dtDurationH) {
  const on = dtStartH != null && dtDurationH > 0;
  const dtEndH = on ? dtStartH + dtDurationH : 0;
  return (tasks || []).map(t => {
    const es = t.esH || 0, ef = t.efH != null ? t.efH : es;
    return Object.assign({}, t, { downtime: !!(on && es < dtEndH && ef > dtStartH) });
  });
}

// project: {size, cutoverStartDate, cutoverStartTime, cutoverDurationH,
//           downtimeStartDate, downtimeStartTime, downtimeDurationH, goLiveDate}
function buildScheduledPlan(kb, project) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const tasks = instantiatePlanFromKB(kb, { size, industry: project.industry || "" });
  const cutoverStartMs = msFromDateTime(project.cutoverStartDate, project.cutoverStartTime || "06:00");
  const windowH = Number(project.cutoverDurationH) > 0 ? Number(project.cutoverDurationH) : KB_SIZES[size].window_h;
  const scheduled = scheduleActivities(tasks, cutoverStartMs != null ? { windowStartMs: cutoverStartMs, size } : { size });
  const cp = criticalPath(scheduled);
  let dtStartH = null;
  const dtDurationH = Number(project.downtimeDurationH) > 0 ? Number(project.downtimeDurationH) : 0;
  if (cutoverStartMs != null) {
    const dtMs = msFromDateTime(project.downtimeStartDate, project.downtimeStartTime || "00:00");
    if (dtMs != null) dtStartH = (dtMs - cutoverStartMs) / 3600000;
  }
  const flagged = flagDowntime(cp.tasks, dtStartH, dtDurationH);
  return {
    tasks: flagged,
    size, windowH,
    projectDurationH: cp.projectDurationH,
    fitsWindow: cp.projectDurationH <= windowH,
    overrunH: Math.round(Math.max(0, cp.projectDurationH - windowH) * 100) / 100,
    criticalIds: cp.criticalIds,
    criticalCount: cp.criticalIds.length,
    downtimeCount: flagged.filter(t => t.downtime).length,
  };
}
// ─── Scope document ingestion (waves + scope) ────────────────────────
// A scope document defines what's in scope and, crucially, the WAVE plan with
// per-wave cutover start / go-live timelines. Parse a Waves table + scope.
const WAVE_ALIASES = {
  wave:             ["wave", "wave name", "wave id", "wave #", "wave no", "release", "rollout"],
  scope:            ["scope", "countries", "country", "region", "regions", "entities", "company codes", "modules", "scope items", "legal entities", "in scope"],
  cutoverStartDate: ["cutover start", "cutover start date", "freeze start", "cutover begin", "start", "start date"],
  goLiveDate:       ["go-live", "go live", "golive", "go-live date", "go live date", "production date", "prod go-live", "cutover date"],
  windowH:          ["window", "cutover window", "downtime", "downtime (h)", "window (h)", "duration", "duration (h)"],
};
function matchHeaderField(h, aliasMap) {
  const norm = s => String(s == null ? "" : s).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const x = norm(h);
  if (!x) return null;
  for (const f in aliasMap) { if (aliasMap[f].some(a => norm(a) === x)) return f; }
  return null;
}
function wavesFromMatrix(matrix) {
  const rows = (matrix || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? "" : c).trim() !== ""));
  let hi = -1, header = null;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const hdr = rows[i].map(c => matchHeaderField(c, WAVE_ALIASES));
    const hasWave = hdr.indexOf("wave") !== -1;
    const hasDate = hdr.indexOf("goLiveDate") !== -1 || hdr.indexOf("cutoverStartDate") !== -1;
    if (hasWave && (hasDate || hdr.filter(Boolean).length >= 2)) { hi = i; header = hdr; break; }
  }
  if (hi === -1) return [];
  const out = []; let n = 0;
  rows.slice(hi + 1).forEach(r => {
    const rec = {}; header.forEach((f, i) => { if (f && rec[f] === undefined) rec[f] = r[i]; });
    const waveName = String(rec.wave == null ? "" : rec.wave).trim();
    const gl = parseISODate(rec.goLiveDate), cs = parseISODate(rec.cutoverStartDate);
    if (!waveName && !gl && !cs) return;
    n++;
    out.push({
      id: "W" + n,
      label: waveName || ("Wave " + n),
      scope: rec.scope != null ? String(rec.scope).trim() : "",
      cutoverStartDate: cs || "", cutoverStartTime: "18:00",
      goLiveDate: gl || "",
      windowH: parseDurationToH(rec.windowH) || 0,
    });
  });
  return out;
}
// input: a matrix, OR { sheets: { name: matrix } } (multi-sheet workbook).
function parseScopeDocument(input) {
  let matrices = [];
  if (input && input.sheets) matrices = Object.keys(input.sheets).map(k => input.sheets[k]);
  else if (Array.isArray(input)) matrices = [input];
  let waves = [];
  matrices.forEach(m => { if (!waves.length) { const w = wavesFromMatrix(m); if (w.length) waves = w; } });
  const modules = [], scopeItems = [];
  matrices.forEach(m => {
    const rows = (m || []).filter(r => Array.isArray(r) && r.some(c => String(c == null ? "" : c).trim() !== ""));
    if (!rows.length) return;
    const hdr = rows[0].map(c => String(c == null ? "" : c).toLowerCase().trim());
    const modIdx = hdr.findIndex(h => ["module", "modules", "application", "stream"].indexOf(h) !== -1);
    const siIdx = hdr.findIndex(h => ["scope item", "scope items", "scope item id", "process"].indexOf(h) !== -1);
    rows.slice(1).forEach(r => {
      if (modIdx >= 0) { const v = String(r[modIdx] == null ? "" : r[modIdx]).trim(); if (v && modules.indexOf(v) === -1) modules.push(v); }
      if (siIdx >= 0) { const v = String(r[siIdx] == null ? "" : r[siIdx]).trim(); if (v && scopeItems.indexOf(v) === -1) scopeItems.push(v); }
    });
  });
  return { waves, modules, scopeItems };
}

// Build a scheduled cutover plan PER WAVE from the KB, each anchored to its own
// wave timeline. Ids are prefixed per wave for global uniqueness.
function buildWavePlans(kb, project) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const waves = (project.waves && project.waves.length) ? project.waves : [{
    id: "W1", label: "Wave 1",
    cutoverStartDate: project.cutoverStartDate || "", cutoverStartTime: project.cutoverStartTime || "18:00",
    goLiveDate: project.goLiveDate || "", windowH: Number(project.cutoverDurationH) || 0,
  }];
  const built = waves.map((w, i) => {
    const wp = buildScheduledPlan(kb, {
      size,
      cutoverStartDate: w.cutoverStartDate, cutoverStartTime: w.cutoverStartTime || "18:00",
      cutoverDurationH: w.windowH || project.cutoverDurationH || KB_SIZES[size].window_h,
      downtimeStartDate: w.cutoverStartDate, downtimeStartTime: w.cutoverStartTime || "18:00",
      downtimeDurationH: project.downtimeDurationH || 0,
      goLiveDate: w.goLiveDate,
    });
    const prefix = w.id || ("W" + (i + 1));
    const idMap = {}; wp.tasks.forEach(t => { idMap[t.id] = prefix + "-" + t.id; });
    const tasks = wp.tasks.map(t => Object.assign({}, t, {
      id: idMap[t.id],
      predecessors: (t.predecessors || []).map(p => idMap[p] || p),
      wave: prefix,
    }));
    return {
      id: prefix, label: w.label || prefix, scope: w.scope || "",
      cutoverStartDate: w.cutoverStartDate || "", goLiveDate: w.goLiveDate || "",
      windowH: wp.windowH, projectDurationH: wp.projectDurationH, fitsWindow: wp.fitsWindow, overrunH: wp.overrunH,
      criticalCount: wp.criticalCount, downtimeCount: wp.downtimeCount, taskCount: tasks.length, tasks,
    };
  });
  return { waves: built, totalTasks: built.reduce((a, w) => a + w.taskCount, 0) };
}
// ─── SAP-standard scope & size derivation ────────────────────────────
// Auto-detect implementation size (S/M/L) and in-scope modules from the L4
// plan and/or scope document, using SAP Activate S/M/L criteria: size is the
// LARGEST dimension across waves, countries/entities, scope items, modules,
// RICEFW, and integrations (multi-wave / 8+ clusters / many integrations →
// Large; single country / 1–3 clusters / 1–2 integrations → Small).
const SAP_MODULES = ["FI","CO","MM","SD","PP","QM","PM","EWM","TM","PS","AA","TR","FSCM","GTS","HCM","LE","WM","IM","CS","SRM","CRM","BW","SAC","ARIBA","CONCUR","BTP","EC","SF"];

// SAP Line of Business groups. The LoB name is what the engine reasons with —
// scope items resolve to these, and the per-area task blocks key off them — so
// it is also what gets stored. Codes stay visible in the label for anyone who
// thinks in module codes, and are still what L4 text is scanned for.
const SAP_LOB_GROUPS = [
  { lob: "Finance",                  codes: ["FI","CO","FICO","TR","FSCM","AA","RE"] },
  { lob: "Sales",                    codes: ["SD","CRM"] },
  { lob: "Service",                  codes: ["CS"] },
  { lob: "Manufacturing",            codes: ["PP","QM"] },
  { lob: "Supply Chain",             codes: ["EWM","WM","LE","TM","IM","IBP","SCM","GTS"] },
  { lob: "Sourcing and Procurement", codes: ["MM","SRM","ARIBA"] },
  { lob: "Asset Management",         codes: ["PM","EAM"] },
  { lob: "Human Resources",          codes: ["HR","HCM","EC","SF"] },
  { lob: "R&D and Engineering",      codes: ["PLM","DMS"] },
  { lob: "Professional Services",    codes: ["PS","CONCUR"] },
  { lob: "Technology and Integration", codes: ["BTP","S4CORE","CPI"] },
  { lob: "Data Management",          codes: ["MDG","BW","SAC"] },
];

// "Finance (FI, CO, FICO)" — value stored is the LoB name.
function lobLabel(g) {
  return g.codes.length ? g.lob + " (" + g.codes.slice(0, 3).join(", ") + ")" : g.lob;
}
function sizeRank(s) { return s === "L" ? 3 : s === "M" ? 2 : s === "S" ? 1 : 0; }
function sizeFromCount(n, sMax, mMax) {
  if (n == null) return null;
  if (n <= sMax) return "S";
  if (n <= mMax) return "M";
  return "L";
}
function deriveModules(tasks) {
  const found = new Set();
  (tasks || []).forEach(t => {
    const txt = String((t.task || "") + " " + (t.category || "")).toUpperCase();
    // Scan for module codes but record the LoB name, so auto-detected and
    // hand-picked values are the same vocabulary.
    SAP_LOB_GROUPS.forEach(g => {
      if (g.codes.some(c => new RegExp("\\b" + c + "\\b").test(txt))) found.add(g.lob);
    });
  });
  return Array.from(found);
}
function deriveCountries(waves) {
  const set = new Set();
  (waves || []).forEach(w => String(w.scope || "").split(/[,;/]+/).map(s => s.trim()).filter(Boolean).forEach(s => set.add(s)));
  return Array.from(set);
}
// input: { tasks?, waves?, scopeItems?, modules?, ricefwCount?, integrationCount? }
function deriveScopeSizing(input) {
  input = input || {};
  const tasks = input.tasks || [];
  const waves = input.waves || [];
  const scopeItems = input.scopeItems || [];
  const modules = (input.modules && input.modules.length) ? input.modules.slice() : deriveModules(tasks);
  const countries = deriveCountries(waves);
  const ricefwCount = input.ricefwCount != null ? input.ricefwCount : tasks.filter(t => t.ricefwType).length;
  const integrationCount = input.integrationCount != null ? input.integrationCount : tasks.filter(t => t.stream === "INT").length;

  const votes = {};
  if (waves.length) votes.waves = waves.length >= 2 ? "L" : "S";
  if (countries.length) votes.countries = sizeFromCount(countries.length, 1, 5);
  if (scopeItems.length) votes.scopeItems = sizeFromCount(scopeItems.length, 3, 8);
  if (modules.length) votes.modules = sizeFromCount(modules.length, 3, 8);
  if (ricefwCount) votes.ricefw = sizeFromCount(ricefwCount, 5, 20);
  if (integrationCount) votes.integrations = sizeFromCount(integrationCount, 2, 6);

  let size = "M", best = 0, driver = null;
  Object.keys(votes).forEach(k => { const r = sizeRank(votes[k]); if (r > best) { best = r; size = votes[k]; driver = k; } });
  if (Object.keys(votes).length === 0) size = "M";

  return {
    size, modules, countries, votes, driver,
    signals: { waves: waves.length, countries: countries.length, legalEntities: countries.length, scopeItems: scopeItems.length, modules: modules.length, ricefwCount, integrationCount },
  };
}
// ═══════════════════════════════════════════════════════════════════
// OBJECT-LEVEL SAP CUTOVER LIBRARY (from Joule: Day -10 → Day +5)
// The real object-level, dependency- & blocker-aware sequenced timeline,
// sourced from SAP Process Navigator / Activate Roadmap Viewer. This is the
// agent's authoritative "generate from SAP library" source and its rule set.
// ═══════════════════════════════════════════════════════════════════
// {id, ph:PRE|CUT|HC, s:stream, k:[kinds], n:name, o:owner, d:hours, dep:[preds]}
const OBJECT_TIMELINE = [
  // ── Day -10: Dress Rehearsal & Final Preparation (PRE) ──
  {id:"D10-01",ph:"PRE",s:"GONG",k:[],n:"Dress Rehearsal Conversion Cycle",o:"PM / DM Lead",d:8,dep:[]},
  {id:"D10-02",ph:"PRE",s:"GONG",k:["uatSignoff"],n:"Integration Tests & UAT Sign-Off",o:"Test Lead / PM",d:4,dep:[]},
  {id:"D10-03",ph:"PRE",s:"GONG",k:[],n:"End-User Training Completion Confirmation",o:"Training / OCM Lead",d:2,dep:[]},
  {id:"D10-04",ph:"PRE",s:"TECH",k:[],n:"Production System Readiness Check",o:"Basis / Deployment Lead",d:4,dep:[]},
  {id:"D10-05",ph:"PRE",s:"TECH",k:[],n:"Planned Maintenance Window Check",o:"Basis / PM",d:1,dep:[]},
  {id:"D10-06",ph:"PRE",s:"DM",k:[],n:"Explore Migration Objects – Dependency Validation",o:"DM Lead",d:2,dep:[]},
  // ── Day -5: Pre-Cutover Configuration & Transport Readiness (PRE) ──
  {id:"D5-01",ph:"PRE",s:"CONF",k:["configActivation"],n:"Developer Extensibility Transports (ADT)",o:"Developer / Deployment Lead",d:4,dep:["D10-04"]},
  {id:"D5-02",ph:"PRE",s:"CONF",k:["configActivation"],n:"Key User Extensibility Transports (Software Collections)",o:"Key User / Deployment Lead",d:3,dep:["D5-01"]},
  {id:"D5-03",ph:"PRE",s:"CONF",k:["configActivation"],n:"Customizing Transports & OData Service Configurations",o:"Config / Deployment Lead",d:3,dep:["D5-02"]},
  {id:"D5-04",ph:"PRE",s:"CONF",k:[],n:"Organizational Structure Validation",o:"Config / Finance Lead",d:2,dep:["D5-03"]},
  {id:"D5-05",ph:"PRE",s:"CONF",k:[],n:"Number Ranges (system-specific, not transportable)",o:"Config / Deployment Lead",d:2,dep:["D5-04"]},
  {id:"D5-06",ph:"PRE",s:"CONF",k:[],n:"Posting Periods (GL, AA, CO, MM)",o:"Finance Lead",d:1,dep:["D5-04"]},
  {id:"D5-07",ph:"PRE",s:"SEC",k:["userProvisioning"],n:"User IDs & Business Role Assignments",o:"Security / Deployment Lead",d:4,dep:["D5-03"]},
  {id:"D5-08",ph:"PRE",s:"TECH",k:[],n:"Fiori Launchpad Catalog Sync, Cache Invalidation & New Experience Switch",o:"Basis / Deployment Lead",d:2,dep:["D5-07"]},
  {id:"D5-09",ph:"PRE",s:"TECH",k:[],n:"Embedded Analytics & Enterprise Search Setup",o:"Basis / Analytics Lead",d:2,dep:["D5-08"]},
  {id:"D5-10",ph:"PRE",s:"DM",k:[],n:"Cloud Connector Setup for Direct Transfer (BH3)",o:"Integration / Basis Lead",d:3,dep:["D10-04"]},
  // ── Day -3: Legacy Freeze & Final Data Extraction (CUT) ──
  {id:"D3-01",ph:"CUT",s:"DM",k:[],n:"Close All Open Work Orders in Legacy (EAM)",o:"EAM / Deployment Lead",d:4,dep:[]},
  {id:"D3-02",ph:"CUT",s:"GONG",k:[],n:"Customer Outage Communication",o:"OCM / PM",d:1,dep:[]},
  {id:"D3-03",ph:"CUT",s:"GONG",k:[],n:"Legacy System – Final Operational Transactions",o:"Finance / MM / AP / AR",d:4,dep:["D3-01"]},
  {id:"D3-04",ph:"CUT",s:"GONG",k:["legacyFreeze"],n:"Legacy System Freeze (Phased End-User Lockout)",o:"PM / Basis Lead",d:1,dep:["D3-03"]},
  {id:"D3-05",ph:"CUT",s:"GONG",k:[],n:"Final Data Extraction from Legacy System",o:"DM / Deployment Lead",d:6,dep:["D3-04"]},
  {id:"D3-06",ph:"CUT",s:"GONG",k:[],n:"Old Document Cleanup (prior-year documents)",o:"SD / Finance Lead",d:3,dep:["D3-04"]},
  // ── Day -2: Master Data Load (CUT) ──
  {id:"D2-01",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"G/L Account",o:"Finance / DM Lead",d:3,dep:["D3-05","D5-04"]},
  {id:"D2-02",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Exchange Rate",o:"Finance Lead",d:1,dep:["D2-01"]},
  {id:"D2-03",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Bank Master Data & House Banks",o:"Finance / DM Lead",d:2,dep:["D2-01"]},
  {id:"D2-04",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Cost Center",o:"Controlling / DM Lead",d:2,dep:["D2-01"]},
  {id:"D2-05",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Profit Center",o:"Controlling / DM Lead",d:2,dep:["D2-04"]},
  {id:"D2-06",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Activity Type, Activity Price & Statistical Key Figure",o:"Controlling / DM Lead",d:1,dep:["D2-04"]},
  {id:"D2-07",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Business Partner (General, Customer, Supplier, Dual, Contacts)",o:"AR / AP / DM Lead",d:4,dep:["D2-01"]},
  {id:"D2-08",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Material Master, Batch, Condition Contract",o:"MM / DM Lead",d:4,dep:["D2-01"]},
  {id:"D2-09",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Classification (Class Hierarchy, Characteristic, Class)",o:"MM / EAM / DM Lead",d:2,dep:["D2-08"]},
  {id:"D2-10",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"Material BOM",o:"PP / DM Lead",d:2,dep:["D2-08"]},
  {id:"D2-11",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"EAM Master (Work Center, Task List, Equipment/FLoc BOM)",o:"EAM / DM Lead",d:4,dep:["D2-09"]},
  {id:"D2-12",ph:"CUT",s:"DM",k:["masterData","dmLoad"],n:"PSS Compliance (Product/Raw Material/Substance)",o:"Compliance / DM Lead",d:2,dep:["D2-08"]},
  {id:"D2-13",ph:"CUT",s:"CONF",k:["masterData"],n:"Condition Records (MM, SD) & Pricing Procedures (Pricing Conversion)",o:"MM / SD / Finance Lead",d:3,dep:["D2-07","D2-08"]},
  // ── Day -1: Transactional Data Load (CUT) ──
  {id:"D1-01",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"FI – G/L Account Balance (Balance Sheet & P&L)",o:"Finance / DM Lead",d:4,dep:["D2-01","D2-04","D2-05"]},
  {id:"D1-02",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"FI – Accounts Payable Open Items",o:"AP / DM Lead",d:3,dep:["D2-07","D1-01"]},
  {id:"D1-03",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"FI – Accounts Receivable Open Items",o:"AR / DM Lead",d:3,dep:["D2-07","D1-01"]},
  {id:"D1-04",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"Fixed Assets Values (Useful Life, Depreciation)",o:"Asset Accounting / DM Lead",d:3,dep:["D1-01"]},
  {id:"D1-05",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"Bank Account Balance & Cash Memo Record",o:"Finance / DM Lead",d:2,dep:["D2-03","D1-01"]},
  {id:"D1-06",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"Open Sales Contracts with Manual Conditions",o:"SD / DM Lead",d:3,dep:["D2-07","D2-13","D3-06"]},
  {id:"D1-07",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"Open Sales Orders with Manual Conditions (high volume)",o:"SD / DM Lead",d:8,dep:["D1-06","D2-13"]},
  {id:"D1-08",ph:"CUT",s:"DM",k:[],n:"Sales Order/Contract – Business Validation, BOP Run & Blocking",o:"SD / Business Owner",d:4,dep:["D1-07"]},
  {id:"D1-09",ph:"CUT",s:"DM",k:["txData","dmLoad"],n:"Consent Record",o:"Compliance / DM Lead",d:1,dep:["D2-07"]},
  {id:"D1-10",ph:"CUT",s:"INT",k:[],n:"SAP Integration Suite – Managed Gateway Push & Interface Validation",o:"Integration / Deployment Lead",d:3,dep:["D5-03","D2-07"]},
  {id:"D1-11",ph:"CUT",s:"INT",k:[],n:"SAP Business Network Buyer Account Configuration (Ariba CIG)",o:"Procurement / Integration Lead",d:3,dep:["D2-07","D1-10"]},
  {id:"D1-12",ph:"CUT",s:"TECH",k:[],n:"Batch Jobs Scheduling & Validation",o:"Basis / Deployment Lead",d:2,dep:["D5-09"]},
  // ── Day 0 Part 1: Go/No-Go & EAM Re-Creation (CUT) ──
  {id:"D0-01",ph:"CUT",s:"GONG",k:[],n:"Post-Conversion Validation Reports",o:"DM / Finance / MM / SD",d:4,dep:["D1-01","D1-02","D1-03","D1-04","D1-05","D1-06","D1-07","D1-08"]},
  {id:"D0-02",ph:"CUT",s:"GONG",k:[],n:"Business Sign-Off per Object",o:"PM / Business Owners",d:2,dep:["D0-01"]},
  {id:"D0-03",ph:"CUT",s:"GONG",k:["goNoGo"],n:"Go/No-Go Decision",o:"PM / Steering Committee",d:1,dep:["D0-02","D10-02","D10-03"]},
  {id:"D0-04",ph:"CUT",s:"DM",k:[],n:"Re-Create Open Work Orders in SAP S/4HANA (EAM)",o:"EAM / Deployment Lead",d:4,dep:["D0-03","D3-01"]},
  {id:"D0-05",ph:"CUT",s:"TECH",k:["cutoverExec"],n:"User Unlock & System Release",o:"Basis / Security / Deployment",d:1,dep:["D0-03","D0-04"]},
  // ── Day 0 Part 2: Go-Live Execution & Ramp-Up (CUT) ──
  {id:"D0-06",ph:"CUT",s:"GONG",k:["ramp"],n:"Ramp-Up – Batch Jobs, Interfaces & Master Data Sync",o:"Basis / Integration Lead",d:2,dep:["D0-05"]},
  {id:"D0-07",ph:"CUT",s:"GONG",k:["ramp"],n:"Smoke Tests – Core Business Processes",o:"Functional Leads / Key Users",d:4,dep:["D0-06"]},
  {id:"D0-08",ph:"CUT",s:"GONG",k:[],n:"Legacy System – Set to Display-Only Access",o:"Basis / PM",d:1,dep:["D0-05"]},
  // ── Day +1 to +5: Hypercare (HC) ──
  {id:"H-01",ph:"HC",s:"GONG",k:["ramp"],n:"Hypercare – Incident Tracking & Resolution",o:"PM / Support Lead",d:40,dep:["D0-07"]},
  {id:"H-02",ph:"HC",s:"GONG",k:["ramp"],n:"SAP Cloud Application Services (CAS) – Post Go-Live Ops",o:"PM / CAS Service Manager",d:8,dep:["D0-07"]},
  {id:"H-03",ph:"HC",s:"GONG",k:["ramp"],n:"Training & Onboarding Material – Availability for New Users",o:"Training / OCM Lead",d:4,dep:["D0-07"]},
];

// Hard BLOCKER edges (downstream cannot start until resolved).
const OBJECT_BLOCKERS = [
  ["D2-13","D1-06"], ["D2-13","D1-07"], ["D3-06","D1-06"],
  ["D1-06","D1-07"], ["D0-03","D0-04"], ["D0-03","D0-05"],
];

// SAP's documented critical path (reference; the engine also computes its own).
const OBJECT_CRITICAL_PATH = ["D10-04","D5-01","D5-02","D5-03","D5-04","D2-01","D2-07","D2-13","D1-06","D1-07","D1-08","D0-01","D0-02","D0-03","D0-05","D0-06","D0-07"];

// Agent rules & guidelines (enforced/surfaced during orchestration).
const AGENT_RULES = {
  blockers: [
    "Master Data incl. Pricing Conversion (D2-13) must complete before Open Sales Contracts (D1-06) and Open Sales Orders (D1-07).",
    "Old document cleanup (D3-06) must complete before Open Sales Contracts (D1-06).",
    "Open Sales Contracts (D1-06) must convert before Open Sales Orders (D1-07).",
    "Go/No-Go (D0-03) must be approved before EAM re-creation (D0-04) and User Unlock (D0-05).",
  ],
  sequencing: [
    "Legacy freeze must precede all data-migration loads.",
    "Master data must precede the transactional data that references it.",
    "Configuration activation (transports) must precede production user creation.",
    "Number ranges are system-specific and cannot be transported.",
    "Transport categories (developer / key-user / business config) cannot be merged; import in dependency order.",
  ],
  eam: "No transactional EAM data is migrated. Close all open work orders in legacy before cutover; re-create post-freeze work orders in S/4HANA. Legacy set to display-only after go-live.",
  authorization: "Only SAP_BR_CONFIG_EXPERT_DATA_MIG can trigger conversions in the Migration Cockpit; SAP_BR_BPC_EXPERT is required for the Migration Object Modeler.",
  dressRehearsal: "The latest cutover plan must be validated in a full Dress Rehearsal in Test before productive deployment; refine durations to the minute.",
  maintenanceWindow: "Check SAP for Me system availability for planned maintenance windows to avoid migration terminations.",
  goNoGo: ["Acceptable % of integration tests passed","Sufficient UAT cases validated","No critical open incidents","Master & transactional data accuracy confirmed","End-user training completed","Business sign-off obtained per object","Every task owner validated & approved their task"],
  rollback: ["Critical open incidents unresolved","Data reconciliation variance exceeds threshold","Transport import errors in production","Insufficient UAT pass rate","Critical steps unfinished past deadline","A critical data problem detected"],
};

const OBJECT_REFERENCES = [
  { label: "Process Navigator – S/4HANA Cloud Public Edition (Scope Items)", url: "https://me.sap.com/processnavigator/SolS/EARL_SolS-013/2502?region=US" },
  { label: "Activate Roadmap Viewer – S/4HANA Cloud Public Edition", url: "https://go.support.sap.com/roadmapviewer/#/group/658F507A-D6F5-4B78-9EE1-0300C5F1E40F/roadmapContentPage/IMPS4HANACLDENMGMT" },
  { label: "Available Migration Objects (Migration Cockpit)", url: "https://help.sap.com/S4_CE_MO" },
  { label: "Data Migration – Landing Page", url: "https://help.sap.com/S4_CE_DM" },
  { label: "Cutover Template (S4H_403, XLSX)", url: "https://support.sap.com/content/dam/SAAP/SAP_Activate/S4H_403%20Cutover%20Template.xlsx" },
  { label: "Cutover Strategy Template (FP_45, PPTX)", url: "https://support.sap.com/content/dam/SAAP/SAP_Activate/FP_45%20Cutover%20Strategy.pptx" },
  { label: "How to Approach Remote Cutover (S4H_747, PPTX)", url: "https://support.sap.com/content/dam/SAAP/SAP_Activate/S4H_747%20How%20to%20Approach%20Remote%20Cutover.pptx" },
];


// Instantiate object-level tasks (task-schema) for a size, with blocker flags.
function objectTasksForSize(size) {
  const hi = ["legacyFreeze", "masterData", "txData", "goNoGo", "cutoverExec"];
  const blkTo = {}; OBJECT_BLOCKERS.forEach(e => { (blkTo[e[1]] = blkTo[e[1]] || []).push(e[0]); });
  return OBJECT_TIMELINE.map(a => ({
    id: a.id, task: a.n, phase: a.ph, workstream: a.s, stream: a.s, category: KB_STREAMS[a.s] || a.s,
    owner: a.o, durationH: Math.round((a.d) * ((KB_SIZES[size] && KB_SIZES[size].mult) || 1) * 100) / 100,
    status: "PENDING", priority: (a.k || []).some(k => hi.indexOf(k) !== -1) ? "HIGH" : "MEDIUM",
    predecessors: (a.dep || []).slice(), kind: a.k || [], blockerPreds: blkTo[a.id] || [],
  }));
}

// Object-level plan build (the new "generate from SAP library").
function buildObjectPlan(project) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const tasks = objectTasksForSize(size);
  const cutoverStartMs = msFromDateTime(project.cutoverStartDate, project.cutoverStartTime || "06:00");
  const windowH = Number(project.cutoverDurationH) > 0 ? Number(project.cutoverDurationH) : KB_SIZES[size].window_h;
  const scheduled = scheduleActivities(tasks, cutoverStartMs != null ? { windowStartMs: cutoverStartMs, size } : { size });
  const cp = criticalPath(scheduled);
  let dtStartH = null; const dtDur = Number(project.downtimeDurationH) > 0 ? Number(project.downtimeDurationH) : 0;
  if (cutoverStartMs != null) { const dtMs = msFromDateTime(project.downtimeStartDate, project.downtimeStartTime || "00:00"); if (dtMs != null) dtStartH = (dtMs - cutoverStartMs) / 3600000; }
  const flagged = flagDowntime(cp.tasks, dtStartH, dtDur);
  return {
    tasks: flagged, size, windowH,
    projectDurationH: cp.projectDurationH, fitsWindow: cp.projectDurationH <= windowH,
    overrunH: Math.round(Math.max(0, cp.projectDurationH - windowH) * 100) / 100,
    criticalIds: cp.criticalIds, criticalCount: cp.criticalIds.length,
    downtimeCount: flagged.filter(t => t.downtime).length, blockerCount: OBJECT_BLOCKERS.length,
    source: "object-timeline",
  };
}

// Per-wave object-level build (namespaced ids).
function buildObjectWavePlans(project) {
  project = project || {};
  const waves = (project.waves && project.waves.length) ? project.waves : [{
    id: "W1", label: "Wave 1", cutoverStartDate: project.cutoverStartDate || "", cutoverStartTime: project.cutoverStartTime || "18:00",
    goLiveDate: project.goLiveDate || "", windowH: Number(project.cutoverDurationH) || 0,
  }];
  const built = waves.map((w, i) => {
    const wp = buildObjectPlan({
      size: project.size,
      cutoverStartDate: w.cutoverStartDate, cutoverStartTime: w.cutoverStartTime || "18:00",
      cutoverDurationH: w.windowH || project.cutoverDurationH || 0,
      downtimeStartDate: w.cutoverStartDate, downtimeStartTime: w.cutoverStartTime || "18:00",
      downtimeDurationH: project.downtimeDurationH || 0, goLiveDate: w.goLiveDate,
    });
    const prefix = w.id || ("W" + (i + 1));
    const idMap = {}; wp.tasks.forEach(t => { idMap[t.id] = prefix + "-" + t.id; });
    const tasks = wp.tasks.map(t => Object.assign({}, t, {
      id: idMap[t.id],
      predecessors: (t.predecessors || []).map(p => idMap[p] || p),
      blockerPreds: (t.blockerPreds || []).map(p => idMap[p] || p),
      wave: prefix,
    }));
    return { id: prefix, label: w.label || prefix, scope: w.scope || "", cutoverStartDate: w.cutoverStartDate || "", goLiveDate: w.goLiveDate || "", windowH: wp.windowH, projectDurationH: wp.projectDurationH, fitsWindow: wp.fitsWindow, overrunH: wp.overrunH, criticalCount: wp.criticalCount, downtimeCount: wp.downtimeCount, blockerCount: wp.blockerCount, taskCount: tasks.length, tasks, delta: i > 0, deltaNote: i > 0 ? "Delta migration — captures changes since the prior wave; legacy remains display-only." : "" };
  });
  return { waves: built, totalTasks: built.reduce((a, w) => a + w.taskCount, 0) };
}

// Object-level gap analysis: which timeline activities does the client plan cover?
function analyzeTimelineCoverage(clientTasks) {
  const gates = ["legacyFreeze", "masterData", "txData", "goNoGo", "cutoverExec", "uatSignoff"];
  const covers = a => {
    const kws = kbKeywords(a.n);
    return (clientTasks || []).some(ct => {
      const ctl = (ct.task || "").toLowerCase();
      return kws.some(w => ctl.indexOf(w) !== -1);
    });
  };
  let covered = 0; const missing = [];
  OBJECT_TIMELINE.forEach(a => {
    if (covers(a)) covered++;
    else missing.push({ id: a.id, name: a.n, phase: a.ph, stream: a.s, critical: (a.k || []).some(k => gates.indexOf(k) !== -1) });
  });
  return {
    total: OBJECT_TIMELINE.length, covered, pct: Math.round(covered / OBJECT_TIMELINE.length * 100),
    missing, criticalMissing: missing.filter(m => m.critical),
  };
}
// ─── Real L4 workbook reader (28-col plans with dependencies) ─────────
// Handles: title rows above the header, newline-wrapped headers, L1/L2
// section-separator rows, hierarchical WBS ids, DAYS durations, role owners
// with <Name>/blank placeholders, and dependencies expressed by predecessor
// ROW # (1-based Excel row) + predecessor task name + FS/SID/Phase type.
function normHdr(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/\n/g, " ").replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
const L4_ALIASES = {
  wbs: ["wbs", "wbs id"],
  level: ["level"],                                                                   // simple L4: L1/L2/L3/L4 hierarchy column
  phase: ["l1 phase", "l1", "phase"], workstream: ["l2 workstream", "l2", "workstream"],
  l3: ["l3"], scopeItem: ["scope item id", "scope item", "scope id"],
  task: ["l4 task", "activity description", "task", "activity", "story"],            // "story" covers simple L4 row-2 headers
  activityType: ["activity type", "work type"],
  owner: ["owner", "assignee"],                                                       // "assignee" covers simple L4
  team: ["team"], start: ["start date", "start"], end: ["end date", "end"],
  days: ["days", "duration"],                                                         // "duration" matches "Duration (Days)" after normHdr strips parens
  workDays: ["work days"], pctDone: ["done", "percent done"],
  predRow: ["pred row", "predecessor row"], predTask: ["predecessor task", "predecessor"], depType: ["dependency type"],
  goLive: ["go live relevance"], priority: ["priority"], lob: ["lob"], businessArea: ["business area"],
  purpose: ["purpose what to do", "purpose"],
};
function matchAlias(x, aliases) { for (const f in aliases) { if (aliases[f].some(a => normHdr(a) === x)) return f; } return null; }
function mapHeaderRow(cells, aliases) {
  const map = {}; (cells || []).forEach((c, i) => { const f = matchAlias(normHdr(c), aliases); if (f && map[f] === undefined) map[f] = i; });
  return map;
}
function findL4Header(matrix) {
  for (let i = 0; i < Math.min((matrix || []).length, 25); i++) {
    const map = mapHeaderRow(matrix[i] || [], L4_ALIASES);
    // Standard L4: WBS + task + dependency columns
    if (map.wbs != null && map.task != null && (map.predRow != null || map.predTask != null || map.depType != null)) return { row: i, map };
    // Simple L4: Level hierarchy (L1/L2/L3/L4) + task + phase — no WBS or predecessors required
    if (map.level != null && map.task != null && map.phase != null) return { row: i, map, simple: true };
  }
  return null;
}
function looksLikeL4(matrix) { return !!findL4Header(matrix); }

const DISCIPLINE_OWNER = {
  "finance": "Finance / Functional Lead", "controlling": "Finance / Functional Lead",
  "sales": "SD / Functional Lead", "supply chain": "Logistics / Functional Lead",
  "sourcing and procurement": "MM / Functional Lead", "procurement": "MM / Functional Lead", "manufacturing": "PP / Functional Lead",
  "data migration": "Data Migration Lead", "ricefw": "RICEFW / Development Lead", "development": "RICEFW / Development Lead",
  "security": "Security Lead", "integration": "Integration Lead", "technical": "Basis / Technical Lead", "basis": "Basis / Technical Lead",
  "application platform": "Basis / Technical Lead", "infrastructure": "Basis / Technical Lead", "platform": "Basis / Technical Lead",
  "analytics": "Analytics Expert", "reporting": "Analytics Expert", "master data": "Data Migration Lead",
  "cutover": "Cutover / Project Manager", "testing": "Test Lead", "test": "Test Lead",
  "organizational change management": "OCM Lead", "change management": "OCM Lead", "training": "Training / OCM Lead",
  "extensibility": "Extensibility Expert", "project management": "Project Manager", "governance": "Project Manager",
};
function deriveOwnerFromWorkstream(ws) {
  const w = String(ws || "").toLowerCase();
  for (const k in DISCIPLINE_OWNER) { if (w.indexOf(k) !== -1) return DISCIPLINE_OWNER[k]; }
  return "Project Team";
}
function isPlaceholderOwner(o) {
  const v = String(o == null ? "" : o).toLowerCase().trim();
  return v === "" || v === "—" || v === "-" || v === "tbd" || v === "n/a" || /<name>/.test(v);
}

// Parse a real L4 workbook (matrix of rows) → enriched task-schema objects.
function parseL4Workbook(matrix) {
  const found = findL4Header(matrix);
  if (!found) return { tasks: [], meta: { taskCount: 0 } };
  const map = found.map, hi = found.row;
  const get = (r, f) => (map[f] != null ? r[map[f]] : undefined);
  const sv = x => String(x == null ? "" : x).trim();

  // ── Simple L4 format: Level column (L1/L2/L3/L4), task in Story/Task col, no WBS or predecessors ──
  if (found.simple) {
    const tasks = [], phases = new Set(), wss = new Set();
    let idx = 0;
    for (let j = hi + 1; j < matrix.length; j++) {
      const r = matrix[j] || [];
      if (sv(get(r, "level")).toUpperCase() !== "L4") continue;
      const name = sv(get(r, "task")).replace(/\s+/g, " ");
      if (!name) continue;
      const ws = sv(get(r, "workstream")), l1 = sv(get(r, "phase"));
      const rawOwner = sv(get(r, "owner"));
      const owner = isPlaceholderOwner(rawOwner) ? deriveOwnerFromWorkstream(ws) : rawOwner;
      const days = Number(get(r, "days")) || 0;
      const cls = classifyActivity(name + " " + ws);
      phases.add(l1 || "?"); if (ws) wss.add(ws);
      idx++;
      tasks.push({
        id: String(idx).padStart(4, "0"), task: name, phase: l1 || "", workstream: ws || cls.stream,
        stream: cls.stream, scopeItem: "",
        owner, ownerDerived: isPlaceholderOwner(rawOwner), durationDays: days, durationH: days * 8,
        startDate: parseISODate(get(r, "start")), endDate: parseISODate(get(r, "end")),
        predecessors: [], depType: "", goLive: "", priority: "MEDIUM", status: "PENDING",
        kind: cls.kind ? [cls.kind] : [], ricefwType: classifyRicefw(name + " " + ws),
        notes: "",
      });
    }
    return { tasks, meta: { taskCount: tasks.length, phases: [...phases], workstreams: [...wss], scopeItems: [], depsResolved: 0, ownersDerived: 0 } };
  }

  // ── Standard L4 format: WBS + predecessors ──
  const wbsRe = /^\d+(\.\d+)*$/;
  // WBS by 1-based Excel row (for PRED. ROW # resolution) + name→WBS fallback.
  const wbsByRow = {}, nameToWbs = {};
  (matrix || []).forEach((r, j) => {
    const w = sv(get(r, "wbs"));
    if (wbsRe.test(w)) {
      wbsByRow[j + 1] = w;
      const nm = sv(get(r, "task")).replace(/\s+/g, " ").toLowerCase();
      if (nm) nameToWbs[nm] = w;
    }
  });
  const tasks = [], phases = new Set(), wss = new Set(), scopeSet = new Set();
  let depsResolved = 0, ownersDerived = 0;
  for (let j = hi + 1; j < matrix.length; j++) {
    const r = matrix[j] || [];
    const wbs = sv(get(r, "wbs"));
    const name = sv(get(r, "task")).replace(/\s+/g, " ");
    if (!wbsRe.test(wbs) || !name) continue; // skip section separators / blanks
    const ws = sv(get(r, "workstream")), l1 = sv(get(r, "phase")), scope = sv(get(r, "scopeItem"));
    const depType = sv(get(r, "depType"));
    // predecessors: PRED. ROW # → WBS, else predecessor-name → WBS
    let preds = [];
    const pr = parseInt(sv(get(r, "predRow")), 10);
    if (isFinite(pr) && wbsByRow[pr] && wbsByRow[pr] !== wbs) preds = [wbsByRow[pr]];
    else { const pt = sv(get(r, "predTask")).replace(/\s+/g, " ").toLowerCase(); if (pt && nameToWbs[pt] && nameToWbs[pt] !== wbs) preds = [nameToWbs[pt]]; }
    if (/phase start/i.test(depType)) preds = [];
    if (preds.length) depsResolved++;
    // owner (derive discipline owner for <Name>/blank placeholders)
    const rawOwner = sv(get(r, "owner"));
    let owner = rawOwner, ownerDerived = false;
    if (isPlaceholderOwner(rawOwner)) { owner = deriveOwnerFromWorkstream(ws); ownerDerived = true; ownersDerived++; }
    const days = Number(get(r, "days")) || Number(get(r, "workDays")) || 0;
    const prRaw = sv(get(r, "priority")), goLive = sv(get(r, "goLive"));
    const priority = prRaw === "1" ? "HIGH" : prRaw === "2" ? "MEDIUM" : prRaw === "3" ? "LOW" : (/mandatory/i.test(goLive) ? "HIGH" : "MEDIUM");
    const pd = Number(get(r, "pctDone"));
    const status = isFinite(pd) ? (pd >= 100 ? "COMPLETE" : pd > 0 ? "IN_PROGRESS" : "PENDING") : "PENDING";
    const cls = classifyActivity(name + " " + ws);
    phases.add(l1 || "?"); if (ws) wss.add(ws); if (scope) scopeSet.add(scope);
    tasks.push({
      id: wbs, task: name, phase: l1 || "", workstream: ws || cls.stream, stream: cls.stream, scopeItem: scope,
      owner, ownerDerived, durationDays: days, durationH: days * 8,
      startDate: parseISODate(get(r, "start")), endDate: parseISODate(get(r, "end")),
      predecessors: preds, depType, goLive, priority, status,
      kind: cls.kind ? [cls.kind] : [], ricefwType: classifyRicefw(name + " " + ws),
      notes: sv(get(r, "purpose")).slice(0, 200),
    });
  }
  return { tasks, meta: { headerRow: hi, taskCount: tasks.length, phases: Array.from(phases), workstreams: Array.from(wss), scopeItems: Array.from(scopeSet), depsResolved, ownersDerived } };
}
// Break dependency cycles (real plans sometimes contain them). Returns an
// acyclic copy + the list of dropped back-edges, so the UI can report them.
function breakCycles(tasks) {
  const present = new Set((tasks || []).map(t => t.id));
  const preds = {}; (tasks || []).forEach(t => { preds[t.id] = (t.predecessors || []).filter(p => present.has(p)); });
  const removed = [];
  const remaining = new Set((tasks || []).map(t => t.id));
  const order = [];
  while (remaining.size) {
    const d = {}; remaining.forEach(id => d[id] = 0);
    remaining.forEach(id => preds[id].forEach(p => { if (remaining.has(p)) d[id]++; }));
    const zero = Array.from(remaining).filter(id => d[id] === 0).sort();
    if (zero.length) { zero.forEach(id => { order.push(id); remaining.delete(id); }); }
    else {
      const pick = Array.from(remaining).sort((a, b) => preds[a].length - preds[b].length)[0];
      const cut = preds[pick].filter(p => remaining.has(p));
      removed.push({ id: pick, dropped: cut.slice() });
      preds[pick] = preds[pick].filter(p => !remaining.has(p));
    }
  }
  return { tasks: (tasks || []).map(t => Object.assign({}, t, { predecessors: preds[t.id] || [] })), removed };
}
// ─── Generate the CUTOVER plan from an L4 (scope + go-live readiness) ──
// The L4 is the readiness basis (config/build/test per scope). The cutover
// plan is GENERATED from the SAP object library, scoped to what the L4 covers,
// and each cutover activity is gated on its L4 prerequisites being complete.
const CUTOVER_ACTIVITY_MODULE = {
  "D2-01": "Finance", "D2-02": "Finance", "D2-03": "Finance", "D2-04": "Controlling", "D2-05": "Controlling", "D2-06": "Controlling",
  "D2-07": "Finance", "D2-08": "Supply Chain", "D2-09": "Supply Chain", "D2-10": "Manufacturing", "D2-11": "Asset Management", "D2-12": "Compliance", "D2-13": "Sales",
  "D1-01": "Finance", "D1-02": "Finance", "D1-03": "Finance", "D1-04": "Finance", "D1-05": "Finance", "D1-06": "Sales", "D1-07": "Sales", "D1-08": "Sales", "D1-09": "Compliance",
  "D1-10": "Integration", "D1-11": "Sourcing and Procurement", "D1-12": "Technical", "D3-01": "Asset Management", "D0-04": "Asset Management",
};
// Data-object activities that can be scoped OUT if the L4 doesn't cover them.
const SCOPEABLE_CUTOVER_IDS = new Set(Object.keys(CUTOVER_ACTIVITY_MODULE));
function moduleForActivity(id, stream) {
  if (CUTOVER_ACTIVITY_MODULE[id]) return CUTOVER_ACTIVITY_MODULE[id];
  return ({ CONF: "Configuration", SEC: "Security", TECH: "Technical", GONG: "Project", DM: "Data Migration", INT: "Integration" })[stream] || "Project";
}
function matchWsReadiness(moduleName, readinessByWs) {
  const m = String(moduleName || "").toLowerCase();
  const cand = [m];
  if (m === "finance" || m === "controlling") cand.push("finance", "controlling");
  if (m === "asset management") cand.push("asset", "eam", "maintenance");
  if (m === "manufacturing") cand.push("manufactur", "production", "supply chain");
  if (m === "sourcing and procurement") cand.push("sourcing", "procurement", "purchas");
  if (m === "technical") cand.push("technical", "platform", "infrastructure", "basis");
  if (m === "configuration") cand.push("config", "application design");
  if (m === "project") cand.push("project", "governance", "cutover");
  if (m === "sales") cand.push("sales", "order");
  for (const w in readinessByWs) { if (cand.some(c => w.indexOf(c) !== -1)) return readinessByWs[w]; }
  return null;
}
// Extract scope + per-workstream readiness (% complete) from the L4 tasks.
function deriveCutoverScopeFromL4(l4Tasks) {
  const ws = {};
  (l4Tasks || []).forEach(t => {
    const w = String(t.workstream || "").toLowerCase().trim(); if (!w) return;
    ws[w] = ws[w] || { total: 0, complete: 0, name: t.workstream };
    ws[w].total++; if (t.status === "COMPLETE" || t.status === "VERIFIED") ws[w].complete++;
  });
  const readinessByWs = {};
  Object.keys(ws).forEach(w => { readinessByWs[w] = { total: ws[w].total, complete: ws[w].complete, pct: ws[w].total ? Math.round(ws[w].complete / ws[w].total * 100) : 0, name: ws[w].name }; });
  return {
    readinessByWs,
    workstreams: Object.keys(ws).map(w => ws[w].name),
    scopeItems: Array.from(new Set((l4Tasks || []).map(t => t.scopeItem).filter(Boolean))),
    modules: deriveModules(l4Tasks),
    l4Count: (l4Tasks || []).length,
  };
}
// Generate the scoped, readiness-gated cutover plan from an L4.
function buildCutoverFromL4(l4Tasks, project) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const scope = deriveCutoverScopeFromL4(l4Tasks);
  let base = objectTasksForSize(size).filter(a => {
    if (!SCOPEABLE_CUTOVER_IDS.has(a.id)) return true;           // mandatory cutover step
    return !!matchWsReadiness(CUTOVER_ACTIVITY_MODULE[a.id], scope.readinessByWs); // keep only if L4 covers it
  }).map(a => {
    const mod = moduleForActivity(a.id, a.stream);
    const r = matchWsReadiness(mod, scope.readinessByWs);
    return Object.assign({}, a, {
      module: mod,
      readinessPct: r ? r.pct : null, readinessComplete: r ? r.complete : null, readinessTotal: r ? r.total : null,
      readinessWs: r ? r.name : null, ready: r ? r.pct >= 100 : true,
    });
  });
  const cutoverStartMs = msFromDateTime(project.cutoverStartDate, project.cutoverStartTime || "06:00");
  const windowH = Number(project.cutoverDurationH) > 0 ? Number(project.cutoverDurationH) : KB_SIZES[size].window_h;
  const scheduled = scheduleActivities(base, cutoverStartMs != null ? { windowStartMs: cutoverStartMs, size } : { size });
  const cp = criticalPath(scheduled);
  let dtStartH = null; const dtDur = Number(project.downtimeDurationH) > 0 ? Number(project.downtimeDurationH) : 0;
  if (cutoverStartMs != null) { const dtMs = msFromDateTime(project.downtimeStartDate, project.downtimeStartTime || "00:00"); if (dtMs != null) dtStartH = (dtMs - cutoverStartMs) / 3600000; }
  const flagged = flagDowntime(cp.tasks, dtStartH, dtDur);
  return {
    tasks: flagged, scope, size, windowH,
    projectDurationH: cp.projectDurationH, fitsWindow: cp.projectDurationH <= windowH, overrunH: Math.round(Math.max(0, cp.projectDurationH - windowH) * 100) / 100,
    criticalIds: cp.criticalIds, criticalCount: cp.criticalIds.length, downtimeCount: flagged.filter(t => t.downtime).length, blockerCount: OBJECT_BLOCKERS.length,
  };
}
// Go-live readiness rollup over the generated cutover plan.
function analyzeGoLiveReadiness(cutoverTasks) {
  const gated = (cutoverTasks || []).filter(t => t.readinessPct != null);
  const ready = gated.filter(t => t.ready).length;
  const notReady = gated.filter(t => !t.ready).map(t => ({ id: t.id, task: t.task, module: t.module, readinessPct: t.readinessPct, readinessWs: t.readinessWs }));
  const byModule = {};
  gated.forEach(t => { const m = t.module || "Other"; byModule[m] = byModule[m] || { pct: t.readinessPct, ws: t.readinessWs }; });
  return { total: (cutoverTasks || []).length, gated: gated.length, ready, notReady, byModule, overallPct: gated.length ? Math.round(gated.reduce((a, t) => a + t.readinessPct, 0) / gated.length) : null };
}
// ─── Cutover orchestration (Joule): Big Bang vs Wave ─────────────────
// How the cutover is orchestrated differs by deployment mode. This drives the
// agent's understanding of per-object behaviour, sequence, and gates per mode.
const CUTOVER_ORCHESTRATION = {
  version: "joule-orch-2025.1",
  strategies: {
    big_bang: { label: "Big Bang", window: "Single, longer downtime window; higher risk, simpler coordination", dataMigration: "All master & transactional data migrated in one run", legacy: "Frozen & decommissioned after the single go-live", integration: "All integrations cut over simultaneously", rollback: "Higher — full rollback if go/no-go fails", planning: "Single cutover plan, one go-live milestone" },
    waves: { label: "Wave / Phased", window: "Multiple shorter windows per wave; lower risk per event, sustained orchestration", dataMigration: "Migrated per wave scope; delta logic captures changes between waves", legacy: "Runs in parallel until the final wave; display-only for historical reference", integration: "Repointed wave by wave — master flows first, then transactional, gated by smoke tests", rollback: "Lower per wave — prior waves stay live", planning: "Wave-driven: a go-live-readiness milestone per wave + mock cycles inside each wave" },
  },
  executionSequence: ["Source system freeze", "Delta extraction", "Final production data load", "Rapid validation", "Go/No-Go decision", "Go-Live"],
  acceptanceCriteria: [
    "Acceptable % of integration tests and UAT cases passed",
    "Specified number of end users trained and ready",
    "No critical open support cases",
    "Master & transactional data accuracy validated with business sign-off",
    "Production technical checklist complete (licenses, jobs, client settings, SSL/SSO, RFC, backups, failover)",
    "All cutover rehearsal defects closed",
  ],
  objectBehavior: {
    "Master Data": { big_bang: "Full load of all master data in one run; pre/post-load verification; reconciliation pack.", waves: "Load per wave scope; wave 1 loads master flows first; later waves load incremental/new-scope master data." },
    "Open Items / Transactional": { big_bang: "All open items in one run; close open work orders in legacy first; re-create items created between cutover and go-live; extra care on Fixed Assets (Useful Life, Depreciation), AP, AR.", waves: "Per wave scope; delta logic captures inter-wave changes; prior waves already live; legacy display-only for history until final wave." },
    "Initial Balances": { big_bang: "Upload all initial balances with consistency verification; upload historical exchange rates.", waves: "Upload balances per wave / company code; verify per wave before proceeding." },
    "Configuration & Settings": { big_bang: "Validate full org structure; all number ranges created; posting periods opened (GL/AA/CO/MM).", waves: "Config per wave via transport (Dev→Test→Prod); system-specific settings (number ranges) set directly in the production tenant." },
    "Transports & Technical": { big_bang: "Full import of developer / key-user / business-config transports in one release; validate TMS, RFC, SSL/SSO.", waves: "Released & imported wave by wave via Import Collection; dependencies enforced; transport categories never merged." },
    "Integration & Interfaces": { big_bang: "All channels cut over simultaneously; validate all RFCs.", waves: "Repointed wave by wave; master flows first then transactional; each wave gated by smoke tests. Shutdown = blanket; startup = sequenced." },
    "Security & Authorizations": { big_bang: "All roles built/assigned/tested; BP roles assigned; auth trace validated.", waves: "Roles activated per wave; new roles for wave-N users before that wave's go-live. Production never on a Non-Prod IAS tenant." },
    "Fiori & Analytics": { big_bang: "Backend catalog sync; BW info objects active; Enterprise Search setup; users clear cache.", waves: "Same activities per wave; new apps activated per wave user group before go-live." },
    "Historical / Archived Data": { big_bang: "Legacy decommissioned post go-live; archiving/purging completed.", waves: "Legacy display-only until final-wave decommissioning; historical data accessible to authorized users." },
  },
  sequencingRules: [
    "Master data must be fully loaded and validated before transactional/open-item loads begin.",
    "Waves: separate innovation-lifecycle activities in the main line from new-scope config in the parallel line to avoid config-record interdependencies.",
    "3-system landscape: SAP Central Business Configuration main-line/parallel-line workspaces are blocked/unblocked by the running lifecycle process (Branch/Rebase/Merge) — plan wave timelines around those windows.",
    "Transport categories (developer, key-user, business config) cannot be merged; manage independently.",
    "Wave interface cutovers: shutdown is a blanket action; startup is controlled & sequenced per wave, gated by smoke tests.",
    "Some master data must exist before configuration that references it can be activated — prepare those dependencies early.",
    "Plan around SAP-for-Me planned maintenance windows to avoid data-migration terminations.",
  ],
  references: [
    { label: "Parallel Line — S/4HANA Cloud Public Edition", url: "https://help.sap.com/docs/SAP_S4HANA_CLOUD/b249d650b15e4b3d9fc2077ee921abd0/ba3c2949cab04efbb7136bcab7e69ff0.html" },
    { label: "Project Planning Considerations (main vs parallel line)", url: "https://help.sap.com/docs/SAP_S4HANA_CLOUD/b249d650b15e4b3d9fc2077ee921abd0/55cdb9f1ae2e4791b84b50fa57b37592.html" },
    { label: "System-specific settings (3SL)", url: "https://help.sap.com/docs/SAP_S4HANA_CLOUD/b249d650b15e4b3d9fc2077ee921abd0/system-specific-settings" },
    { label: "Import Collection app", url: "https://help.sap.com/docs/SAP_S4HANA_CLOUD/b249d650b15e4b3d9fc2077ee921abd0/import-collection" },
    { label: "SAP Cloud ALM", url: "https://help.sap.com/docs/cloud-alm" },
    { label: "Transport Management FAQ (Note 3401738)", url: "https://me.sap.com/notes/3401738" },
    { label: "SAP for Me — system availability (maintenance windows)", url: "https://me.sap.com/systemsprovisioning/availability" },
  ],
};
// Determine deployment mode from the project (waves ⇒ wave; approach 'Phased' ⇒ wave).
function orchestrationMode(project) {
  if (project && project.waves && project.waves.length > 1) return "waves";
  const a = String((project && project.approach) || "").toLowerCase();
  if (a.indexOf("phas") !== -1 || a.indexOf("wave") !== -1) return "waves";
  return "big_bang";
}
// Full orchestration profile for a mode (strategy + per-object behaviour + rules).
function orchestrationProfile(mode) {
  const m = mode === "waves" ? "waves" : "big_bang";
  const s = CUTOVER_ORCHESTRATION.strategies[m];
  const objectBehavior = {};
  Object.keys(CUTOVER_ORCHESTRATION.objectBehavior).forEach(k => { objectBehavior[k] = CUTOVER_ORCHESTRATION.objectBehavior[k][m]; });
  return {
    mode: m, label: s.label, window: s.window, dataMigration: s.dataMigration, legacy: s.legacy,
    integration: s.integration, rollback: s.rollback, planning: s.planning,
    executionSequence: CUTOVER_ORCHESTRATION.executionSequence.slice(),
    acceptanceCriteria: CUTOVER_ORCHESTRATION.acceptanceCriteria.slice(),
    sequencingRules: CUTOVER_ORCHESTRATION.sequencingRules.slice(),
    objectBehavior,
  };
}
// ─── DETAILED cutover checklist (per object / interface / workstream) ──
// Expands the object-level backbone into a full production go-live checklist:
// each data object → load / validate / sign-off; each interface → activate /
// smoke test; each functional workstream → legacy freeze + post-go-live sign-off.
// Object catalog enriched with wave (0-5), specific owner, and SAP activity text
// (from the Joule wave-by-wave guideline). k = master|tx, w = wave number.
const CUTOVER_DATA_OBJECTS = [
  // ── Wave 1 — Core Finance & Controlling (FI/CO) ──
  { ws: "Finance", n: "G/L Account", k: "master", w: 1, o: "Data Migration Lead", act: "Extract from legacy; cleanse & map to S/4HANA Chart of Accounts; load via Migration Cockpit; post-load verification vs source count & key fields" },
  { ws: "Finance", n: "Exchange Rate", k: "master", w: 1, o: "Data Migration Lead", act: "Upload historical exchange rates, including those required for initial balance uploads" },
  { ws: "Finance", n: "Bank Master & House Banks", k: "master", w: 1, o: "Finance Lead", act: "Complete Manage House Banks & Manage Bank Accounts settings; load bank master; validate bank determination" },
  { ws: "Finance", n: "Tax Codes", k: "master", w: 1, o: "Functional Lead", act: "Validate & transport tax configuration; confirm tax codes active in production" },
  { ws: "Controlling", n: "Cost Center", k: "master", w: 1, o: "Data Migration Lead", act: "Extract hierarchy & attributes; validate Controlling Area assignment; load via Migration Cockpit; verify groups & hierarchies" },
  { ws: "Controlling", n: "Profit Center", k: "master", w: 1, o: "Data Migration Lead", act: "Extract & map to Controlling Area; load via Migration Cockpit; validate profit center hierarchy" },
  { ws: "Controlling", n: "Activity Type & Price", k: "master", w: 1, o: "Data Migration Lead", act: "Load activity types & prices; validate against cost centers" },
  { ws: "Controlling", n: "Statistical Key Figure", k: "master", w: 1, o: "Data Migration Lead", act: "Load statistical key figures; validate CO assignments" },
  { ws: "Controlling", n: "Internal Order", k: "master", w: 1, o: "Data Migration Lead", act: "Load internal orders; validate order types & settlement rules" },
  { ws: "Finance", n: "G/L Account Balances", k: "tx", w: 1, o: "Finance Lead", act: "Upload initial GL balances with consistency verification; reconcile per company code vs legacy trial balance" },
  { ws: "Finance", n: "Accounts Payable Open Items", k: "tx", w: 1, o: "Finance Lead", act: "Upload open payables; attention to aging buckets, due dates & document currency; reconcile item count & value" },
  { ws: "Finance", n: "Accounts Receivable Open Items", k: "tx", w: 1, o: "Finance Lead", act: "Upload open receivables; attention to aging buckets, due dates & document currency; reconcile item count & value" },
  { ws: "Finance", n: "Bank Account Balances", k: "tx", w: 1, o: "Finance Lead", act: "Upload bank account balances; reconcile vs legacy" },
  // ── Wave 2 — Procurement & Inventory (MM/WM) ──
  { ws: "Supply Chain", n: "Material Master", k: "master", w: 2, o: "Data Migration Lead", act: "Extract material master; map to S/4HANA material types; load via Migration Cockpit; validate base UoM, material group & plant assignments" },
  { ws: "Supply Chain", n: "Material Group", k: "master", w: 2, o: "Data Migration Lead", act: "Load material groups; validate hierarchy" },
  { ws: "Supply Chain", n: "Plant", k: "master", w: 2, o: "Functional Lead", act: "Validate & load plant org data; confirm plant assignments" },
  { ws: "Supply Chain", n: "Storage Location", k: "master", w: 2, o: "Functional Lead", act: "Load storage locations; validate plant assignments" },
  { ws: "Supply Chain", n: "Unit of Measure", k: "master", w: 2, o: "Data Migration Lead", act: "Load units of measure & conversions" },
  { ws: "Supply Chain", n: "Batch Master", k: "master", w: 2, o: "Data Migration Lead", act: "Load batch master; validate batch determination" },
  { ws: "Sourcing and Procurement", n: "Purchasing Org", k: "master", w: 2, o: "Functional Lead", act: "Validate & load purchasing organization org data" },
  { ws: "Sourcing and Procurement", n: "Purchasing Group", k: "master", w: 2, o: "Functional Lead", act: "Load purchasing groups" },
  { ws: "Sourcing and Procurement", n: "Purchasing Info Record", k: "master", w: 2, o: "Functional Lead", act: "Create purchasing info records" },
  { ws: "Sourcing and Procurement", n: "Source List", k: "master", w: 2, o: "Functional Lead", act: "Create source lists & quota arrangements" },
  { ws: "Sourcing and Procurement", n: "Supplier / Business Partner", k: "master", w: 2, o: "Data Migration Lead", act: "Extract vendor master; convert to Business Partner (role Supplier); load; validate BP number ranges & account groups" },
  { ws: "Supply Chain", n: "Open Purchase Orders", k: "tx", w: 2, o: "Data Migration Lead", act: "Extract open POs (only open/partially delivered in scope); load via Migration Cockpit; reconcile PO count & value" },
  { ws: "Supply Chain", n: "Open Purchase Requisitions", k: "tx", w: 2, o: "Data Migration Lead", act: "Extract open purchase requisitions; load; reconcile count" },
  { ws: "Supply Chain", n: "Inventory Balances", k: "tx", w: 2, o: "Data Migration Lead", act: "Upload initial stock per plant/storage location/material; validate movement types; reconcile stock value vs legacy" },
  { ws: "Supply Chain", n: "Open Scheduling Agreements", k: "tx", w: 2, o: "Data Migration Lead", act: "Extract open scheduling agreements; load; reconcile" },
  // ── Wave 3 — Sales & Distribution (SD) ──
  { ws: "Sales", n: "Customer / Business Partner", k: "master", w: 3, o: "Data Migration Lead", act: "Extract customer master; convert to Business Partner (role Customer); load; validate credit control area assignments" },
  { ws: "Sales", n: "Pricing Condition Records", k: "master", w: 3, o: "Functional Lead", act: "Create pricing condition records; validate pricing procedures & tax configuration" },
  { ws: "Sales", n: "Pricing Procedure", k: "master", w: 3, o: "Functional Lead", act: "Validate & transport pricing procedures; confirm determination" },
  { ws: "Sales", n: "Open Sales Contracts", k: "tx", w: 3, o: "Data Migration Lead", act: "Extract open sales contracts; load; reconcile" },
  { ws: "Sales", n: "Open Sales Orders", k: "tx", w: 3, o: "Data Migration Lead", act: "Trigger conversion ≥1 week before go-live (complete within 8h); load; validate vs VBAK/VBAP/VBEP/VBKD & PRCD_ELEMENTS; reconcile net unit value at item level" },
  { ws: "Sales", n: "Open Deliveries", k: "tx", w: 3, o: "Data Migration Lead", act: "Extract open deliveries; load; reconcile" },
  { ws: "Sales", n: "Open Billing Documents", k: "tx", w: 3, o: "Data Migration Lead", act: "Extract open/pending billing; load; reconcile" },
  { ws: "Compliance", n: "Product Compliance (PSS)", k: "master", w: 3, o: "Functional Lead", act: "Load product compliance / safety data; validate" },
  { ws: "Compliance", n: "Consent Records", k: "tx", w: 3, o: "Functional Lead", act: "Load consent records; validate data protection settings" },
  // ── Wave 4 — Production & Maintenance (PP/PM/EAM) ──
  { ws: "Manufacturing", n: "Material BOM", k: "master", w: 4, o: "Data Migration Lead", act: "Extract BOMs; validate item consistency; load; verify" },
  { ws: "Manufacturing", n: "Work Center", k: "master", w: 4, o: "EAM/PP Lead", act: "Finalize Work Center definition; load; validate capacity assignments" },
  { ws: "Manufacturing", n: "Routing", k: "master", w: 4, o: "Data Migration Lead", act: "Load routings; validate operations & work center links" },
  { ws: "Manufacturing", n: "Production Version", k: "master", w: 4, o: "Data Migration Lead", act: "Extract production versions; validate BOM & routing assignments; load; verify" },
  { ws: "Manufacturing", n: "Open Production Orders", k: "tx", w: 4, o: "Data Migration Lead", act: "Extract open production orders (only released/partially confirmed in scope); load; reconcile order count" },
  { ws: "Asset Management", n: "Functional Location", k: "master", w: 4, o: "EAM Lead", act: "Load functional location hierarchy; validate structure" },
  { ws: "Asset Management", n: "Equipment", k: "master", w: 4, o: "EAM Lead", act: "Load equipment master; validate installation at functional locations" },
  { ws: "Asset Management", n: "Maintenance Task List", k: "master", w: 4, o: "EAM Lead", act: "Finalize & load maintenance task lists" },
  { ws: "Asset Management", n: "Maintenance BOM", k: "master", w: 4, o: "EAM Lead", act: "Load maintenance BOMs; validate" },
  { ws: "Asset Management", n: "Open Work Orders", k: "tx", w: 4, o: "EAM Lead", act: "Close all open work orders in legacy before cutover; re-create post-cutover work orders in S/4HANA" },
  // ── Wave 5 — Fixed Assets & Closing (AA) ──
  { ws: "Finance", n: "Fixed Asset Values", k: "tx", w: 5, o: "Finance Lead", act: "Extract asset master; map to S/4HANA asset classes; load; attention to Useful Life, Depreciation & accumulated depreciation; reconcile net book value" },
];
const FUNCTIONAL_WS = ["finance", "controlling", "sales", "supply chain", "sourcing and procurement", "procurement", "manufacturing", "production", "asset management", "compliance", "treasury"];

// ─── Standard Wave 0–5 model (editable default for wave mode) ─────────
const STANDARD_WAVES = [
  { n: 0, id: "W0", label: "Wave 0 — Pre-Cutover Preparation", scope: "Infrastructure readiness, transport imports, security roles, master-data cleansing, mock load #1", offsetWeeks: -8 },
  { n: 1, id: "W1", label: "Wave 1 — Core Finance & Controlling (FI/CO)", scope: "G/L, Cost/Profit Centers, Company Codes, CoA, Initial Balances, Exchange Rates, Open AP/AR", offsetWeeks: 0 },
  { n: 2, id: "W2", label: "Wave 2 — Procurement & Inventory (MM/WM)", scope: "Materials, Suppliers, House Banks, Open POs, Inventory, Movement Types", offsetWeeks: 4 },
  { n: 3, id: "W3", label: "Wave 3 — Sales & Distribution (SD)", scope: "Customers, Open Sales Orders, Condition Records, Pricing, Output", offsetWeeks: 8 },
  { n: 4, id: "W4", label: "Wave 4 — Production & Maintenance (PP/PM/EAM)", scope: "Production Versions, Work Centers, Open Production Orders, Open Work Orders", offsetWeeks: 12 },
  { n: 5, id: "W5", label: "Wave 5 — Fixed Assets & Closing (AA)", scope: "Fixed Assets, Useful Life, Depreciation, AA Balances, Final Legacy Freeze & Decommission", offsetWeeks: 16 },
];
// The agent authors cutover tasks; these are the SAP Cloud ALM Deploy-phase
// roadmap tasks / quality gates they would be loaded under (future sync seam).
const CLOUD_ALM_ANCHORS = {
  dataMigrationSetup: { id: "3-17410", title: "Setup Data Migration in the Production System" },
  cutoverExec: { id: "3-17411", title: "Execute Cutover Tasks per the Cutover Plan" },
  goLive: { id: "3-17412", title: "Set Production System to Live" },
  qualityGate: { id: "3-17419", title: "Deploy Quality Gate Checklist for SAP S/4HANA Cloud Public Edition" },
  signoff: { id: "3-17415", title: "Obtain Customer Sign-Off for Phase/Project Completion" },
};
// Which Cloud ALM anchor a generated cutover task maps to (for future load/sync).
function cloudAlmAnchorFor(task) {
  const k = task && task.kind || [];
  if (k.indexOf("goNoGo") !== -1 || k.indexOf("quality") !== -1) return CLOUD_ALM_ANCHORS.qualityGate.id;
  if (k.indexOf("ramp") !== -1 || k.indexOf("hypercare") !== -1) return CLOUD_ALM_ANCHORS.goLive.id;
  return CLOUD_ALM_ANCHORS.cutoverExec.id;
}

function buildDetailedCutover(project, l4Tasks) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const industry = project.industry || "";
  // Industry gate: universal (untagged) tasks always pass; industry-tagged tasks only when they match.
  // Dormant until OBJECT_TIMELINE / CUTOVER_DATA_OBJECTS entries carry an `ind:[...]` tag.
  const matchesIndustry = a => !a || !a.ind || a.ind.length === 0 || (industry && a.ind.includes(industry));
  const scope = deriveCutoverScopeFromL4(l4Tasks || []);
  const noL4 = scope.workstreams.length === 0;
  const readyOf = mod => matchWsReadiness(mod, scope.readinessByWs);
  const inScope = ws => noL4 || !!readyOf(ws);
  const own = ws => deriveOwnerFromWorkstream(ws);
  const tasks = [];
  const push = o => {
    const r = readyOf(o.module);
    const t = Object.assign({ status: "PENDING", phase: "CUT", durationH: 2, durationSource: "seed", kind: [], predecessors: [], blockerPreds: [], workstream: o.module, stream: "DM" }, o,
      { readinessPct: r ? r.pct : null, ready: r ? r.pct >= 100 : true, readinessWs: r ? r.name : null });
    t.cloudAlmAnchor = cloudAlmAnchorFor(t);
    tasks.push(t);
  };
  // 1) Backbone: technical / config / security / freeze / go-live / ramp (drop per-object + interface steps — we expand those).
  const backbone = objectTasksForSize(size).filter(a => !/^D2-/.test(a.id) && !/^D1-/.test(a.id) && matchesIndustry(a));
  // 2) Master data load window
  push({ id: "MS-MSTART", task: "Master data load — window start", module: "Data Migration", stream: "DM", owner: own("Data Migration"), durationH: 1, priority: "HIGH", kind: ["masterData"], predecessors: ["D3-05", "ST-INT-SHUTDOWN"] });
  const masterSignoffs = [], txSignoffs = [];
  // Per-entity (country / legal-entity) fan-out for transactional & balance objects.
  const fanAll = ((project.legalEntities && project.legalEntities.length) ? project.legalEntities : (project.countries || [])).map(x => String(x).trim()).filter(Boolean);
  const entities = fanAll.slice(0, 20);   // cap to keep the plan tractable
  const perEntity = entities.length > 0;
  let n = 0;
  CUTOVER_DATA_OBJECTS.forEach(obj => {
    if (obj.k !== "master" || !inScope(obj.ws) || !matchesIndustry(obj)) return;
    n++; const b = "OBJ-" + String(n).padStart(3, "0"); const o = obj.o || own(obj.ws); const wv = obj.w;
    push({ id: b + "-L", task: obj.act || ("Load " + obj.n), module: obj.ws, owner: o, wave: wv, durationH: 4, priority: "HIGH", kind: ["masterData", "dmLoad"], predecessors: ["MS-MSTART"] });
    push({ id: b + "-V", task: "Validate " + obj.n + " (count & key-field reconciliation)", module: obj.ws, owner: o, wave: wv, durationH: 2, kind: ["masterData"], predecessors: [b + "-L"] });
    push({ id: b + "-S", task: "Reconcile & sign-off " + obj.n, module: obj.ws, owner: o, wave: wv, durationH: 1, kind: ["masterData"], predecessors: [b + "-V"] });
    masterSignoffs.push(b + "-S");
  });
  push({ id: "MS-MDONE", task: "Master data — complete & signed off", module: "Data Migration", stream: "DM", owner: own("Data Migration"), durationH: 1, priority: "HIGH", kind: ["masterData"], predecessors: masterSignoffs.length ? masterSignoffs : ["MS-MSTART"] });
  // 3) Transactional / open-item / balance objects (gated on master complete)
  //    When countries / legal entities are provided, fan out per entity with the
  //    full data-migration chain (Extraction → Transformation → Pre-Load Validation
  //    → Load → Reconciliation Report & Email → Post-Load Validation).
  CUTOVER_DATA_OBJECTS.forEach(obj => {
    if (obj.k !== "tx" || !inScope(obj.ws) || !matchesIndustry(obj)) return;
    const o = obj.o || own(obj.ws); const wv = obj.w;
    if (perEntity) {
      entities.forEach(ent => {
        n++; const b = "OBJ-" + String(n).padStart(3, "0"); const nm = obj.n + " — " + ent;
        const ann = { module: obj.ws, owner: o, wave: wv, entity: ent };
        push(Object.assign({ id: b + "-EXT", task: "Extraction / Data Collection: " + nm, durationH: 2, kind: ["txData"], predecessors: ["MS-MDONE"] }, ann));
        push(Object.assign({ id: b + "-TRF", task: "Transformation: " + nm, durationH: 1, kind: ["txData"], predecessors: [b + "-EXT"] }, ann));
        push(Object.assign({ id: b + "-PRE", task: "Pre-Load Validation: " + nm, durationH: 1, kind: ["txData"], predecessors: [b + "-TRF"] }, ann));
        push(Object.assign({ id: b + "-LOAD", task: "Load: " + nm, durationH: 3, kind: ["txData", "dmLoad"], predecessors: [b + "-PRE"] }, ann));
        push(Object.assign({ id: b + "-REC", task: "Reconciliation Report & Email: " + nm, durationH: 1, kind: ["txData"], predecessors: [b + "-LOAD"] }, ann));
        push(Object.assign({ id: b + "-POST", task: "Post-Load Validation: " + nm, durationH: 1, kind: ["txData"], predecessors: [b + "-REC"] }, ann));
        txSignoffs.push(b + "-POST");
      });
    } else {
      n++; const b = "OBJ-" + String(n).padStart(3, "0");
      push({ id: b + "-E", task: "Extract / delta " + obj.n, module: obj.ws, owner: o, wave: wv, durationH: 2, kind: ["txData"], predecessors: ["MS-MDONE"] });
      push({ id: b + "-L", task: obj.act || ("Load " + obj.n), module: obj.ws, owner: o, wave: wv, durationH: 4, kind: ["txData", "dmLoad"], predecessors: [b + "-E"] });
      push({ id: b + "-S", task: "Validate & business sign-off " + obj.n, module: obj.ws, owner: o, wave: wv, durationH: 2, kind: ["txData"], predecessors: [b + "-L"] });
      txSignoffs.push(b + "-S");
    }
  });
  // 4) Interfaces — generated from the SAME register as the Integrations tab (ids align for coverage)
  const ifaceObjs = deriveInterfacesFromL4(l4Tasks);
  let m = 0;
  ifaceObjs.slice(0, 120).forEach(it => {
    m++; const b = "IF-" + String(m).padStart(3, "0"); const label = String(it.system).slice(0, 70);
    push({ id: b + "-A", task: label, module: "Integration", stream: "INT", owner: it.owner || own("Integration"), durationH: 2, predecessors: ["ST-INT-STARTUP"], scopeItem: it.scopeItem, ricefwId: it.id, wave: it.wave });
    push({ id: b + "-S", task: label + " — smoke test", module: "Integration", stream: "INT", owner: it.owner || own("Integration"), durationH: 1, predecessors: [b + "-A"], scopeItem: it.scopeItem, ricefwId: it.id, wave: it.wave });
  });

  // 4b) RICEFW objects (Reports/Forms/Enhancements/Conversions/Workflows) — one action each,
  //     tagged with the RICEFW id so every register entry is linked into the cutover.
  let rw = 0;
  deriveRicefwFromL4(l4Tasks).forEach(o => {
    if (o.type === "I") return;                         // interfaces handled above
    const txt = RW_TEXT[o.type]; if (!txt) return;
    if (rw >= 200) return;
    rw++; const b = "RW-" + String(rw).padStart(3, "0");
    const dep = o.type === "C" ? ["MS-MDONE"] : ["ST-TR-VERIFY"];
    push({ id: b, task: String(o.name).slice(0, 80), module: o.module || "RICEFW", stream: "RICEFW", owner: o.responsible || own(o.module), durationH: 1, predecessors: dep, scopeItem: o.scopeItem, ricefwId: o.id, wave: o.wave });
  });

  // 5) Per functional workstream: legacy freeze + post-go-live sign-off
  let w = 0;
  scope.workstreams.forEach(wsName => {
    if (!FUNCTIONAL_WS.some(f => String(wsName).toLowerCase().indexOf(f) !== -1)) return;
    w++; const b = "WS-" + String(w).padStart(2, "0"); const o = own(wsName);
    push({ id: b + "-F", task: "Freeze legacy — last " + wsName + " transactions", module: wsName, stream: "GONG", owner: o, durationH: 2, kind: [], predecessors: ["D3-03"] });
    push({ id: b + "-P", task: "Post-go-live validation & sign-off — " + wsName, module: wsName, stream: "GONG", owner: o, durationH: 2, phase: "HC", predecessors: ["D0-07"] });
  });
  // Backbone (with go/no-go re-pointed to our data milestones)
  backbone.forEach(a => {
    const mod = moduleForActivity(a.id, a.stream); const r = readyOf(mod);
    const preds = a.id === "D0-01" ? ["MS-MDONE", "MS-TXDONE"] : (a.predecessors || []);
    const t = Object.assign({}, a, { module: mod, wave: 0, predecessors: preds, readinessPct: r ? r.pct : null, ready: r ? r.pct >= 100 : true, readinessWs: r ? r.name : null });
    t.cloudAlmAnchor = cloudAlmAnchorFor(t);
    tasks.push(t);
  });
  push({ id: "MS-TXDONE", task: "Transactional data — complete & signed off", module: "Data Migration", stream: "DM", owner: own("Data Migration"), durationH: 1, priority: "HIGH", kind: ["txData"], predecessors: txSignoffs.length ? txSignoffs : ["MS-MDONE"] });
  // 6) Standard operational tasks (transport, config, security/users/access, comms, Fiori, freeze, shutdown/startup, manual, validation, go-live, hypercare)
  const lp = landscapeProfile(project.landscape);
  const is2SL = project.landscape === "2SL";
  CUTOVER_STANDARD_TASKS.forEach(st => {
    let task = st.task, notes;
    if (st.id === "ST-TR-APP") task = is2SL ? "Transport movement to production — application config (2SL: Quality → Production via Import Collection)" : "Transport movement to production — application configuration (3SL: Dev → Test → Production via Import Collection, excl. integrations)";
    if (st.id === "ST-TR-INT" && is2SL) task = "Transport movement to production — integrations (2SL: Quality → Production)";
    if (st.id === "ST-TR-VERIFY") notes = lp.transport;
    if (st.id === "ST-CFG-NR") notes = lp.config;
    push({ id: st.id, task, module: moduleForActivity(st.id, st.s), stream: st.s, owner: st.o, durationH: st.d, phase: st.ph, kind: st.k || [], predecessors: st.dep || [], priority: (st.k || []).indexOf("ramp") !== -1 ? "HIGH" : undefined, notes });
  });
  const stdCount = CUTOVER_STANDARD_TASKS.length;
  // Schedule (break any cycles), critical path, downtime
  const acyclic = breakCycles(tasks).tasks;
  const cutoverStartMs = msFromDateTime(project.cutoverStartDate, project.cutoverStartTime || "18:00");
  const windowH = Number(project.cutoverDurationH) > 0 ? Number(project.cutoverDurationH) : KB_SIZES[size].window_h;
  let scheduled;
  try { scheduled = scheduleActivities(acyclic, cutoverStartMs != null ? { windowStartMs: cutoverStartMs, size } : { size }); }
  catch (e) { scheduled = acyclic.map(t => Object.assign({}, t, { esH: 0, efH: t.durationH || 0 })); }
  const cp = criticalPath(scheduled);
  let dtStartH = null; const dtDur = Number(project.downtimeDurationH) > 0 ? Number(project.downtimeDurationH) : 0;
  if (cutoverStartMs != null) { const dtMs = msFromDateTime(project.downtimeStartDate, project.downtimeStartTime || "00:00"); if (dtMs != null) dtStartH = (dtMs - cutoverStartMs) / 3600000; }
  const flagged = flagDowntime(cp.tasks, dtStartH, dtDur);
  const waveModel = buildWaveModel(project, l4Tasks);
  return {
    tasks: flagged, scope, size, windowH, waveModel, validation: waveModel.validation,
    projectDurationH: cp.projectDurationH, fitsWindow: cp.projectDurationH <= windowH, overrunH: Math.round(Math.max(0, cp.projectDurationH - windowH) * 100) / 100,
    criticalIds: cp.criticalIds, criticalCount: cp.criticalIds.length, downtimeCount: flagged.filter(t => t.downtime).length, blockerCount: OBJECT_BLOCKERS.length,
    meta: { total: flagged.length, objectActions: flagged.filter(t => /^OBJ-/.test(t.id)).length, interfaceActions: m * 2, ricefwActions: rw, workstreamActions: w * 2, standardTasks: stdCount, backbone: backbone.length, landscape: project.landscape || "3SL", landscapeLabel: landscapeProfile(project.landscape).label, perEntity, entities: entities.length, entitiesTotal: fanAll.length },
  };
}
// Build the Wave 0–5 model (editable default) with T-minus dates + governance checks.
function addDaysISO(iso, days) { const s = parseISODate(iso); if (!s) return ""; const d = new Date(s + "T00:00:00Z"); if (isNaN(d.getTime())) return ""; d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function buildWaveModel(project, l4Tasks) {
  project = project || {};
  const scope = deriveCutoverScopeFromL4(l4Tasks || []);
  const inScopeWs = ws => scope.workstreams.length === 0 || !!matchWsReadiness(ws, scope.readinessByWs);
  const base = project.goLiveDate || project.cutoverStartDate || "";
  let waves;
  if (project.waves && project.waves.length) {
    waves = project.waves.map((w, i) => ({ n: i, id: w.id || ("W" + i), label: w.label || ("Wave " + i), scope: w.scope || "", cutoverStartDate: w.cutoverStartDate || "", goLiveDate: w.goLiveDate || "", standard: false, countries: w.countries || [], legalEntities: w.legalEntities || [], scopeItems: w.scopeItems || [], delta: w.delta || "" }));
  } else {
    waves = STANDARD_WAVES.map(w => ({ n: w.n, id: w.id, label: w.label, scope: w.scope, cutoverStartDate: base ? addDaysISO(base, w.offsetWeeks * 7 - 2) : "", goLiveDate: base ? addDaysISO(base, w.offsetWeeks * 7) : "", standard: true }));
  }
  waves.forEach(w => {
    w.objects = CUTOVER_DATA_OBJECTS.filter(o => o.w === w.n && inScopeWs(o.ws)).map(o => ({ name: o.n, ws: o.ws, kind: o.k, owner: o.o }));
    w.objectCount = w.objects.length;
    if (w.n === 0) w.prep = true;
    w.delta = w.delta || (w.n > (project.waves && project.waves.length ? 0 : 1) ? "delta" : ""); // waves after the first do delta
    w.entityCount = (w.legalEntities || []).length;
    w.countryCount = (w.countries || []).length;
  });
  const validation = [];
  const countries = (project.sizingSignals && project.sizingSignals.countries) || 0;
  if (countries > 5) validation.push({ level: "warn", rule: "≤5 countries", msg: countries + " countries/entities in scope — SAP allows at most 5 across main + parallel line before deployment; split across deployment rounds." });
  validation.push({ level: "info", rule: "main before parallel line", msg: "Deploy main-line countries before adding parallel-line scope; keep innovation (main line) separate from new-scope configuration (parallel line)." });
  validation.push({ level: "info", rule: "CBC workspace windows", msg: "Plan wave timelines around Central Business Configuration workspace availability (Branch / Rebase / Merge lifecycle windows)." });
  validation.push({ level: "info", rule: "master before transactional", msg: "Each wave loads & validates master data before transactional / open-item loads." });
  if (waves.length > 1) validation.push({ level: "info", rule: "delta between waves", msg: "Waves after the first use delta migration; legacy stays display-only until final-wave decommissioning." });
  return { waves, validation, base, mode: waves.length > 1 ? "waves" : "big_bang", standard: !(project.waves && project.waves.length) };
}
// ─── Standard operational cutover tasks (beyond data objects) ─────────
// Grounded in the reference cutover tasklist + Joule + SAP standard: transport,
// config/system-specific, security/users/access, communication arrangements,
// Fiori, freeze/last-transactions, bulk interface shutdown & controlled startup,
// manual in-flight docs, validation, go-live enablement, hypercare.
const CUTOVER_STANDARD_TASKS = [
  // Transport & technical readiness (PRE)
  { id: "ST-TR-APP", task: "Transport movement to production — application configuration (excl. integrations)", ph: "PRE", s: "TECH", o: "Basis / Deployment Lead", d: 6, k: [], dep: ["D5-01"] },
  { id: "ST-TR-INT", task: "Transport movement to production — integrations (CPI / TIBCO)", ph: "PRE", s: "INT", o: "Integration Lead", d: 4, k: [], dep: ["D5-01"] },
  { id: "ST-TR-VERIFY", task: "Verify transport requests & export/import collection; confirm completion", ph: "PRE", s: "TECH", o: "Basis / Deployment Lead", d: 2, k: [], dep: ["ST-TR-APP", "ST-TR-INT"] },
  { id: "ST-TECH-VALID", task: "Weekend deployment & technical validation (TMS, RFC, SSL/SSO)", ph: "PRE", s: "TECH", o: "Basis Lead", d: 3, k: [], dep: ["ST-TR-VERIFY"] },
  // Configuration & system-specific settings (PRE)
  { id: "ST-CFG-NR", task: "Create number ranges in production (BP, Customer, Vendor, Material, FI, CO, MM, SD) — system-specific, cannot be transported", ph: "PRE", s: "CONF", o: "Basis / Config Lead", d: 3, k: [], dep: ["ST-TR-VERIFY"] },
  { id: "ST-CFG-PP", task: "Open posting periods (GL, AA, CO, MM) for the go-live period", ph: "PRE", s: "CONF", o: "Functional Lead", d: 1, k: [], dep: ["ST-TR-VERIFY"] },
  { id: "ST-CFG-TAX", task: "Validate & activate tax codes; upload tax rates", ph: "PRE", s: "CONF", o: "Functional Lead", d: 2, k: [], dep: ["ST-TR-VERIFY"] },
  { id: "ST-CFG-CUSTOM", task: "Maintain custom tables (bank details per company code, form configuration)", ph: "PRE", s: "CONF", o: "Functional Lead", d: 2, k: [], dep: ["ST-TR-VERIFY"] },
  // Security, roles, users & access (PRE)
  { id: "ST-SEC-ROLES", task: "Build & unit-test business roles and business catalogs", ph: "PRE", s: "SEC", o: "Security Lead", d: 6, k: [], dep: ["D5-01"] },
  { id: "ST-SEC-IAS", task: "Establish BTP–IAS trust (production); create IAS/BTP groups & role collections; map to business roles", ph: "PRE", s: "SEC", o: "Security Lead", d: 4, k: [], dep: ["ST-SEC-ROLES"] },
  { id: "ST-SEC-USERS", task: "Create business users & assign business roles (IAS) — User Creation & R&R", ph: "PRE", s: "SEC", o: "Security Lead", d: 4, k: [], dep: ["ST-SEC-IAS"] },
  { id: "ST-SEC-CATALOG", task: "Check Fiori catalog & business catalog assignments per role", ph: "PRE", s: "SEC", o: "Security Lead", d: 2, k: [], dep: ["ST-SEC-USERS"] },
  { id: "ST-SEC-RESTRICT", task: "Configure data restrictions (application, company-code & org scope)", ph: "PRE", s: "SEC", o: "Security Lead", d: 2, k: [], dep: ["ST-SEC-USERS"] },
  { id: "ST-SEC-TRACE", task: "Validate authorization trace for key roles", ph: "PRE", s: "SEC", o: "Security Lead", d: 2, k: [], dep: ["ST-SEC-CATALOG"] },
  // Integration / communication setup (PRE)
  { id: "ST-INT-COMM", task: "Create communication scenarios, systems, users & arrangements (S/4HANA Public Cloud)", ph: "PRE", s: "INT", o: "Integration Lead", d: 4, k: [], dep: ["ST-TR-INT"] },
  { id: "ST-INT-CERT", task: "Exchange certificates / URLs / PGP credentials with interface partners", ph: "PRE", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["ST-INT-COMM"] },
  { id: "ST-INT-RFC", task: "RFC creation & CAB approval for production interfaces", ph: "PRE", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["ST-INT-COMM"] },
  { id: "ST-INT-SFTP", task: "Production SFTP connectivity test with partners", ph: "PRE", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["ST-INT-CERT"] },
  // Fiori & analytics (PRE)
  { id: "ST-FIORI-SYNC", task: "Fiori backend catalog sync (/UI2/GET_APP_DESCR_REMOTE_ALL), app index (/UI5/APP_INDEX_CALCULATE) & cache invalidation", ph: "PRE", s: "TECH", o: "Basis Lead", d: 2, k: [], dep: ["ST-TR-VERIFY"] },
  { id: "ST-FIORI-BW", task: "Activate BW info objects (SAP_BW_SETUP_INITIAL_S4HANA) & Enterprise Search setup", ph: "PRE", s: "TECH", o: "Basis Lead", d: 2, k: [], dep: ["ST-TR-VERIFY"] },
  // Freeze / last transactions (CUT)
  { id: "ST-COMM-BLACKOUT", task: "Communicate blackout / cutover start to business", ph: "CUT", s: "GONG", o: "OCM / PM", d: 1, k: [], dep: ["D3-02"] },
  { id: "ST-LAST-FI", task: "Last invoicing — Finance", ph: "CUT", s: "GONG", o: "Finance Lead", d: 2, k: [], dep: ["D3-02"] },
  { id: "ST-LAST-O2C", task: "Last invoicing — Order-to-Cash", ph: "CUT", s: "GONG", o: "Sales Lead", d: 2, k: [], dep: ["D3-02"] },
  { id: "ST-LAST-S2P", task: "Last invoicing — Source-to-Pay", ph: "CUT", s: "GONG", o: "Procurement Lead", d: 2, k: [], dep: ["D3-02"] },
  { id: "ST-LAST-INV", task: "Last inventory posting — Supply Chain", ph: "CUT", s: "GONG", o: "Supply Chain Lead", d: 2, k: [], dep: ["D3-02"] },
  { id: "ST-LAST-PAY", task: "Last payment run — Treasury", ph: "CUT", s: "GONG", o: "Finance Lead", d: 2, k: [], dep: ["D3-02"] },
  { id: "ST-SEC-LOCK", task: "Lock communication / VIP users at freeze point", ph: "CUT", s: "SEC", o: "Security Lead", d: 1, k: [], dep: ["D3-04"] },
  // Bulk interface shutdown (blanket) — before master load (Joule)
  { id: "ST-INT-SHUTDOWN", task: "Bulk interface shutdown — undeploy all in-scope iFlows (blanket) before migration", ph: "CUT", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["D3-04"] },
  // Controlled interface startup — after validation, gated by smoke tests (Joule)
  { id: "ST-INT-STARTUP", task: "Controlled interface startup — deploy iFlows in sequence (master flows first, then transactional), gated by smoke tests", ph: "CUT", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["D0-01"] },
  // Manual in-flight docs (CUT)
  { id: "ST-MANUAL-DOCS", task: "Manually re-create in-flight open sales orders / POs created during the cutover window", ph: "CUT", s: "GONG", o: "Functional Lead", d: 4, k: [], dep: ["MS-TXDONE"] },
  // Validation & sanity (CUT)
  { id: "ST-VAL-SANITY", task: "Business sanity testing on key transactions per workstream", ph: "CUT", s: "GONG", o: "Key Users / Business", d: 4, k: [], dep: ["D0-01"] },
  { id: "ST-VAL-SPOT", task: "Spot validation to adjacent / integrated systems", ph: "CUT", s: "INT", o: "Integration Lead", d: 2, k: [], dep: ["ST-INT-STARTUP"] },
  // Go-live enablement (CUT)
  { id: "ST-SEC-ACTIVATE", task: "Activate business users in production (release for transacting)", ph: "CUT", s: "SEC", o: "Security Lead", d: 2, k: [], dep: ["D0-03"] },
  { id: "ST-GOLIVE", task: "Set production system to live — Business Go-Live", ph: "CUT", s: "GONG", o: "PM / Steering Committee", d: 1, k: ["ramp"], dep: ["ST-SEC-ACTIVATE", "D0-05"] },
  // Post-go-live / hypercare (HC)
  { id: "ST-SEC-CONSULTANT", task: "Provision production access for functional consultants (hypercare validation & support)", ph: "HC", s: "SEC", o: "Security Lead", d: 2, k: [], dep: ["ST-GOLIVE"] },
  { id: "ST-HC-STATUS", task: "Publish cutover status report at each checkpoint", ph: "HC", s: "GONG", o: "PM", d: 1, k: [], dep: ["ST-GOLIVE"] },
  { id: "ST-LEGACY-ACCESS", task: "Confirm removal / modification of legacy ERP access", ph: "HC", s: "SEC", o: "Security Lead", d: 1, k: [], dep: ["ST-GOLIVE"] },
];

// Re-schedule an existing task list (after duration edits / rehearsal actuals).
function rescheduleTasks(tasks, project) {
  project = project || {};
  const size = KB_SIZES[project.size] ? project.size : "M";
  const cutoverStartMs = msFromDateTime(project.cutoverStartDate, project.cutoverStartTime || "18:00");
  const acyclic = breakCycles(tasks || []).tasks;
  let scheduled;
  try { scheduled = scheduleActivities(acyclic, cutoverStartMs != null ? { windowStartMs: cutoverStartMs, size } : { size }); }
  catch (e) { scheduled = acyclic.map(t => Object.assign({}, t, { esH: 0, efH: t.durationH || 0 })); }
  const cp = criticalPath(scheduled);
  let dtStartH = null; const dtDur = Number(project.downtimeDurationH) > 0 ? Number(project.downtimeDurationH) : 0;
  if (cutoverStartMs != null) { const dtMs = msFromDateTime(project.downtimeStartDate, project.downtimeStartTime || "00:00"); if (dtMs != null) dtStartH = (dtMs - cutoverStartMs) / 3600000; }
  const flagged = flagDowntime(cp.tasks, dtStartH, dtDur);
  return { tasks: flagged, projectDurationH: cp.projectDurationH, criticalCount: cp.criticalIds.length, downtimeCount: flagged.filter(t => t.downtime).length };
}
// Map raw workstream / module names to a process alias + functional/technical type.
const WORKSTREAM_TAXONOMY = [
  { match: ["finance", "fico", "fi/co", "fi-co", "r2r", "record to report", "accounting", "controlling", "co "], label: "Finance (FICO / R2R)", alias: "R2R", type: "functional" },
  { match: ["sourcing", "procurement", "purchas", "p2p", "procure to pay", "materials management", "mm "], label: "Procurement (MM / P2P)", alias: "P2P", type: "functional" },
  { match: ["sales", "o2c", "order to cash", "distribution", "sd "], label: "Sales (SD / O2C)", alias: "O2C", type: "functional" },
  { match: ["supply chain", "logistics", "inventory", "warehouse", "ewm", "wm "], label: "Supply Chain (WM)", alias: "SC", type: "functional" },
  { match: ["manufactur", "production", "plan to produce", "pp "], label: "Manufacturing (PP)", alias: "PP", type: "functional" },
  { match: ["asset management", "eam", "plant maintenance", "maintenance"], label: "Asset Mgmt (EAM/PM)", alias: "EAM", type: "functional" },
  { match: ["compliance", "pss", "product compliance"], label: "Compliance (GRC)", alias: "GRC", type: "functional" },
  { match: ["treasury", "trm"], label: "Treasury (TRM)", alias: "TRM", type: "functional" },
  { match: ["hcm", "human", "successfactors", "payroll", "hire to retire", "h2r"], label: "HR (HCM / H2R)", alias: "H2R", type: "functional" },
  { match: ["security", "iam", "ias", "authorization", "role", "sod"], label: "Security", alias: "SEC", type: "technical" },
  { match: ["btp", "business technology platform"], label: "BTP", alias: "BTP", type: "technical" },
  { match: ["abap", "ricefw", "wricef", "development", "extensibility", "enhancement", "cbo", "custom"], label: "ABAP / Dev (RICEFW)", alias: "ABAP", type: "technical" },
  { match: ["integration", "interface", "iflow", "cpi", "tibco", "middleware", "api"], label: "Integration", alias: "INT", type: "technical" },
  { match: ["basis", "infrastructure", "platform", "transport", "tms", "technical architecture"], label: "Basis / Technical", alias: "BASIS", type: "technical" },
  { match: ["data migration", "migration", "conversion", "dm "], label: "Data Migration", alias: "DM", type: "technical" },
  { match: ["analytics", "reporting", "bw", "fiori", "sac"], label: "Analytics / Fiori", alias: "BI", type: "technical" },
  { match: ["project", "pmo", "governance", "cutover", "test", "enablement", "ocm", "training"], label: "Project / PMO", alias: "PMO", type: "functional" },
];
function workstreamMeta(ws) {
  const s = " " + String(ws || "").toLowerCase() + " ";
  for (const e of WORKSTREAM_TAXONOMY) { if (e.match.some(m => s.indexOf(m) !== -1)) return { label: e.label, alias: e.alias, type: e.type }; }
  return { label: ws || "—", alias: "", type: "functional" };
}
// Map a workstream to its standard wave number (0-5) via the taxonomy alias.
function waveForWorkstream(ws) {
  const a = workstreamMeta(ws).alias;
  const m = { R2R: 1, TRM: 1, P2P: 2, SC: 2, O2C: 3, GRC: 3, H2R: 3, PP: 4, EAM: 4, AA: 5 };
  return m[a] != null ? m[a] : 0; // technical / cross-cutting → Wave 0 (prep)
}
// Extract a RICEFW / interface id embedded in task text (e.g. RICEFW_037, WRICEF-12).
function extractRicefwId(text) {
  const m = String(text || "").match(/\b(RICEFW[_-]?\d+|WRICEF[_-]?\d+|RF[_-]?\d+|INT[_-]?\d+)\b/i);
  return m ? m[1].toUpperCase().replace(/[_-]+/g, "-") : "";
}
const READINESS_FROM_STATUS = { COMPLETE: "PROD_READY", VERIFIED: "PROD_READY", IN_PROGRESS: "IN_DEVELOPMENT", PENDING: "NOT_STARTED", BLOCKED: "NOT_STARTED", SKIPPED: "NOT_STARTED" };

// RICEFW register from an L4 — Reports/Conversions/Enhancements/Forms/Workflows.
// Interfaces (type I) are excluded here; they live in the Integrations register.
function deriveRicefwFromL4(l4Tasks) {
  return (l4Tasks || []).filter(t => t.ricefwType && t.ricefwType !== "I").map((t, i) => ({
    id: extractRicefwId(t.task) || ("RF-" + (t.id || i)),
    type: t.ricefwType, name: String(t.task || "").slice(0, 100),
    module: t.workstream || t.stream || "", scopeItem: t.scopeItem || "",
    wave: waveForWorkstream(t.workstream || t.stream),
    readiness: READINESS_FROM_STATUS[t.status] || "NOT_STARTED", transport: "", responsible: t.owner || "",
  }));
}
// Interfaces from an L4 (integration-stream / RICEFW-I / interface-named tasks).
function deriveInterfacesFromL4(l4Tasks) {
  // Try to extract a "[System A] to [System B]" interface name from a task description.
  // Returns null if no recognisable system pair can be found — callers skip nulls
  // so we produce zero entries rather than garbage names.
  function parseIfName(txt, direction) {
    const clean = txt.replace(/\(SAP Build[^)]*\)/gi, "").trim();
    // Explicit "X to Y" in task text — reject if left side is an action verb (e.g. "Deploy iFlows to Production")
    const explicit = clean.match(/\b([\w][\w\s/&.]{1,25}?)\s+to\s+([\w][\w\s/&.]{1,25})\b/i);
    if (explicit && !/^\s*(?:deploy|move|migrate|transport|promote|activate|configure|setup|install|enable|disable|execute|perform|run|create|update|test|validate|publish|connect|integrate|send|push|load)\b/i.test(explicit[1])) {
      return `${explicit[1].trim()} to ${explicit[2].trim()}`.slice(0, 70);
    }
    // "inbound from X" → "X to S/4HANA"
    const inb = clean.match(/(?:inbound|receiv\w*)\s+from\s+([\w][\w\s/&.]{1,30})/i);
    if (inb) return `${inb[1].trim()} to S/4HANA`.slice(0, 70);
    // "outbound to X" → "S/4HANA to X"
    const outb = clean.match(/(?:outbound|send\w*)\s+to\s+([\w][\w\s/&.]{1,30})/i);
    if (outb) return `S/4HANA to ${outb[1].trim()}`.slice(0, 70);
    // System name in parentheses like "(BH3)", "(Salesforce)", "(SAP HCM)"
    const paren = clean.match(/\(([A-Z][A-Za-z0-9/\s-]{1,25})\)/);
    if (paren) {
      const sys = paren[1].trim();
      if (direction === "Inbound")  return `${sys} to S/4HANA`;
      if (direction === "Outbound") return `S/4HANA to ${sys}`;
      return `S/4HANA ↔ ${sys}`;
    }
    // Scope item that looks like an interface ID (e.g. "1IS", "INT-05")
    // — return null; let the scope item ID appear in the register but not the plan task
    return null;
  }

  const out = [], seen = new Set();
  (l4Tasks || []).forEach(t => {
    const txt = String(t.task || "");
    const isIf = t.ricefwType === "I" || t.stream === "INT" || /interface|iflow|i-flow|tibco|\bcpi\b|middleware|communication arrangement|odata|\brfc\b|\bapi\b|\bsftp\b/i.test(txt) || /integration/i.test(t.workstream || "");
    if (!isIf) return;
    const key = txt.toLowerCase().trim(); if (!key || seen.has(key)) return; seen.add(key);
    const type = /idoc/i.test(txt) ? "IDoc" : /odata|rest/i.test(txt) ? "REST" : /soap/i.test(txt) ? "SOAP" : /file|sftp/i.test(txt) ? "File" : "iFlow";
    const direction = /inbound|to s\/?4|to_s4/i.test(txt) ? "Inbound" : /outbound|from s\/?4|s4hana_to|s\/?4hana ?to/i.test(txt) ? "Outbound" : "—";
    const systemName = parseIfName(txt, direction)
      || (t.scopeItem ? `Interface ${t.scopeItem}` : null)
      || `Interface ${String(out.length + 1).padStart(2, "0")} — [Source System] to [Target System]`;
    out.push({
      id: extractRicefwId(txt) || ("IF-" + (t.id || out.length)), system: systemName, type, direction,
      switchTiming: "T0+4h", testStatus: "NOT_TESTED", switched: false,
      scopeItem: t.scopeItem || "", ricefwId: extractRicefwId(txt) || "", owner: t.owner || "",
      wave: waveForWorkstream(t.workstream || t.stream),
    });
  });
  return out;
}
// Scope & RICEFW coverage by wave — traceability that all scopes are accounted for.
function deriveScopeCoverage(l4Tasks) {
  const scope = {}, waveTasks = {}, waveRicefw = {};
  (l4Tasks || []).forEach(t => {
    const w = waveForWorkstream(t.workstream || t.stream);
    waveTasks[w] = (waveTasks[w] || 0) + 1;
    if (t.ricefwType) waveRicefw[w] = (waveRicefw[w] || 0) + 1;
    if (t.scopeItem) {
      const e = scope[t.scopeItem] = scope[t.scopeItem] || { id: t.scopeItem, wave: 0, module: t.workstream || t.stream, taskCount: 0, ricefw: 0 };
      e.taskCount++; if (t.ricefwType) e.ricefw++;
      if (w > 0 && (e.wave === 0 || w < e.wave)) { e.wave = w; e.module = t.workstream || t.stream; } // earliest functional wave
    }
  });
  const scopeItems = Object.keys(scope).map(k => scope[k]).sort((a, b) => a.wave - b.wave || String(a.id).localeCompare(String(b.id)));
  const scopeByWave = {}; scopeItems.forEach(s => { scopeByWave[s.wave] = (scopeByWave[s.wave] || 0) + 1; });
  const allWaves = Array.from(new Set(Object.keys(waveTasks).concat(Object.keys(scopeByWave)).map(Number))).sort((a, b) => a - b);
  const waves = allWaves.map(w => ({ wave: w, scopeItems: scopeByWave[w] || 0, ricefw: waveRicefw[w] || 0, tasks: waveTasks[w] || 0 }));
  return { scopeItems, waves, totalScopeItems: scopeItems.length, ricefwCount: (l4Tasks || []).filter(t => t.ricefwType).length };
}
// ─── Landscape (2SL vs 3SL) — drives config / transport model ─────────
const LANDSCAPE_PROFILES = {
  "3SL": { label: "3-System Landscape", tenants: 3, tenantList: "Customizing/Dev · Test/Quality · Production", transport: "Export Software/Customizing Collections released Dev → Test → Production via Import Collection; developer extensibility via ADT / gCTS.", config: "CBC + SSCUIs deployed by transport across all three tenants; system-specific settings (number ranges) set directly in Production." },
  "2SL": { label: "2-System Landscape", tenants: 2, tenantList: "Starter/Quality · Production", transport: "2-system transport Quality → Production via Import Collection; no separate development tenant (key-user extensibility only).", config: "CBC + SSCUIs promoted Quality → Production; system-specific settings set directly in Production." },
};
function landscapeProfile(landscape) { return LANDSCAPE_PROFILES[landscape] || LANDSCAPE_PROFILES["3SL"]; }

// ─── Wave / rollout plan parser (scope · legal entities · countries · timelines) ──
const WAVE_PLAN_ALIASES = {
  wave: ["wave #", "wave no", "wave number", "wave", "phase #", "phase"],
  label: ["wave name", "name", "description", "title"],
  countries: ["countries", "country", "country/region", "region", "market"],
  entities: ["legal entities", "legal entity", "company codes", "company code", "entities", "bukrs"],
  scopeItems: ["scope items", "scope item id", "scope item", "in scope", "scope"],
  cutoverStartDate: ["cutover start date", "cutover start", "cutover date", "cutover"],
  goLiveDate: ["go-live date", "go live date", "go-live", "go live", "golive"],
  delta: ["delta ricefw", "delta scope", "additional scope", "new scope", "changes", "delta"],
  notes: ["notes", "comments", "remarks"],
};
function matchWaveAlias(cell) {
  const s = String(cell == null ? "" : cell).toLowerCase().trim().replace(/\s+/g, " ");
  if (!s) return "";
  for (const k in WAVE_PLAN_ALIASES) { if (WAVE_PLAN_ALIASES[k].some(a => s === a || s.indexOf(a) !== -1)) return k; }
  return "";
}
function splitList(v) { return String(v == null ? "" : v).split(/[,;\/|\n]+/).map(x => x.trim()).filter(Boolean); }
function parseWaveRows(rows) {
  if (!rows || !rows.length) return { waves: [], modules: [], scopeItems: [] };
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const m = {}; let hits = 0;
    (rows[i] || []).forEach((c, idx) => { const key = matchWaveAlias(c); if (key && m[key] == null) { m[key] = idx; hits++; } });
    if ((m.wave != null && hits >= 2) || hits >= 3) { hi = i; map = m; break; }
  }
  if (hi < 0) return { waves: [], modules: [], scopeItems: [] };
  const waves = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] || []; const g = k => map[k] != null ? String(row[map[k]] == null ? "" : row[map[k]]).trim() : "";
    const waveNo = g("wave"), label = g("label"), countries = g("countries"), entities = g("entities"), scope = g("scopeItems");
    if (!waveNo && !label && !countries && !entities && !scope) continue;
    const cs = splitList(countries), le = splitList(entities), si = splitList(scope);
    waves.push({
      id: waveNo ? ("W" + String(waveNo).replace(/[^0-9]/g, "")) : ("W" + waves.length),
      label: label || (waveNo ? ("Wave " + waveNo) : ("Wave " + waves.length)),
      countries: cs, legalEntities: le, scopeItems: si,
      cutoverStartDate: parseISODate(g("cutoverStartDate")) || "", goLiveDate: parseISODate(g("goLiveDate")) || "",
      delta: g("delta"), notes: g("notes"),
      scope: [cs.join("/"), le.length ? le.length + " entities" : "", si.length ? si.length + " scope items" : ""].filter(Boolean).join(" · "),
    });
  }
  const scopeItems = Array.from(new Set(waves.reduce((a, w) => a.concat(w.scopeItems), [])));
  return { waves, modules: [], scopeItems };
}
function parseWavePlan(input) {
  let sheetsRows = [];
  if (input && input.sheets) { Object.keys(input.sheets).forEach(nm => sheetsRows.push(input.sheets[nm])); }
  else if (Array.isArray(input) && Array.isArray(input[0])) sheetsRows = [input];
  else sheetsRows = [parseTable(String(input || ""))];
  for (const rows of sheetsRows) { const res = parseWaveRows(rows); if (res.waves.length) return res; }
  return { waves: [], modules: [], scopeItems: [] };
}
// Parse a "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM" stamp → ms (naive, treated as UTC for stable deltas).
function parseStamp(s) {
  if (!s) return null;
  let str = String(s).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)) str += ":00";
  if (!/Z$/.test(str)) str += "Z";
  const ms = new Date(str).getTime();
  return isNaN(ms) ? null : ms;
}
// Planned vs actual deviation for a task.
function taskVariance(t) {
  const H = 3600000;
  const ss = parseStamp(t.scheduledStart), se = parseStamp(t.scheduledEnd), as = parseStamp(t.actualStart), ae = parseStamp(t.actualEnd);
  const r1 = x => Math.round(x * 10) / 10;
  const startDeltaH = (as != null && ss != null) ? r1((as - ss) / H) : null;
  const endDeltaH   = (ae != null && se != null) ? r1((ae - se) / H) : null;
  const actualDurationH = (as != null && ae != null) ? r1((ae - as) / H) : null;
  const delayH = endDeltaH != null ? endDeltaH : startDeltaH;
  let status = "planned";
  if (ae != null) status = endDeltaH > 0.05 ? "late" : (endDeltaH < -0.05 ? "early" : "on_time");
  else if (as != null) status = startDeltaH > 0.05 ? "late_start" : "in_progress";
  return { startDeltaH, endDeltaH, actualDurationH, delayH, status };
}
// Count cutover tasks linked to each RICEFW / interface id (for coverage + gap warnings).
function coverageByRicefwId(tasks) {
  const m = {};
  (tasks || []).forEach(t => {
    if (!t.ricefwId) return;
    const e = m[t.ricefwId] = m[t.ricefwId] || { count: 0, done: 0 };
    e.count++;
    if (t.status === "COMPLETE" || t.status === "VERIFIED") e.done++;
  });
  return m;
}
// ─── Agent-to-agent orchestration (a handoff view over the deterministic plan) ──
// Agents are specialized ROLES over the plan — not autonomous bots. Handoffs are
// derived from the dependency graph: a cross-agent edge is a baton pass.
const ORCH_AGENTS = [
  { key: "orchestrator", label: "Orchestrator",        icon: "🎛", desc: "Sequences the run & enforces go/no-go and ramp gates" },
  { key: "config",       label: "Config / Transport",  icon: "🔧", desc: "Transports & configuration into production" },
  { key: "data",         label: "Data Migration",      icon: "🗄", desc: "Extract → transform → load → reconcile per object/entity" },
  { key: "integration",  label: "Integration",         icon: "🔗", desc: "Repoint, activate & smoke-test interfaces" },
  { key: "security",     label: "Security",            icon: "🔐", desc: "Business users, roles & access provisioning" },
  { key: "validation",   label: "Validation / Quality",icon: "🔎", desc: "Validation checks feeding go/no-go" },
  { key: "comms",        label: "Comms",               icon: "📣", desc: "Blackout comms, reconciliation emails, status" },
  { key: "functional",   label: "Functional",          icon: "🧩", desc: "Workstream freeze & post-go-live sign-off" },
];
function agentForTask(t) {
  const id = String((t && t.id) || ""); const s = (t && t.stream) || ""; const k = (t && t.kind) || []; const txt = (t && t.task) || "";
  const has = x => k.indexOf(x) !== -1;
  if (/Reconciliation Report (&|and) Email/i.test(txt) || /^ST-COMM|^ST-LAST/.test(id)) return "comms";
  if (has("goNoGo") || has("ramp") || /^D0-0[34567]/.test(id) || /^MS-/.test(id)) return "orchestrator";
  if (s === "INT" || /^IF-/.test(id)) return "integration";
  if (s === "SEC" || /^ST-SEC/.test(id)) return "security";
  if (/^OBJ-/.test(id) || has("dmLoad") || has("txData") || has("masterData")) return "data";
  if (has("validation")) return "validation";
  if (/^ST-TR|^ST-CFG|^ST-FIORI|^RW-/.test(id) || has("configActivation")) return "config";
  if (/freeze|post-go-live|sign-off/i.test(txt)) return "functional";
  return workstreamMeta(t && t.workstream).type === "technical" ? "config" : "functional";
}
function buildOrchestration(tasks) {
  tasks = tasks || [];
  const map = {}; tasks.forEach(t => { map[t.id] = t; });
  const done = t => !!t && (t.status === "COMPLETE" || t.status === "VERIFIED");
  const stat = {}; ORCH_AGENTS.forEach(a => { stat[a.key] = { key: a.key, label: a.label, icon: a.icon, desc: a.desc, total: 0, done: 0, inProgress: 0, blocked: 0 }; });
  tasks.forEach(t => { const st = stat[agentForTask(t)] || stat.functional; st.total++; if (done(t)) st.done++; else if (t.status === "IN_PROGRESS") st.inProgress++; else if (t.status === "BLOCKED") st.blocked++; });
  const pair = {}, frontier = [];
  tasks.forEach(t => {
    const to = agentForTask(t);
    (t.predecessors || []).forEach(pid => {
      const p = map[pid]; if (!p) return;
      const from = agentForTask(p); if (from === to) return;
      const key = from + ">" + to; const e = pair[key] = pair[key] || { from, to, count: 0, ready: 0 };
      e.count++; if (done(p)) e.ready++;
      if (done(p) && !done(t)) frontier.push({ from, to, id: t.id, task: t.task, at: p.actualEnd || p.scheduledEnd || t.scheduledStart || "", pred: p.id, status: t.status === "BLOCKED" ? "blocked" : t.status === "IN_PROGRESS" ? "in_progress" : "ready" });
    });
  });
  const handoffs = Object.keys(pair).map(k => pair[k]).sort((a, b) => b.count - a.count);
  frontier.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const incomplete = tasks.filter(t => !done(t) && t.scheduledStart).sort((a, b) => a.scheduledStart < b.scheduledStart ? -1 : 1);
  const activeOwner = incomplete.length ? agentForTask(incomplete[0]) : null;
  return { agents: ORCH_AGENTS.map(a => stat[a.key]), handoffs, frontier: frontier.slice(0, 40), activeOwner, agentMeta: ORCH_AGENTS };
}
// RICEFW type → cutover action text (shared by generator + gap-fill).
const RW_TEXT = { R: "Verify report in production", F: "Verify form output in production", E: "Verify enhancement active in production", C: "Verify data conversion in production", W: "Verify workflow active in production" };

// Deterministic gap-fill: build the cutover task(s) for a single register entry (human edits/removes after).
function suggestTaskForRicefw(obj, suffix) {
  if (!obj || obj.type === "I") return null;
  const txt = RW_TEXT[obj.type]; if (!txt) return null;
  const dep = obj.type === "C" ? ["MS-MDONE"] : ["ST-TR-VERIFY"];
  return { id: "RW-SUG-" + (suffix || Date.now()), task: String(obj.name || "").slice(0, 80), module: obj.module || "RICEFW", workstream: obj.module || "RICEFW", stream: "RICEFW", owner: obj.responsible || "", durationH: 1, predecessors: dep, scopeItem: obj.scopeItem || "", ricefwId: obj.id, wave: obj.wave, status: "PENDING", origin: "suggested", kind: [] };
}
function suggestTasksForInterface(obj, suffix) {
  if (!obj) return [];
  const b = "IF-SUG-" + (suffix || Date.now());
  const label = String(obj.system || obj.name || "").slice(0, 60);
  return [
    { id: b + "-A", task: label, module: "Integration", workstream: "Integration", stream: "INT", owner: obj.owner || "", durationH: 2, predecessors: ["ST-INT-STARTUP"], scopeItem: obj.scopeItem || "", ricefwId: obj.id, wave: obj.wave, status: "PENDING", origin: "suggested", kind: [] },
    { id: b + "-S", task: label + " — smoke test", module: "Integration", workstream: "Integration", stream: "INT", owner: obj.owner || "", durationH: 1, predecessors: [b + "-A"], scopeItem: obj.scopeItem || "", ricefwId: obj.id, wave: obj.wave, status: "PENDING", origin: "suggested", kind: [] },
  ];
}
// Tasks that need an external approval that isn't granted yet (feeds go/no-go warning).
function tasksNeedingApproval(tasks) {
  return (tasks || []).filter(t => t.externalRef && t.externalRef.approvalRequired && t.externalRef.approvalStatus !== "APPROVED");
}
// ─── Owner email import (paste / CSV / XLSX) — no typing ─────────────
const _EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
function _ownerEmailsFromRows(rows) {
  const out = [], seen = new Set();
  const push = (owner, email) => {
    email = String(email || "").trim().toLowerCase(); owner = String(owner || "").trim();
    if (!_EMAIL_RE.test(email)) return; const m = email.match(_EMAIL_RE); email = m[0];
    const key = owner.toLowerCase() + "|" + email; if (seen.has(key)) return; seen.add(key);
    out.push({ owner, email });
  };
  if (!rows || !rows.length) return out;
  let emailCol = -1, ownerCol = -1, headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    (rows[i] || []).forEach((c, idx) => {
      const s = String(c == null ? "" : c).toLowerCase();
      if (emailCol < 0 && /e-?mail/.test(s)) emailCol = idx;
      if (ownerCol < 0 && /(owner|role|name|responsible|resource|assignee|lead)/.test(s)) ownerCol = idx;
    });
    if (emailCol >= 0) { headerRow = i; break; }
  }
  if (emailCol >= 0) {
    for (let r = headerRow + 1; r < rows.length; r++) { const row = rows[r] || []; push(ownerCol >= 0 ? row[ownerCol] : "", row[emailCol]); }
  } else {
    // No header — pair the email in each row with the nearest non-email cell.
    rows.forEach(row => { if (!row) return; let email = "", owner = ""; row.forEach(c => { const s = String(c == null ? "" : c); if (_EMAIL_RE.test(s)) email = s; else if (s.trim() && !owner) owner = s.trim(); }); if (email) push(owner, email); });
  }
  return out;
}
function parseOwnerEmails(input) {
  if (input && input.sheets) { let best = []; Object.keys(input.sheets).forEach(nm => { const r = _ownerEmailsFromRows(input.sheets[nm] || []); if (r.length > best.length) best = r; }); return best; }
  if (Array.isArray(input) && Array.isArray(input[0])) return _ownerEmailsFromRows(input);
  const out = [], seen = new Set();
  String(input || "").split(/\r?\n/).forEach(line => {
    const m = line.match(_EMAIL_RE); if (!m) return; const email = m[0].toLowerCase();
    const owner = line.replace(m[0], "").replace(/[<>,;:\t|"]+/g, " ").replace(/\s+/g, " ").trim();
    const key = owner.toLowerCase() + "|" + email; if (seen.has(key)) return; seen.add(key);
    out.push({ owner, email });
  });
  return out;
}
// Match parsed {owner,email} to the plan's owners (case-insensitive exact).
function matchOwnerEmails(parsed, owners) {
  const lower = {}; (owners || []).forEach(o => { lower[String(o).toLowerCase()] = o; });
  const map = {}, matched = [], unmatched = [];
  (parsed || []).forEach(p => {
    const hit = p.owner && lower[p.owner.toLowerCase()];
    if (hit) { map[hit] = p.email; matched.push({ owner: hit, email: p.email }); }
    else unmatched.push(p);
  });
  const missing = (owners || []).filter(o => !map[o]);
  return { map, matched, unmatched, missing };
}
// ═══════════════════════════════════════════════════════════════════

// ─── Post-core utilities ─────────────────────────────────────────

// ensureState: return a NEW object (never mutate state during render).
function ensureState(s) {
  const src = s || {};
  const state = src.state || {};
  return {
    ...src,
    state: {
      ...state,
      plan:       state.plan || { tasks: [] },
      ricefw:     state.ricefw || [],
      interfaces: state.interfaces || [],
      gates:      state.gates || [],
    },
  };
}

// ─── RICEFW smoke test derivation + cutover post-processor ───────────────
// (Extracted from the component scope; all dependencies are self-contained)

const _DEV_WS_RE     = /\b(?:development|ricefw|custom[\s-]?dev(?:elopment)?)\b/i;
// Exclude pure planning phases — Explore/Discover/Prepare have no deliverables to smoke-test
const _EXCL_PHASE_RE = /\b(?:explore|discover|prepare)\b/i;
// Action-verb prefixes that identify build activities rather than item names
const _VERB_PREFIX_RE = /^\s*(?:develop(?:ing|ment)?|build(?:ing)?|creat(?:e|ing)|implement(?:ing)?|configur(?:e|ing)|design(?:ing)?|defin(?:e|ing)|plan(?:ning)?|prepar(?:e|ing)|assign(?:ing)?|finaliz(?:e|ing)|finalise|organis(?:e|ing)|organiz(?:e|ing)|schedul(?:e|ing)|document(?:ing)?|communicat(?:e|ing)|identif(?:y|ying)|assess(?:ing)?|set[\s-]?up|draft(?:ing)?|writ(?:e|ing)|updat(?:e|ing)|revise?|modif(?:y|ying)|test(?:ing)?|validat(?:e|ing)|verif(?:y|ying)|conduct(?:ing)?|execut(?:e|ing)|perform(?:ing)?|deliver(?:ing)?|facilitat(?:e|ing)|coordinat(?:e|ing)|manag(?:e|ing)|migrat(?:e|ing)|upload(?:ing)?|deploy(?:ing)?|transport(?:ing)?|publish(?:ing)?|present(?:ing)?|lead(?:ing)?|support(?:ing)?|track(?:ing)?|monitor(?:ing)?|report(?:ing)?|approv(?:e|ing)|complet(?:e|ing)|clos(?:e|ing)|archiv(?:e|ing)|sprint[\s/\-]|stand[\s-]up|daily[\s-]|kick[\s-]?off|lessons\s+learned|retrospective)\b/i;
// Within-text patterns that identify build activities (applied after verb-prefix check)
const _BUILD_SKIP_RE = /\b(?:tsd\s*(?:creation|update|review|template|doc)|workshop|fts|fit[\s-]to[\s-]standard|unit[\s-]?test|defect|bug[\s-]?fix|test[\s-]?case|test[\s-]?script|specification|peer\s*review|code\s*review|training|daily\s*stand[\s-]up|meeting|status\s*report|report\s*out|sprint\s*review|sprint\s*demo|sprint\s*planning|standup)\b/i;
const _BUILD_SUFFIX  = /\s*[-–]\s*(?:build|final\s*version|final|development|dev|sprint\s*\d+|phase\s*\d+|v\d+(?:\.\d+)?)\s*$/i;
// Prefix patterns that wrap an item name — extract the item, don't skip the row
const _TSD_PREFIX_RE = /^\s*(?:tsd\s*(?:creation|update)\s*[-–:]\s*|create\s+tsd\s*[-–:]\s*)/i;
const _MISSED_BUILD  = /\s*(?:missed\s*to\s*(?:build|include)|missed\s*build)\s*$/i;

function deriveSmokeTestTasks(allL4Tasks, existingNames) {
  const existingSet = new Set((existingNames || []).map(n => n.toLowerCase().slice(0, 55)));
  const seenItems = new Set();
  const out = [];
  let idx = 0;

  function addItem(itemName, scopeItem) {
    const name = itemName.replace(/\s+/g, " ").trim();
    if (!name || name.length < 4) return;
    const key = name.toLowerCase().slice(0, 70);
    if (seenItems.has(key)) return;
    seenItems.add(key);
    const taskName = "Smoke test — " + name.slice(0, 65) + " in Production";
    if (existingSet.has(taskName.toLowerCase().slice(0, 55))) return;
    idx++;
    out.push({
      id: "RW-" + String(idx).padStart(3, "0"),
      task: taskName,
      phase: "CUT", workstream: "Development", stream: "RICEFW",
      owner: "Technical Team / Client BPO",
      durationH: 1, status: "PENDING", priority: "HIGH",
      wave: 1, predecessors: ["ST-TR-VERIFY"], kind: [], scopeItem: scopeItem || "",
    });
  }

  (allL4Tasks || []).forEach(t => {
    // Must be Development or RICEFW workstream
    if (!_DEV_WS_RE.test(t.workstream || "")) return;
    // Exclude Explore/Prepare phases — nothing deployable there
    if (_EXCL_PHASE_RE.test(t.phase || "")) return;
    const raw = String(t.task || "").trim();
    if (!raw) return;

    // Pass 1: TSD rows → extract item name from prefix, skip the shell row itself
    if (_TSD_PREFIX_RE.test(raw)) {
      const itemName = raw.replace(_TSD_PREFIX_RE, "").replace(_BUILD_SUFFIX, "").replace(_MISSED_BUILD, "").trim();
      addItem(itemName, t.scopeItem);
      return;
    }
    // Pass 2: skip build-activity rows
    if (_VERB_PREFIX_RE.test(raw)) return;
    if (_BUILD_SKIP_RE.test(raw)) return;
    // Pass 3: named-item row — use as-is after stripping build suffixes
    const itemName = raw.replace(_BUILD_SUFFIX, "").replace(_MISSED_BUILD, "").trim();
    addItem(itemName, t.scopeItem);
  });
  return out;
}

// ── Cutover plan post-processor ──────────────────────────────────────────────
// Applies standing structural rules to every generated task list before storage.
// Rules are enforced here in code (not in a Claude prompt) because buildDetailedCutover
// is pure JS — prompt-based feedback gets lost; these rules are permanent constraints.

// Rule 4: canonical workstream display names (maps abbreviations → full names)
const _WS_NORM = {
  conf:"Configuration", config:"Configuration",
  dm:"Data Migration", datamigration:"Data Migration",
  sec:"Security",
  tech:"Technical",
  gong:"Go-Live Gate",
  int:"Integration",
  ricefw:"RICEFW",
  ocm:"OCM",
  hc:"Hypercare",
  sitm:"SIT Mgmt", sitmgmt:"SIT Mgmt",
  // Technical Architecture variants (with or without "& Infrastructure")
  technicalarchitecture:"Technical Architecture & Infrastructure",
  technicalarchitectureinfrastructure:"Technical Architecture & Infrastructure",
  "technicalarchitecture&infrastructure":"Technical Architecture & Infrastructure",
  technicalinfrastructure:"Technical Architecture & Infrastructure",
  techinfrastructure:"Technical Architecture & Infrastructure",
  infrastructure:"Technical Architecture & Infrastructure",
  // Data Migration variants
  datamig:"Data Migration", datamigration:"Data Migration",
  datamigfinalload:"Data Migration", datamigload:"Data Migration",
};
function normWs(ws) {
  const k = String(ws || "").toLowerCase().replace(/[\s\-_.]/g, "");
  return _WS_NORM[k] || ws;
}

// Rule 1: workstreams that must never appear as plan tasks — replace with one gate row each
const _EXCL_WS_RE = /\b(?:eut|kut|uat[\s_-]?(?:mgmt|sign[\s-]?off|management|complete)?|project[\s-]?management)\b/i;

// Rule 2: task-name patterns that always require HIGH priority
const _HIGH_PRI_RE = /\b(?:go[\s/-]?no[\s/-]?go|go[\s-]?live\s*(?:gate|decision|milestone|approv)|production\s*cutover|execute\s*cutover|cutover\s*execution|user[\s-]?(?:unlock|creation|provisioning)|system[\s-]?(?:freeze|shutdown)|legacy[\s-]?lock|data[\s-]?migration[\s-]?sign[\s-]?off|post[\s-]?conversion[\s-]?validation|hypercare[\s-]?go[\s-]?live|close\s+open\s+(?:transactional|item|object)|close\s+(?:legacy|open)\s+(?:period|book|ledger)|transport\s+to\s+prod|production\s+ramp|ramp.?up\s+(?:go.?live|monitor|support)|data\s+cutover\s+execution|cutover\s+go.?live)\b/i;

// Rule 3: CUT-phase tasks that are clearly preparation/planning → W0; everything else → W1
// "prepare" excluded when followed by hypercare/support-struct/cutover-exec/production (those are execution-day tasks)
const _CUT_PREP_RE = /\b(?:prepare(?!\s+(?:hypercare|support\b|cutover\s*exec|prod|go.?live))|plan\b|review\b|assess|brief\b|align\b|organiz|coordinat|confirm\s*readiness|schedule\b)\b/i;
// Task-name patterns that signal HC (post go-live) regardless of phase label
// NOTE: "hypercare" alone is NOT enough — "Prepare hypercare support structure" is a CUT/W1 task.
// Require an explicit post-go-live verb (monitor, stabilize) or "post go-live/cutover" qualifier.
const _HC_TASK_RE  = /\b(?:monitor\b|post[\s-]?go[\s-]?live|post[\s-]?cutover|stabiliz|go[\s-]?live\s+adoption\s*support)\b/i;

function postProcessCutoverTasks(tasks) {
  const gateNeeded = new Set();
  const kept = [];

  tasks.forEach(t => {
    const ws = String(t.workstream || "");

    // Rule 1: remove EUT/KUT/UAT/PM workstream tasks; record what gates to add
    if (_EXCL_WS_RE.test(ws)) {
      const wl = ws.toLowerCase();
      if (/eut/.test(wl))                                   gateNeeded.add("eut");
      else if (/kut/.test(wl))                              gateNeeded.add("kut");
      else if (/uat/.test(wl))                              gateNeeded.add("uat");
      // Project Management: remove with no replacement
      return;
    }

    // Rule 4: normalize workstream display name
    t.workstream = normWs(ws);

    // Rule 2: priority — force uppercase first, then apply HIGH override
    if (t.priority) t.priority = String(t.priority).toUpperCase();
    if (_HIGH_PRI_RE.test(t.task || "")) {
      t.priority = "HIGH";
    } else if (!t.priority || t.priority === "LOW") {
      t.priority = "MEDIUM";
    }

    // Rule 3: normalise raw L4 phase names → canonical PRE / CUT / HC, then assign wave
    const rawPh = String(t.phase || "").trim();
    const _EXEC_VERB_RE = /\b(close|execute|migrate|freeze|lock|activate|ramp[\s-]?up|data\s+cutover|cutover\s+execution|transport\s+to\s+prod)\b/i;
    let ph;
    if (/\b(hc|hypercare|run|post.?go.?live)\b/i.test(rawPh))    ph = "HC";
    else if (/deploy|\bcutover\b|\bcut\b/i.test(rawPh))           ph = "CUT";
    else if (!rawPh && _EXEC_VERB_RE.test(t.task || ""))          ph = "CUT"; // empty phase + execution verb → infer CUT
    else                                                           ph = "PRE";
    t.phase = ph;

    // HC by task name overrides phase label (monitoring/support tasks labelled CUT in some L4s)
    if (ph === "HC" || /hypercare/i.test(t.workstream || "") || _HC_TASK_RE.test(t.task || "")) {
      t.phase = "HC"; t.wave = 2;
    } else if (ph === "CUT") {
      // CUT phase: always recompute wave from task name — source files use 0-indexed waves
      // that collide with PRE-wave numbering, so the source value cannot be trusted here.
      t.wave = _CUT_PREP_RE.test(t.task || "") ? 0 : 1;
    } else {
      // PRE or anything else → W0
      t.wave = t.wave != null ? t.wave : 0;
    }

    // RW tasks = production smoke tests — always CUT/W1/HIGH regardless of how they were generated
    if ((t.id || "").startsWith("RW-")) {
      t.phase = "CUT"; t.wave = 1; t.priority = "HIGH";
    }

    kept.push(t);
  });

  // Add gate rows for detected excluded workstreams (CUT phase so AI doesn't flag as pre-deploy)
  const gateRows = {
    eut: { task: "EUT completion confirmed — go-live readiness gate",  phase: "CUT" },
    kut: { task: "KUT completion confirmed — go-live readiness gate",  phase: "CUT" },
    uat: { task: "UAT sign-off confirmed — gate to Deploy",            phase: "CUT" },
  };
  let gIdx = 0;
  gateNeeded.forEach(k => {
    gIdx++;
    const g = gateRows[k];
    if (g) kept.push({ ...g, id: "GATE-" + String(gIdx).padStart(2, "0"),
      workstream: "Go-Live Gate", stream: "GONG", owner: "Project Manager",
      priority: "HIGH", wave: 0, durationH: 1, status: "PENDING",
      predecessors: [], kind: ["goNoGo"], scopeItem: "" });
  });

  // Rule 5 (RW dedup): remove RW tasks whose name duplicates a DEP task
  // Normalize special chars (em dash, commas, etc.) before comparing so truncation differences don't mask matches
  const normTaskKey = t => t.task.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const depNames = new Set(kept.filter(t => (t.id || "").startsWith("DEP-")).map(normTaskKey));
  return kept.filter(t => {
    if ((t.id || "").startsWith("RW-") && depNames.has(normTaskKey(t))) return false;
    return true;
  });
}
