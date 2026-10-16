"""
SAP Local Brain — FastAPI Server
Port: 7878

Endpoints:
  GET  /api/status          -> { chunks, sources, db_path }
  POST /api/search          body: { q, limit } -> FTS5 keyword search
  POST /api/ask             body: { q, limit } -> RAG: FTS5 search + Claude answer
  GET  /api/sources         -> list of indexed source files

Run: uvicorn server:app --host 0.0.0.0 --port 7878 --reload
Env: BRAIN_DB
"""

import base64
import json as _json
import logging
import os
import re as _re
import sqlite3
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Structured JSON logger ─────────────────────────────────────────────────────
class _JsonFormatter(logging.Formatter):
    def format(self, record):
        d = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if hasattr(record, "ctx"):
            d.update(record.ctx)
        return _json.dumps(d)

_log_handler = logging.StreamHandler()
_log_handler.setFormatter(_JsonFormatter())
_log = logging.getLogger("brain")
_log.setLevel(logging.INFO)
_log.addHandler(_log_handler)
_log.propagate = False

def _L(msg: str, **ctx):
    """Convenience: log INFO with optional structured context fields."""
    r = logging.LogRecord("brain", logging.INFO, "", 0, msg, (), None)
    r.ctx = ctx
    _log.handle(r)

def _LE(msg: str, **ctx):
    """Convenience: log ERROR with optional structured context fields."""
    r = logging.LogRecord("brain", logging.ERROR, "", 0, msg, (), None)
    r.ctx = ctx
    _log.handle(r)

# ── Query helpers ─────────────────────────────────────────────────────────────

_STOP = {
    "what","are","the","key","how","when","where","why","which","who","is","was",
    "a","an","for","of","in","to","and","or","with","can","do","i","me","my","we",
    "our","give","list","tell","explain","describe","show","please","some","any",
    "all","should","would","could","need","want","steps","step","process","approach",
    "about","during","before","after","this","that","these","those","will","be",
    "has","have","had","does","did","not","also","main","important","key",
}

def _to_fts_query(q: str) -> str:
    """Strip question words, return FTS5 OR query from meaningful terms.
    Tokens are quoted so Python 3.14's SQLite FTS5 handles them correctly."""
    words = _re.findall(r'\b[a-zA-Z]\w*\b', q.lower())
    keywords = [w for w in words if w not in _STOP and len(w) > 2]
    if not keywords:
        words_all = _re.findall(r'\b\w{4,}\b', q)
        keywords = words_all[:5]
    return " OR ".join(f'"{w}"' for w in keywords) if keywords else q


# ── Claude CLI helper ─────────────────────────────────────────────────────────

_HAIKU_MODEL = "claude-haiku-4-5-20251001"
_CLAUDE_EXE_CACHE = None

def _find_claude():
    """Locate the Claude CLI on any machine (PATH first, then common install locations).
    Cached after first lookup. Env var CLAUDE_CLI overrides everything."""
    global _CLAUDE_EXE_CACHE
    if _CLAUDE_EXE_CACHE:
        return _CLAUDE_EXE_CACHE
    import shutil
    env = os.environ.get("CLAUDE_CLI")
    if env and Path(env).exists():
        _CLAUDE_EXE_CACHE = env; return env
    for name in ("claude", "claude.cmd", "claude.exe"):
        found = shutil.which(name)
        if found:
            _CLAUDE_EXE_CACHE = found; return found
    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "claude.exe",
        home / ".local" / "bin" / "claude",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
        Path(os.environ.get("APPDATA", "")) / "npm" / "claude",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "claude" / "claude.exe",
    ]
    for c in candidates:
        try:
            if c and c.exists():
                _CLAUDE_EXE_CACHE = str(c); return str(c)
        except Exception:
            pass
    return "claude"  # last resort — let subprocess try PATH

def _run_claude(prompt: str, timeout: int, model: str) -> tuple:
    """Single Claude CLI invocation. Returns (text, error, meta)."""
    try:
        args = [_find_claude(), "--print", "--output-format", "json"]
        if model:
            args += ["--model", model]
        result = subprocess.run(
            args, input=prompt, capture_output=True, text=True,
            timeout=timeout, encoding="utf-8", errors="replace",
        )
        raw = result.stdout.strip()
        stderr = result.stderr.strip()
        _L("claude_call", model=model or "default", rc=result.returncode, out_len=len(raw), stderr=(stderr[:200] if stderr else ""))
        if raw:
            try:
                data = _json.loads(raw)
                text = data.get("result", "") or ""
                usage = data.get("usage", {}) or {}
                # Determine which model actually ran (from response, else what we requested)
                model_used = data.get("model") or ""
                mu = data.get("modelUsage") or {}
                if not model_used and mu:
                    model_used = list(mu.keys())[0]
                meta = {
                    "input_tokens": usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "duration_ms": data.get("duration_ms", 0),
                    "cost_usd": data.get("total_cost_usd", 0),
                    "model": model_used or (model or "default"),
                }
                if text:
                    return text.strip(), None, meta
                return None, "Empty result from Claude", meta
            except Exception:
                return raw, None, {}  # Not JSON — older CLI, treat raw as text
        if stderr:
            return None, f"CLI error: {stderr[:300]}", {}
        return None, f"No output (returncode={result.returncode})", {}
    except FileNotFoundError:
        return None, "claude CLI not found — is Claude Code installed?", {}
    except subprocess.TimeoutExpired:
        return None, f"Timed out after {timeout}s", {}
    except Exception as e:
        return None, str(e), {}


def call_claude(prompt: str, timeout: int = 120, model: str = None) -> tuple:
    """Call Claude CLI. If a specific model is requested but unavailable, fall back
    to the account's default model automatically (so it never fails on plan/model access)."""
    text, err, meta = _run_claude(prompt, timeout, model)
    # Retry with default model only if a model was forced AND it failed for a non-timeout reason
    if model and not text and err and "Timed out" not in err and "not found" not in err:
        _L("claude_fallback", model=model, reason=err)
        text, err, meta = _run_claude(prompt, timeout, None)
    return text, err, meta

# ── Configuration ──────────────────────────────────────────────────────────────
DB_PATH = os.environ.get("BRAIN_DB", str(Path(__file__).parent / "brain.db"))

app = FastAPI(
    title="SAP Local Brain",
    description="FTS5-powered search over SAP Cutover roadmap content",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as _Req

class NoCacheMiddleware(BaseHTTPMiddleware):
    """Tell browsers never to cache JS/CSS/HTML so code changes take effect immediately."""
    async def dispatch(self, request: _Req, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith((".js", ".css", ".html")) and not path.endswith(".min.js"):
            response.headers["Cache-Control"] = "no-store"
        elif path in ("/", ""):
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(NoCacheMiddleware)


# ── DB helpers ─────────────────────────────────────────────────────────────────

@contextmanager
def get_db():
    if not Path(DB_PATH).exists():
        raise FileNotFoundError(
            f"Database not found at {DB_PATH}. "
            "Run: python indexer.py --dir <brain-data-folder> first."
        )
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


# ── Request/Response models ────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    q: str
    limit: Optional[int] = 10


class SearchResult(BaseModel):
    chunk_id: int
    source_id: int
    source: str
    source_type: str
    heading: str
    text: str
    score: float
    rank: float

class AskRequest(BaseModel):
    q: str
    limit: Optional[int] = 6

class AgentRequest(BaseModel):
    key: str
    project_name: Optional[str] = ""
    modules: Optional[List[str]] = []
    task_summary: Optional[str] = ""
    extra: Optional[str] = ""


class StatusResponse(BaseModel):
    chunks: int
    sources: int
    db_path: str
    status: str


class SourceItem(BaseModel):
    id: int
    filename: str
    source_type: str
    title: str
    indexed_at: str
    chunk_count: int


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/api/brain-debug")
def brain_debug():
    """Debug endpoint: tests the exact FTS queries used in enrich and returns row counts."""
    results = {}
    raw_q = "cutover execute verify confirm freeze lock migrate validate"
    fts1 = _to_fts_query(raw_q)   # now quoted: "cutover" OR "execute" OR ...
    results["fts_quoted"] = fts1
    try:
        with get_db() as conn:
            results["chunks_total"] = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            results["chunks_fts_total"] = conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0]
            # Test 1: simple FTS count with quoted tokens
            try:
                results["simple_match_count"] = conn.execute(
                    "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?", (fts1,)
                ).fetchone()[0]
            except Exception as e:
                results["simple_match_error"] = str(e)
            # Test 2: full join (same as _brain_query path in enrich)
            try:
                rows2 = conn.execute(
                    """SELECT c.heading, s.source_type FROM chunks c
                       JOIN sources s ON c.source_id = s.id
                       JOIN chunks_fts ON c.id=chunks_fts.rowid
                       WHERE chunks_fts MATCH ? ORDER BY chunks_fts.rank LIMIT 5""",
                    (fts1,)
                ).fetchall()
                results["join_rows"] = [{"heading": r["heading"], "type": r["source_type"]} for r in rows2]
                results["join_count"] = len(rows2)
            except Exception as e:
                results["join_error"] = str(e)
            # Test 3: unquoted control (should fail or return 0 in Python 3.14)
            unquoted = " OR ".join(w for w in raw_q.split() if len(w) > 2)
            try:
                results["unquoted_match_count"] = conn.execute(
                    "SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH ?", (unquoted,)
                ).fetchone()[0]
            except Exception as e:
                results["unquoted_match_error"] = str(e)
    except Exception as e:
        results["db_error"] = str(e)
    return results


@app.get("/api/status", response_model=StatusResponse)
def status():
    """Return DB statistics — used by the React app to show brain availability."""
    try:
        with get_db() as conn:
            chunks  = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            sources = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
        return StatusResponse(
            chunks=chunks,
            sources=sources,
            db_path=str(Path(DB_PATH).resolve()),
            status="online",
        )
    except FileNotFoundError:
        return StatusResponse(chunks=0, sources=0, db_path=DB_PATH, status="not_indexed")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search")
def search(req: SearchRequest):
    """FTS5 full-text search. Returns ranked chunks with source metadata."""
    q = (req.q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query 'q' must not be empty")
    limit = max(1, min(req.limit or 10, 50))

    try:
        with get_db() as conn:
            # FTS5 MATCH query — porter stemming + unicode61
            # rank is a negative number from FTS5 (lower = more relevant)
            rows = conn.execute(
                """
                SELECT
                  c.id          AS chunk_id,
                  c.source_id,
                  s.filename    AS source,
                  s.source_type,
                  c.heading,
                  c.text,
                  chunks_fts.rank AS rank
                FROM chunks c
                JOIN sources s ON c.source_id = s.id
                JOIN chunks_fts ON c.id = chunks_fts.rowid
                WHERE chunks_fts MATCH ?
                ORDER BY chunks_fts.rank
                LIMIT ?
                """,
                (q, limit),
            ).fetchall()

        results = []
        for i, row in enumerate(rows):
            rank = float(row["rank"] or 0)
            # Convert FTS5 rank (negative) to a 0-1 score (higher = better)
            score = max(0.0, 1.0 - abs(rank) / 10.0)
            results.append(
                {
                    "chunk_id":    row["chunk_id"],
                    "source_id":   row["source_id"],
                    "source":      row["source"],
                    "source_type": row["source_type"],
                    "heading":     row["heading"] or "",
                    "text":        row["text"],
                    "score":       round(score, 4),
                    "rank":        rank,
                }
            )

        return {"results": results, "query": q, "count": len(results)}

    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except sqlite3.OperationalError as e:
        # FTS5 parse errors (bad query syntax) → 400
        raise HTTPException(status_code=400, detail=f"Search error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/sources")
def sources():
    """List all indexed source files with chunk counts."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT
                  s.id, s.filename, s.source_type, s.title, s.indexed_at,
                  COUNT(c.id) AS chunk_count
                FROM sources s
                LEFT JOIN chunks c ON c.source_id = s.id
                GROUP BY s.id
                ORDER BY s.indexed_at DESC
                """
            ).fetchall()
        return {
            "sources": [
                {
                    "id":          r["id"],
                    "filename":    r["filename"],
                    "source_type": r["source_type"],
                    "title":       r["title"] or r["filename"],
                    "indexed_at":  r["indexed_at"],
                    "chunk_count": r["chunk_count"],
                }
                for r in rows
            ],
            "total": len(rows),
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


DATA_DIR = os.environ.get("BRAIN_DATA", str(Path(__file__).parent))

@app.post("/api/ingest")
async def ingest(request):
    """Receive exported files from the Chrome extension, save + auto-index."""
    import importlib, sys
    from fastapi import Request
    from fastapi.responses import JSONResponse

    body = await request.json()
    files = body.get("files", [])
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    data_path = Path(DATA_DIR)
    files_path = data_path / "files"
    files_path.mkdir(parents=True, exist_ok=True)

    saved = []
    for f in files:
        name    = f.get("name", "file")
        ext     = f.get("ext", "bin")
        content = f.get("base64", "")
        if not content:
            continue
        filename = f"{name}.{ext}"
        try:
            file_path = files_path / filename
            file_path.write_bytes(base64.b64decode(content))
            saved.append(filename)
        except Exception as e:
            _LE("ingest_save_error", error=str(e))

    # Also write meta files
    for key in ("diagnostics", "manifest"):
        if body.get(key):
            (data_path / f"{key}.json").write_text(_json.dumps(body[key], indent=2), encoding="utf-8")

    # Trigger background re-index (FTS5 keyword index)
    def _reindex():
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            import indexer
            importlib.reload(indexer)
            db = os.environ.get("BRAIN_DB", str(Path(__file__).parent / "brain.db"))
            indexer.index_directory(str(files_path), db)
        except Exception as e:
            _LE("reindex_error", error=str(e))
    threading.Thread(target=_reindex, daemon=True).start()

    return {"ok": True, "saved": len(saved), "files": saved}


@app.post("/api/ask")
def ask(req: AskRequest):
    """Knowledge retrieval: FTS5 search → structured answer from SAP content."""
    q = (req.q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query 'q' must not be empty")
    limit = max(1, min(req.limit or 8, 20))

    fts_q = _to_fts_query(q)

    # Use FTS5 full-text search — reliable, no model loading needed
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT c.heading, c.text, s.filename, s.source_type,
                       chunks_fts.rank AS rank
                FROM chunks c
                JOIN sources s ON c.source_id = s.id
                JOIN chunks_fts ON c.id = chunks_fts.rowid
                WHERE chunks_fts MATCH ?
                ORDER BY chunks_fts.rank
                LIMIT ?
                """,
                (fts_q, limit),
            ).fetchall()
    except sqlite3.OperationalError:
        # FTS5 failed — fall back to LIKE on individual keywords
        keywords = [w for w in fts_q.split(" OR ") if w]
        like_term = keywords[0] if keywords else q
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT c.heading, c.text, s.filename, s.source_type, 0 AS rank
                FROM chunks c JOIN sources s ON c.source_id = s.id
                WHERE c.text LIKE ? LIMIT ?
                """,
                (f"%{like_term}%", limit),
            ).fetchall()

    if not rows:
        return {"answer": "No relevant content found in the SAP knowledge base for your query.", "query": q, "sources": []}

    # Group by source file
    from collections import defaultdict
    by_source = defaultdict(list)
    for row in rows:
        by_source[row["filename"]].append(row)

    parts = []
    for filename, items in by_source.items():
        label = filename.replace("_", " ").replace(".html","").replace(".pptx","").replace(".xlsx","")
        lines = []
        seen_text = set()
        for item in items:
            text = item["text"].strip()
            if text in seen_text:
                continue
            seen_text.add(text)
            heading = (item["heading"] or "").strip()
            if heading and heading not in text[:80]:
                lines.append(f"▸ {heading}\n{text}")
            else:
                lines.append(f"▸ {text}")
        parts.append(f"📄 {label}\n\n" + "\n\n".join(lines))

    raw_answer = "\n\n────────────────────────\n\n".join(parts)

    # Try Claude synthesis if available — falls back to raw FTS5 output
    synthesis_prompt = (
        f"You are an SAP S/4HANA Public Cloud cutover expert. "
        f"Using ONLY the SAP content below, answer this question concisely and clearly:\n\n"
        f"Question: {q}\n\n"
        f"SAP Content:\n{raw_answer}\n\n"
        f"Provide a direct, structured answer. If the content does not cover the question, say so."
    )
    synthesized, _, _ = call_claude(synthesis_prompt, timeout=90)
    answer = synthesized if synthesized else raw_answer

    sources = [
        {"heading": r["heading"] or "", "source": r["filename"]}
        for r in rows
    ]
    return {"answer": answer, "query": q, "sources": sources, "synthesized": synthesized is not None}


_AGENT_SEARCH = {
    "waveOrchestration": "wave orchestration cutover sequence phases planning timeline",
    "commandCenter":     "command center go live cutover execution monitoring war room",
    "readiness":         "readiness assessment checklist criteria sign-off preparation",
    "ricefw":            "RICEFW custom development objects testing unit integration",
    "riskMitigation":    "risk mitigation cutover risks issues contingency rollback",
    "dataValidation":    "data migration validation reconciliation quality cutover",
    "goNoGo":            "go no-go decision criteria approval governance cutover",
    "retrospective":     "cutover lessons learned retrospective post go-live review",
    "healthCheck":       "cutover status readiness blocked tasks risks go-live preparation",
    "cutoverBrief":      "cutover planning SAP Activate methodology phases preparation approach timeline",
    "rollbackPlan":      "rollback plan recovery contingency cutover failure scenario fallback trigger",
    "executiveReport":   "executive summary report status cutover readiness governance decision sponsor",
    "whatIf":            "cutover scenario simulation impact analysis dependency delay risk critical path",
    "hypercare":         "hypercare transition support post go-live stabilization monitoring KPI",
    "planEnrich":        "SAP Activate cutover task checklist mandatory activities workstream completeness missing tasks",
    "taskBlocker":       "cutover blocker resolution dependency escalation contingency workaround bypass",
    "ownerGap":          "cutover ownership responsibility assignment RACI single point failure workstream lead",
}

_AGENT_ROLE = {
    "waveOrchestration": "Wave Orchestration specialist who sequences and coordinates all cutover waves",
    "commandCenter":     "Command Center lead who monitors and controls live cutover execution",
    "readiness":         "Readiness Assessor who evaluates if the project is ready to go live",
    "ricefw":            "RICEFW expert who assesses custom development readiness and test results",
    "riskMitigation":    "Risk & Mitigation specialist who identifies cutover risks and contingency plans",
    "dataValidation":    "Data Validation lead who verifies data migration completeness and accuracy",
    "goNoGo":            "Go/No-Go Judge who makes the final cutover approval recommendation",
    "retrospective":     "Retrospective facilitator who captures lessons learned post go-live",
    "healthCheck":       "Cutover Health Analyst who reviews current project status, identifies risks, and gives a client-ready daily status narrative",
    "cutoverBrief":      "Cutover Planning Expert who assesses a project plan against SAP Activate methodology and produces an executive brief with risks, recommendations and timeline assessment",
    "rollbackPlan":      "Rollback Planning specialist who designs a structured phase-by-phase rollback strategy with decision triggers, ownership assignments, and recovery timelines for each cutover phase",
    "executiveReport":   "Executive Reporting specialist who produces a concise, sponsor-ready executive summary of cutover health, confidence level, key risks, and go-live recommendation with business-language rationale",
    "whatIf":            "Cutover Simulation expert who analyses what-if scenarios — given a proposed change or delay, assesses the downstream impact on the cutover schedule, critical path, and go-live timeline, and recommends mitigations",
    "hypercare":         "Hypercare Transition Planner who designs the post go-live support model including hypercare schedule, escalation framework, war-room roster, and KPIs for the stabilization period",
    "planEnrich":        "Cutover Plan Enrichment specialist who reviews a project's task list against SAP Activate best practice, identifies missing critical activities per workstream, flags under-resourced areas, and recommends specific additional tasks to close gaps",
    "taskBlocker":       "Cutover Blocker Resolution specialist who analyses a specific blocked cutover task and provides 3-5 concrete, immediately actionable resolution steps with owner suggestions and escalation paths grounded in SAP methodology",
    "ownerGap":          "Cutover Ownership Analyst who reviews task ownership across the cutover plan, identifies single points of failure, unassigned critical-path tasks, and recommends RACI improvements to reduce delivery risk",
}


@app.post("/api/agent")
def run_agent(req: AgentRequest):
    """Run a named cutover agent: search brain for SAP context, synthesize with Claude CLI."""
    # FTS5 treats a bare multi-word string as AND (all terms required) → usually 0 hits.
    # Convert to an OR query so the brain actually contributes context.
    search_q = _to_fts_query(_AGENT_SEARCH.get(req.key, f"{req.key} SAP S/4HANA cutover"))
    role = _AGENT_ROLE.get(req.key, f"SAP cutover specialist running the {req.key} agent")

    # Pull relevant SAP content from brain
    brain_chunks = []
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT c.heading, c.text, s.filename
                FROM chunks c JOIN sources s ON c.source_id = s.id
                JOIN chunks_fts ON c.id = chunks_fts.rowid
                WHERE chunks_fts MATCH ? ORDER BY chunks_fts.rank LIMIT 10
                """,
                (search_q,),
            ).fetchall()
        for row in rows:
            heading = (row["heading"] or "").strip()
            text = row["text"].strip()
            source = row["filename"].replace("_", " ").replace(".html", "").replace(".pptx", "").replace(".xlsx", "")
            brain_chunks.append(f"[{source}] {heading + ': ' if heading else ''}{text}")
    except Exception:
        pass

    brain_context = "\n\n".join(brain_chunks) if brain_chunks else "No specific SAP methodology content found."

    modules_str = ", ".join(req.modules) if req.modules else "Not specified"
    prompt = f"""You are an expert SAP S/4HANA Public Cloud cutover specialist acting as {role}.

PROJECT DETAILS:
- Project: {req.project_name or "SAP Cutover Project"}
- Modules in scope: {modules_str}
- Task status: {req.task_summary or "No task data provided"}
{("- " + req.extra) if req.extra else ""}

SAP ACTIVATE METHODOLOGY CONTEXT (from knowledge base):
{brain_context}

{('WHAT-IF SCENARIO TO ANALYSE: ' + req.extra + chr(10) + chr(10)) if req.key == 'whatIf' and req.extra else ''}Using the SAP methodology above as your grounding, provide a structured {req.key} analysis with:
1. Key findings and observations
2. Recommended actions (prioritised)
3. Risks or gaps to flag
4. Next steps

Be specific, actionable, and grounded in the SAP content provided."""

    text, err, meta = call_claude(prompt, timeout=120)

    if text:
        return {"text": text, "source": "claude", "brain_chunks": len(brain_chunks), "meta": meta}

    # Claude CLI not available — return structured brain content as fallback
    if brain_chunks:
        fallback = f"SAP Methodology Guidance for {req.key.upper()} (Claude CLI not available — install and authenticate Claude CLI to get AI analysis):\n\n" + "\n\n".join(brain_chunks)
        return {"text": fallback, "source": "brain", "brain_chunks": len(brain_chunks)}

    raise HTTPException(
        status_code=503,
        detail="Claude CLI not available. Please install Claude CLI and authenticate with your Claude subscription."
    )


# Execution order of a cutover. Used to sequence the plan and to chain
# predecessors: reviewers asked for tasks "in execution sequence, not
# alphabetically", and for each task to state what it depends on.
_ACTIVITY_RANKS = [
    (_re.compile(r"^(freeze|lock|close|stop|suspend|cut.?off|restrict)\b", _re.I), 1),
    (_re.compile(r"^(extract|export|download|retrieve)\b", _re.I), 2),
    (_re.compile(r"^(transport|deploy|import|promote)\b", _re.I), 3),
    (_re.compile(r"^(load|upload|migrate|convert|re.?create|post)\b", _re.I), 4),
    (_re.compile(r"^(validate|verify|reconcile|check|confirm|smoke|compare|execute\s+end.to.end)\b", _re.I), 5),
    (_re.compile(r"^(activate|enable|unlock|release|ramp|switch|open)\b", _re.I), 6),
    (_re.compile(r"^(sign.?off|approve|obtain|complete\s+required)\b", _re.I), 7),
    (_re.compile(r"^(monitor|triage|provide\s+support|daily\s+monitoring)\b", _re.I), 8),
]
_RANK_FALLBACK = [
    (_re.compile(r"\b(freeze|lock|blackout)\b", _re.I), 1),
    (_re.compile(r"\b(extract|export)\b", _re.I), 2),
    (_re.compile(r"\btransport\b", _re.I), 3),
    (_re.compile(r"\b(load|migrate|upload)\b", _re.I), 4),
    (_re.compile(r"\b(validate|verify|reconcile|smoke|confirm)\b", _re.I), 5),
    (_re.compile(r"\b(activate|unlock|release|ramp)\b", _re.I), 6),
    (_re.compile(r"\b(sign.?off|go.?/?no.?go|handover|hand.?over|gate)\b", _re.I), 7),
    (_re.compile(r"\b(hypercare|monitor|support|triage)\b", _re.I), 8),
]

def _activity_rank(name: str) -> int:
    n = (name or "").strip()
    for pat, r in _ACTIVITY_RANKS:
        if pat.match(n):
            return r
    for pat, r in _RANK_FALLBACK:
        if pat.search(n):
            return r
    return 4

# Activities that only exist on-premise or in private cloud. This tool targets
# SAP S/4HANA Public Cloud exclusively, which has no transport management
# system, no RFC layer, no backend catalog sync and no prod-equivalent tenant
# to validate roles against, so these are always dropped.
_ONPREM_RE = _re.compile(
    r"\btms\b|transport\s+management\s+system|\brfc\b|\bstms\b|\bsm59\b|\bse38\b"
    r"|fiori\s+(backend\s+)?catalog\s+sync|backend\s+catalog\s+sync"
    r"|info\s*object|enterprise\s+search\s+setup"
    r"|authori[sz]ation\s+trace|cache\s+invalidation"
    r"|prod(uction)?[-\s]?equivalent|\bsap\s*gui\b", _re.I)


# ── Mandatory cutover tasks per business area ─────────────────────────────────
# SAP-standard go-live activities, not project-specific content. Each entry is
# emitted ONLY when that area is actually in scope, so a Finance-only project
# never sees the Manufacturing list. Free-form prompt guidance produces these
# inconsistently; an explicit numbered list produces them every run.
_AREA_TASKS = [
    (_re.compile(r"financ|account|controlling|treasur|\bfi\b|\bco\b|\bfico\b", _re.I),
     "Finance", [
        "Reconcile and load G/L opening balances in Production; confirm the trial balance agrees to legacy",
        "Migrate and validate AR open items in Production; confirm open-item count and aged balance match legacy",
        "Migrate and validate AP open items in Production; confirm open-item count and aged balance match legacy",
        "Migrate fixed asset master data and asset postings; reconcile asset values and accumulated depreciation",
        "Load and validate cost centre, profit centre and G/L master data in Production",
        "Execute last-document posting and period-close checks in legacy before the finance freeze",
        "Finance sign-off per data object, naming the reconciliation evidence produced",
     ]),
    (_re.compile(r"\bsales\b|distribution|order.to.cash|\botc\b|\bsd\b|billing", _re.I),
     "Sales and Distribution", [
        "Validate open sales order and delivery backlog in legacy before freeze; confirm the count matches the migration object count",
        "Migrate open sales orders to Production via the data migration cockpit and confirm load counts",
        "Upload pricing condition records to Production and validate them in the condition record app",
        "Migrate condition contracts to Production; verify opening accrual balances and settlement readiness",
        "Validate business partner and customer master migration completeness in Production before the smoke test",
        "Execute end-to-end order-to-cash smoke test in Production: quotation, sales order, delivery, goods issue, billing, AR posting",
        "Validate customer invoice and credit memo output forms in Production",
     ]),
    (_re.compile(r"service|\bcs\b|\bsm\b|customer\s*service|field\s*service", _re.I),
     "Service Management", [
        "Reconcile open service orders, service contracts and repair orders in legacy before freeze",
        "Migrate applicable open service items to Production via the data migration cockpit",
        "Validate service contract and service order master data completeness in Production",
        "Execute end-to-end service smoke test in Production: notification, service order, confirmation, billing, AR posting",
        "Validate service notification and service integration interfaces in Production",
     ]),
    (_re.compile(r"manufactur|production\s*planning|\bpp\b|shop\s*floor|\bqm\b", _re.I),
     "Manufacturing", [
        "Close all open production orders in the legacy system before the cutover date",
        "Re-create production orders raised between cutover start and go-live directly in Production",
        "Migrate or validate manufacturing master data: bills of material, work centres, routings and task lists, production versions",
        "Activate WIP batch configuration where WIP batch management is in scope",
        "Activate MRP background jobs and confirm the first planning run completes successfully",
     ]),
    (_re.compile(r"supply\s*chain|logistic|warehouse|inventor|\bewm\b|\bwm\b|\ble\b|stock", _re.I),
     "Supply Chain", [
        "Migrate or validate materials and products, storage locations and warehouse structures in Production",
        "Upload opening stock balances for all relevant materials and storage locations and reconcile against legacy",
        "Verify warehouse structures, bin configuration and warehouse management integration in Production",
        "Inform suppliers, logistics partners and integration counterparts of the go-live date and expected downtime",
        "Inventory valuation and stock reconciliation sign-off naming the evidence produced",
     ]),
    (_re.compile(r"procure|sourcing|purchas|\bmm\b|supplier|vendor", _re.I),
     "Sourcing and Procurement", [
        "Reconcile open purchase orders and purchase requisitions in legacy before freeze",
        "Migrate open purchase orders to Production and confirm load counts and open quantities",
        "Migrate or validate supplier master data and purchasing info records in Production",
        "Validate source lists, contracts and scheduling agreements in Production",
        "Execute end-to-end procure-to-pay smoke test in Production",
     ]),
    (_re.compile(r"develop|technical|\babap\b|extensib|\bbtp\b|integration\s*dev|ricefw", _re.I),
     "Development and Technical", [
        "Pre-cutover Production subaccount readiness sign-off",
        "Destination configuration in Production and connectivity validation",
        "Launchpad content configuration and validation in Production",
        "Launchpad content refresh after each deployment to Production",
        "Execute end-to-end output test for critical forms covering data, template determination, language, formatting and output channel",
        "Validate technical dependency and import sequence for ABAP Cloud and RAP objects, APIs, CDS views, services and extensibility objects",
     ]),
    (_re.compile(r"asset\s*management|maintenance|\bpm\b|\beam\b|plant\s*maint", _re.I),
     "Asset Management", [
        "Close open maintenance and work orders in the legacy system before cutover",
        "Migrate or validate functional locations, equipment and maintenance plans in Production",
        "Re-create open work orders in Production",
        "Activate maintenance background jobs and confirm scheduling",
     ]),
    (_re.compile(r"human\s*resource|\bhr\b|\bhcm\b|payroll|personnel", _re.I),
     "Human Resources", [
        "Migrate or validate employee master data and organisational assignments in Production",
        "Reconcile payroll-relevant balances in legacy before freeze",
        "Validate employee self-service access and org structure in Production",
     ]),
]


# Business areas detected from what the L4's TASKS actually describe, rather than
# from workstream labels. Real L4s often label workstreams by SAP Activate
# delivery track (EUT, KUT, OCM, Quality Gate, RICEFW) and never name a business
# area at all, which previously left Sales, Service, Manufacturing and Supply
# Chain with no tasks. Patterns are deliberately noun-specific so a passing
# mention of "service" or "delivery" does not pull a whole area into scope.
_AREA_CONTENT = [
    (_re.compile(r"g/?l\b|general ledger|accounts?\s+(receivable|payable)|open items?"
                 r"|trial balance|fixed asset|asset master|cost cent|profit cent"
                 r"|dunning|bank statement|accounts? closing", _re.I), "Finance"),
    (_re.compile(r"sales order|open deliver|billing document|pricing condition"
                 r"|condition record|condition contract|customer master"
                 r"|sales quotation|credit memo|order.to.cash", _re.I), "Sales and Distribution"),
    (_re.compile(r"service order|service contract|service notification|repair order"
                 r"|service confirmation", _re.I), "Service Management"),
    (_re.compile(r"production order|process order|bill of material|\bbom\b|work cent"
                 r"|routing|task list|production version|\bmrp\b|wip batch", _re.I), "Manufacturing"),
    (_re.compile(r"storage location|warehouse|opening stock|stock balance|inventory"
                 r"|goods (receipt|issue)|material master|product master|\bbin\b", _re.I), "Supply Chain"),
    (_re.compile(r"purchase order|purchase requisition|purchasing info|supplier master"
                 r"|vendor master|source list|scheduling agreement|procure.to.pay", _re.I),
     "Sourcing and Procurement"),
    (_re.compile(r"maintenance order|functional location|equipment master|work order",
                 _re.I), "Asset Management"),
    (_re.compile(r"payroll|employee master|personnel (number|area)|org(anisational)? assignment",
                 _re.I), "Human Resources"),
]


# ── SAP scope-item catalog: id -> (name, line of business) ────────────────────
# The catalog is the authority on which business area a scope item belongs to,
# so in-scope areas are derived from the L4 itself rather than pattern-matching
# whatever a client happened to call their workstreams.
_SCOPE_MAP = None

def _scope_map() -> dict:
    global _SCOPE_MAP
    if _SCOPE_MAP is None:
        _SCOPE_MAP = {}
        try:
            cat = Path(__file__).parent / "files" / "scope-catalog.json"
            with open(cat, encoding="utf-8") as fh:
                for rec in (_json.load(fh).get("processes") or []):
                    sid = str(rec.get("id") or "").strip().upper()
                    if sid:
                        _SCOPE_MAP[sid] = (str(rec.get("name") or "").strip(),
                                           str(rec.get("lob") or "").strip())
            _L("scope_map_loaded", items=len(_SCOPE_MAP))
        except Exception as _e:
            _LE("scope_map_load_failed", err=str(_e)[:200])
    return _SCOPE_MAP

# SAP module abbreviation -> SAP Line of Business (both SAP-standard taxonomies).
# Lets module selection drive coverage when an L4 carries no scope-item column.
_MODULE_LOB = {
    "fi": "Finance", "co": "Finance", "fico": "Finance", "fin": "Finance",
    "tr": "Finance", "fscm": "Finance", "ca": "Finance",
    "sd": "Sales", "crm": "Sales",
    "cs": "Service", "sm": "Service",
    "mm": "Sourcing and Procurement", "srm": "Sourcing and Procurement",
    "pur": "Sourcing and Procurement",
    "pp": "Manufacturing", "qm": "Manufacturing", "ppds": "Manufacturing",
    "ewm": "Supply Chain", "le": "Supply Chain", "wm": "Supply Chain",
    "tm": "Supply Chain", "ibp": "Supply Chain", "mrp": "Supply Chain",
    "pm": "Asset Management", "eam": "Asset Management",
    "hcm": "Human Resources", "hr": "Human Resources", "sf": "Human Resources",
    "ps": "Professional Services", "concur": "Professional Services",
    "re": "Finance", "aa": "Finance", "eam": "Asset Management",
    "scm": "Supply Chain", "gts": "Supply Chain", "ariba": "Sourcing and Procurement",
    "ec": "Human Resources",
    "btp": "Technology and Integration", "s4core": "Technology and Integration",
    "cpi": "Technology and Integration",
    "mdg": "Data Management", "bw": "Data Management", "sac": "Data Management",
    "plm": "R&D and Engineering", "dms": "R&D and Engineering",
}
# The UI now stores LoB names directly; older saved sessions still hold module
# codes, so both resolve. Identity entries are added once at import.
for _lob in set(_MODULE_LOB.values()) | {
        "Technology and Integration", "Data Management", "R&D and Engineering"}:
    _MODULE_LOB.setdefault(_lob.lower(), _lob)


# ── Generate full cutover plan from L4 context ────────────────────────────────

class GeneratePlanRequest(BaseModel):
    project_name: str = ""
    modules: list = []
    industry: str = ""
    scope_items: list = []  # SAP scope item IDs present in the L4 (e.g. "J59")
    project_context: dict = {}  # all Plan Builder fields (countries, entities, systems, windows)
    l4_tasks: list = []   # ALL L4 rows (all phases) — [{task, workstream, phase, scopeItem}]

@app.post("/api/generate-from-l4")
def generate_from_l4(req: GeneratePlanRequest):
    """Read the full L4 plan and generate a complete PRE/CUT/HC cutover plan via Claude."""
    if not req.l4_tasks:
        raise HTTPException(status_code=400, detail="l4_tasks is required")

    # ── Classify L4 tasks by role ──────────────────────────────────────────────
    _BUILD_WS  = _re.compile(r'develop|build|ricefw|extension|custom|technical|program', _re.I)
    _RICEFW_NAME = _re.compile(r'\(ST-\d+\)|\bRICEFW\b|report\s|interface\s|enhancement\s|conversion\s|form\s|workflow\s', _re.I)
    # Skip purely ceremonial rows (sprint ceremonies, standalone TSD rows with NO item name after them)
    # NOTE: negative lookahead (?!\s*[-–]) keeps "TSD creation - <item name>" rows (they carry real RICEFW data)
    _SKIP_TASK = _re.compile(
        r'^\s*(sprint\s+(review|retro)|daily\s+stand|review\s+daily\s+status|'
        r'tsd\s+(creation|review)(?!\s*[-–])|status\s+update|participate\s+in)', _re.I
    )
    _STRIP_SFXS = _re.compile(
        r'\s*[-–]\s*(build(\s*[&/]\s*(unit\s*test|ut|tut))?'
        r'|unit\s*test|ut(?!\s+\w)|tut'
        r'|tsd(\s+(creation|review(\s*[&/]\s*(approval|sign[\s-]*off)?)?))?'
        r'|fsd(\s+(preparation|review(\s*[&/]\s*(approval|sign[\s-]*off)?)?))?'
        r'|final(\s+version)?(\s+(prep|review|approval|sign[\s-]*off))?'
        r'|prep(aration)?'
        r'|sprint\s*\d+(\s+(build|review|retro|planning|prep))?'
        r'|review(\s*[&/]\s*(approval|sign[\s-]*off))?'
        r'|config(uration)?)\s*.*$', _re.I
    )
    _STRIP_PFXS = _re.compile(
        r'^\s*(tsd\s+(creation|review)\s*[-–]\s*|fsd\s+(preparation|review)\s*[-–]\s*|build\s*(&|and)\s*(unit\s*test|ut)\s*[-–]\s*)', _re.I
    )
    # Detect RICEFW items by task-name patterns (catches items in non-Development workstreams)
    _BUILD_TASK_RE = _re.compile(
        r'\b(build\s*[&/]\s*(unit\s*test|ut|tut)|tsd\s*(creation|review)|fsd\s*(preparation|review))\b', _re.I
    )

    # Delivery and governance tracks, not business workstreams. Real L4s carry
    # dozens of these; left in, they fill the workstream budget and crowd out the
    # business areas that actually need tasks.
    _EXCL_WS = _re.compile(
        r'project\s*management|testing|test\b|change\s*management|training|hypercare|cutover'
        r'|\beut\b|\bkut\b|\bocm\b|\bpmo\b|quality\s*gate|enablement|adoption'
        r'|organi[sz]ational\s*change|governance|mobilisation|mobilization', _re.I)

    def _is_bus_ws(w: str) -> bool:
        """Any workstream the L4 declares counts, unless it is a delivery or
        governance function. An allowlist of names cannot anticipate a client's
        own labels (Sales & Distribution, Service Management, Manufacturing...),
        and silently dropped workstreams produce no tasks at all."""
        w = (w or "").strip()
        return len(w) >= 2 and not w.isdigit() and not _EXCL_WS.search(w)

    # Collect unique RICEFW items
    seen_ricefw: set = set()
    ricefw_items = []
    # Collect unique business workstreams
    seen_bws: set = set()
    bws = []

    for t in req.l4_tasks:
        ws  = (t.get("workstream") or "").strip()
        raw = (t.get("task") or "").strip()
        if not raw:
            continue
        # Skip Prepare/Explore phase rows — they contain build/enablement tasks, not production transports
        phase_l4 = (t.get("phase") or "").lower()
        if _re.search(r'\bprepare\b|\bexplore\b', phase_l4):
            if _is_bus_ws(ws):
                key = ws.lower()
                if key not in seen_bws:
                    seen_bws.add(key)
                    bws.append(ws)
            continue
        is_dev_ws = bool(_BUILD_WS.search(ws))
        is_ricefw_name = bool(_RICEFW_NAME.search(raw))
        is_build_task = bool(_BUILD_TASK_RE.search(raw))
        if (is_dev_ws or is_ricefw_name or is_build_task) and not _SKIP_TASK.match(raw):
            clean = _STRIP_PFXS.sub("", raw)
            clean = _STRIP_SFXS.sub("", clean).strip(" -–")
            # Strip navigational qualifiers and WIP markers that create false variants
            clean = _re.sub(r'\s+(through\s+an?\s+(request|navigation)|via\s+\w+|\bwip\b)\s*.*$', '', clean, flags=_re.I).strip(" -–/")
            if clean and len(clean) >= 5:
                key = clean.lower()[:70]
                if key not in seen_ricefw:
                    seen_ricefw.add(key)
                    ricefw_items.append(clean)
        if _is_bus_ws(ws):
            key = ws.lower()
            if key not in seen_bws:
                seen_bws.add(key)
                bws.append(ws)

    # Prefix dedup: if "1NJ" and "1NJ Responsibility Management" both appear,
    # keep the longer (fuller) name and drop the short code version
    ricefw_items_final = []
    seen_full: set = set()
    for item in sorted(ricefw_items, key=len, reverse=True):  # longest first
        k = item.lower().strip()
        # Skip if an already-accepted item starts with this key (it's a subset)
        if any(existing.startswith(k) for existing in seen_full):
            continue
        seen_full.add(k)
        ricefw_items_final.append(item)
    ricefw_items = ricefw_items_final[:25]

    # Business areas implied by the L4's scope items and the selected modules.
    # lob_scope also drives per-area retrieval below, so every in-scope area gets
    # catalog context instead of only the first few scope items overall.
    _smap = _scope_map()
    lob_scope: dict = {}
    for _s in (req.scope_items or []):
        _sid = str(_s or "").strip().upper()
        _hit = _smap.get(_sid)
        if _hit and _hit[1]:
            lob_scope.setdefault(_hit[1], []).append(_sid)
    for _m in (req.modules or []):
        _lob = _MODULE_LOB.get(str(_m or "").strip().lower())
        if _lob:
            lob_scope.setdefault(_lob, [])
    # Third signal: what the tasks themselves describe. Without this an L4 whose
    # workstreams are all delivery tracks yields no business area at all.
    _l4_text = " ".join((t.get("task") or "") for t in req.l4_tasks)[:300000]
    _from_content = []
    for _cpat, _clabel in _AREA_CONTENT:
        if _cpat.search(_l4_text) and _clabel not in lob_scope:
            lob_scope.setdefault(_clabel, [])
            _from_content.append(_clabel)

    # Business areas are ordered FIRST so delivery-track labels can never push
    # them past the cap. Where the L4 has its own label for an area, that label
    # is used as the display name so reviewers see their own vocabulary
    # ("Sales & Distribution" rather than a bare "Sales").
    # Match on the area's HEAD noun only. Token-set overlap wrongly fused
    # "Service Management" into "Data Management" on the shared word
    # "management", losing a whole business area.
    _GENERIC = {"management", "data", "system", "business", "process",
                "services", "service", "and", "chain", "engineering"}

    def _toks(w):
        return {t for t in _re.findall(r"[A-Za-z]{3,}", (w or "").lower())
                if t not in _STOP}

    def _head(w):
        for t in _re.findall(r"[A-Za-z]{3,}", (w or "").lower()):
            if t not in _STOP and t not in _GENERIC:
                return t
        toks = _re.findall(r"[A-Za-z]{3,}", (w or "").lower())
        return toks[0] if toks else ""

    _l4_labels = list(bws)
    _label_toks = [(w, _toks(w)) for w in _l4_labels]
    _ordered, _seen, _used = [], set(), set()
    for _area in lob_scope:
        _ahead = _head(_area)
        _match = next((w for w, t in _label_toks if _ahead and _ahead in t), None)
        _name = _match or _area
        if _name.lower() in _seen:
            continue
        _seen.add(_name.lower())
        _ordered.append(_name)
        if _match:
            _used.add(_match)
    _biz_count = len(_ordered)
    for _w in _l4_labels:
        if _w in _used or _w.lower() in _seen:
            continue
        _seen.add(_w.lower())
        _ordered.append(_w)

    bws = _ordered[:14]
    seen_bws = {w.lower() for w in bws}
    _L("generate_workstreams", l4_labels=len(_l4_labels), business_areas=_biz_count,
       from_content=", ".join(_from_content) or "none", areas=", ".join(bws))

    # Custom-object deployment is Development work, not programme orchestration.
    # The Development reviewer asked for development activities to be separately
    # classifiable; dumping transports into Cutover made that impossible.
    _RICEFW_WS = "Development and Technical"

    modules_str = ", ".join(req.modules) if req.modules else "Not specified"
    industry_str = (req.industry or "").strip()
    project_str  = req.project_name or "SAP S/4HANA Cutover"

    ricefw_block = ""
    if ricefw_items:
        numbered = "\n".join(f"  {i+1}. {n}" for i, n in enumerate(ricefw_items))
        ricefw_block = f"\nRICEFW / CUSTOM DEVELOPMENTS ({len(ricefw_items)} items):\n{numbered}\n"

    bws_block = ""
    if bws:
        bws_block = f"\nBUSINESS WORKSTREAMS IN SCOPE: {', '.join(bws)}\n"

    # ── SAP scope-item context from the knowledge base ──────────────────────
    # Catalog chunks carry their scope item in the heading ("Name (ID)"), so an
    # exact heading match beats FTS here: no tokenizer surprises and no reliance
    # on rank. An L4 with no scope-item column yields no IDs, the section is
    # omitted, and generation behaves exactly as it did before.
    # Retrieve a few scope items PER BUSINESS AREA. Taking the first N overall
    # let a Finance-heavy L4 exhaust the budget before Manufacturing was reached.
    _PER_AREA, _PER_ITEM, _CHARS, _BUDGET = 3, 2, 280, 4500
    scope_ids = []
    for _s in (req.scope_items or []):
        _sid = str(_s or "").strip()
        if _sid and _sid not in scope_ids:
            scope_ids.append(_sid)

    scope_block = ""
    if scope_ids:
        _ordered = []
        if lob_scope:
            for _area, _ids in lob_scope.items():
                for _sid in _ids[:_PER_AREA]:
                    _ordered.append((_area, _sid))
        else:
            _ordered = [("", _sid) for _sid in scope_ids[:12]]

        _lines, _used, _matched = [], 0, 0
        try:
            with get_db() as _conn:
                for _area, _sid in _ordered:
                    _rows = _conn.execute(
                        "SELECT heading, text FROM chunks WHERE heading LIKE ? "
                        "ORDER BY chunk_idx LIMIT ?",
                        (f"%({_sid})%", _PER_ITEM),
                    ).fetchall()
                    if _rows:
                        _matched += 1
                    for _r in _rows:
                        _tag = f"[{_area}] " if _area else ""
                        _entry = f"- {_tag}{_r['heading']}: {_r['text'].strip()[:_CHARS]}"
                        if _used + len(_entry) > _BUDGET:
                            break
                        _lines.append(_entry)
                        _used += len(_entry)
        except Exception as _scope_err:
            _LE("generate_scope_lookup_failed", err=str(_scope_err)[:200])
        _L("generate_scope_ctx", ids=len(scope_ids), areas=len(lob_scope),
           looked_up=len(_ordered), matched=_matched, extracts=len(_lines), chars=_used)
        if _lines:
            scope_block = (
                f"\nSAP SCOPE ITEMS IN SCOPE — catalog extracts for {_matched} of "
                f"{len(scope_ids)} scope items found in the L4 plan:\n"
                + "\n".join(_lines) + "\n"
                "\nFor EACH scope item above, derive the MASTER DATA and TRANSACTIONAL DATA\n"
                "objects that scope item depends on, and generate cutover tasks that NAME\n"
                "those objects explicitly. Required shape:\n"
                "  1. Migrate or validate each named master data object in Production.\n"
                "  2. Reconcile each named transactional backlog in the legacy system before\n"
                "     the freeze, and confirm the loaded count matches the legacy count.\n"
                "  3. Sign-off tasks naming the exact object and the evidence produced.\n"
                "Always prefer a task naming a concrete data object over a generic\n"
                "workstream task.\n"
            )

    # ── Project context: bind the Plan Builder inputs into generation ───────
    # Every field the user fills in should change the output, otherwise the
    # screen is decoration. Countries, company codes and non-SAP systems each
    # generate named tasks; windows and systems make existing tasks specific.
    _pc = req.project_context or {}

    def _pc_list(key, cap):
        v = _pc.get(key) or []
        if isinstance(v, str):
            v = [x.strip() for x in v.split(",")]
        return [str(x).strip() for x in v if str(x).strip()][:cap]

    def _pc_str(key):
        return str(_pc.get(key) or "").strip()

    _countries = _pc_list("countries", 6)
    _entities = _pc_list("legal_entities", 6)
    _nonsap = _pc_list("non_sap", 4)
    _waves = [w for w in (_pc.get("waves") or []) if isinstance(w, dict)][:6]

    _ctx_lines = []
    if _pc_str("cutover_start") or _pc.get("cutover_window_h"):
        _ctx_lines.append("  Cutover window: %sh%s"
                          % (_pc.get("cutover_window_h") or "?",
                             (", starts " + _pc_str("cutover_start")) if _pc_str("cutover_start") else ""))
    if _pc_str("go_live_date"):
        _ctx_lines.append("  Go-live date: %s" % _pc_str("go_live_date"))
    if _pc.get("downtime_h"):
        _ctx_lines.append("  Technical downtime: %sh%s"
                          % (_pc.get("downtime_h"),
                             (" from " + _pc_str("downtime_start")) if _pc_str("downtime_start") else ""))
    if _pc_str("approach"):
        _ctx_lines.append("  Rollout approach: %s" % _pc_str("approach"))
    if _pc_str("source_system"):
        _ctx_lines.append("  Legacy source system: %s" % _pc_str("source_system"))
    if _pc_str("target_system"):
        _ctx_lines.append("  Target system: %s" % _pc_str("target_system"))
    if _pc_str("middleware"):
        _ctx_lines.append("  Middleware / integration platform: %s" % _pc_str("middleware"))
    if _nonsap:
        _ctx_lines.append("  Non-SAP systems in scope: %s" % ", ".join(_nonsap))
    if _countries:
        _ctx_lines.append("  Countries in scope: %s" % ", ".join(_countries))
    if _entities:
        _ctx_lines.append("  Company codes / legal entities: %s" % ", ".join(_entities))
    if _pc_str("governance"):
        _ctx_lines.append("  Governance reference: %s" % _pc_str("governance"))
    if _pc_str("project_ref"):
        _ctx_lines.append("  SAP project reference: %s" % _pc_str("project_ref"))
    if _waves:
        _ctx_lines.append("  Waves: %s" % "; ".join(
            "W%d %s%s" % (i + 1, (w.get("scope") or "wave"),
                          (" go-live " + str(w.get("goLiveDate"))) if w.get("goLiveDate") else "")
            for i, w in enumerate(_waves)))

    _ctx_rules = []
    if _countries:
        _ctx_rules.append(
            "  For EACH country listed (%s) generate ONE task validating that\n"
            "    country's statutory and tax configuration in Production \u2014 localisation\n"
            "    settings, tax codes, statutory reporting and e-document/e-invoicing where\n"
            "    applicable. Name the country in the task." % ", ".join(_countries))
    if _entities:
        _ctx_rules.append(
            "  For EACH company code / legal entity listed (%s) generate ONE\n"
            "    reconciliation task naming that entity (opening balances, open items,\n"
            "    number ranges), plus ONE consolidated finance sign-off covering them all."
            % ", ".join(_entities))
    if _nonsap:
        _ctx_rules.append(
            "  For EACH non-SAP system listed (%s) generate ONE integration\n"
            "    cutover task and ONE connectivity smoke test in Production, naming the\n"
            "    system." % ", ".join(_nonsap))
    if _pc_str("middleware"):
        _ctx_rules.append(
            "  Name the middleware (%s) explicitly in interface transport,\n"
            "    activation and validation tasks rather than saying 'the interface layer'."
            % _pc_str("middleware"))
    if _pc_str("source_system"):
        _ctx_rules.append(
            "  Name the legacy source system (%s) explicitly in freeze, final\n"
            "    extract and reconciliation tasks." % _pc_str("source_system"))
    _win_h = _pc.get("cutover_window_h") or 0
    if _win_h:
        # Workstreams run concurrently during the window, so the binding limit is
        # the longest single chain, not total effort. Expressed per workstream it
        # is a constraint the model can actually act on.
        _ctx_rules.append(
            "  HARD CONSTRAINT \u2014 the cutover window is %sh. Workstreams execute in\n"
            "    PARALLEL within that window, so for EACH workstream the sum of its CUT\n"
            "    task durations must be %sh or less. Before you output, add up the CUT\n"
            "    hours per workstream and reduce individual task hours until every\n"
            "    workstream total is at or under %sh. Finance and the busiest business\n"
            "    areas are the ones that typically overshoot \u2014 check those first."
            % (_win_h, _win_h, _win_h))
    else:
        _ctx_rules.append(
            "  No cutover window was specified. Size every duration on SAP norms and\n"
            "    the reference plans provided above, and state realistic hours rather\n"
            "    than defaulting everything to the same value.")
    if _pc.get("downtime_h"):
        _ctx_rules.append(
            "  Tasks that require system downtime must fit a %sh technical\n"
            "    downtime window." % _pc.get("downtime_h"))
    if _waves and "phase" in _pc_str("approach").lower():
        _ctx_rules.append(
            "  This is a phased rollout with %d waves. Generate per-wave legacy\n"
            "    freeze, go-live and post-go-live validation tasks naming each wave."
            % len(_waves))
    if _pc_str("governance"):
        _ctx_rules.append(
            "  Name the governance body/reference (%s) in go/no-go and\n"
            "    sign-off tasks so the approver is explicit." % _pc_str("governance"))

    ctx_block = ""
    if _ctx_lines:
        ctx_block = ("\nPROJECT CONTEXT \u2014 make tasks specific to THIS project:\n"
                     + "\n".join(_ctx_lines) + "\n")
    if _ctx_rules:
        ctx_block += ("\nCONTEXT-DRIVEN TASKS \u2014 generate ALL of the following:\n"
                      + "\n".join(_ctx_rules) + "\n")
    _L("generate_project_ctx", countries=len(_countries), entities=len(_entities),
       non_sap=len(_nonsap), waves=len(_waves), rules=len(_ctx_rules),
       chars=len(ctx_block))

    # ── SAP Activate methodology for the project's current phase ───────────
    # The Activate phase was previously context text only. The Chrome extension
    # has indexed the me.sap.com Activate deliverables (Deploy, Realize,
    # Production Cutover, Execute Cutover Tasks...), so retrieve that phase's
    # guidance from SAP reference sources only \u2014 never client plans.
    activate_block = ""
    _act_phase = _pc_str("activate_phase")
    if _act_phase:
        _alines2, _aused2 = [], 0
        try:
            with get_db() as _conn:
                _kw = [_act_phase.lower(), "cutover", "production", "go-live"]
                _fts = " OR ".join('"%s"' % w for w in _kw)
                try:
                    _rows = _conn.execute(
                        """SELECT c.heading, c.text FROM chunks c
                           JOIN sources s ON c.source_id = s.id
                           JOIN chunks_fts ON c.id = chunks_fts.rowid
                           WHERE chunks_fts MATCH ?
                             AND s.source_type IN ('html', 'pptx')
                           ORDER BY chunks_fts.rank LIMIT 6""",
                        (_fts,),
                    ).fetchall()
                except Exception:
                    _rows = []
                for _r in _rows:
                    _e = "- %s: %s" % ((_r["heading"] or "").strip()[:70],
                                       _r["text"].strip()[:260])
                    if _aused2 + len(_e) > 2500:
                        break
                    _alines2.append(_e)
                    _aused2 += len(_e)
        except Exception as _act_err:
            _LE("generate_activate_lookup_failed", err=str(_act_err)[:200])
        _L("generate_activate_ctx", phase=_act_phase,
           extracts=len(_alines2), chars=_aused2)
        if _alines2:
            activate_block = (
                "\nSAP ACTIVATE METHODOLOGY \u2014 %s phase guidance from SAP's own\n"
                "deliverable documentation:\n" % _act_phase
                + "\n".join(_alines2) + "\n"
                "Align task naming and sequencing with this methodology where it applies.\n"
            )

    # ── Mandatory task coverage for the business areas actually in scope ────
    # Emitted as explicit numbered lists: free-form guidance generated these
    # items only intermittently, while numbered mandatory lists land every run.
    _area_hay = " | ".join(bws) + " | " + modules_str
    _area_parts = []
    for _pat, _label, _items in _AREA_TASKS:
        if not _pat.search(_area_hay):
            continue
        _numbered = "\n".join("    %d. %s" % (i + 1, t) for i, t in enumerate(_items))
        _area_parts.append("  %s (in scope \u2014 generate ALL %d):\n%s"
                           % (_label, len(_items), _numbered))
        if len(_area_parts) >= 8:
            break
    area_block = ""
    if _area_parts:
        area_block = (
            "BUSINESS AREA COVERAGE \u2014 the following areas are in scope for this\n"
            "project. Generate EVERY numbered task listed under each area, adapted to\n"
            "this project's scope items. These are mandatory go-live activities:\n"
            + "\n".join(_area_parts)
            + "\n  Do not skip any numbered task above.\n"
            "  Write each task as phrased above. Do NOT prefix the business area\n"
            "  name onto the task text; the workstream column already carries it.\n\n"
        )
    _L("generate_area_coverage", areas=len(_area_parts),
       chars=len(area_block))

    # ── Real cutover activities from indexed plans ──────────────────────────
    # The xlsx sources are row-indexed cutover plans (client plans and SAP
    # templates), so this returns actual activities per business area. They are
    # evidence to adapt, never text to copy; the prompt states that explicitly.
    act_block = ""
    if bws:
        _alines, _aused = [], 0
        try:
            with get_db() as _conn:
                for _area in bws[:10]:
                    _kw = [w for w in _re.findall(r"[A-Za-z]{3,}", _area)
                           if w.lower() not in _STOP][:4]
                    if not _kw:
                        continue
                    _fts = " OR ".join('"%s"' % w.lower() for w in _kw)
                    try:
                        _rows = _conn.execute(
                            """SELECT c.heading, c.text FROM chunks c
                               JOIN sources s ON c.source_id = s.id
                               JOIN chunks_fts ON c.id = chunks_fts.rowid
                               WHERE chunks_fts MATCH ?
                                 AND s.source_type IN ('xlsx', 'pptx')
                               ORDER BY chunks_fts.rank LIMIT 3""",
                            (_fts,),
                        ).fetchall()
                    except Exception:
                        continue
                    for _r in _rows:
                        _e = "- [%s] %s" % (_area, _r["text"].strip()[:220])
                        if _aused + len(_e) > 3000:
                            break
                        _alines.append(_e)
                        _aused += len(_e)
        except Exception as _act_err:
            _LE("generate_activity_lookup_failed", err=str(_act_err)[:200])
        _L("generate_activity_ctx", areas=len(bws[:10]),
           extracts=len(_alines), chars=_aused)
        if _alines:
            act_block = (
                "\nREAL CUTOVER ACTIVITIES FROM COMPARABLE SAP PLANS "
                "(%d extracts, tagged by business area):\n" % len(_alines)
                + "\n".join(_alines) + "\n"
                "\nTreat these as evidence of what real cutover plans contain:\n"
                "  1. The KINDS of activity each business area needs at go-live.\n"
                "  2. Realistic sequencing and relative effort.\n"
                "Adapt them to THIS project. Never copy a project-specific name,\n"
                "system identifier, transport number or date from these extracts.\n"
            )

    prompt = (
        f"You are an SAP S/4HANA cutover specialist building a complete cutover plan for: {project_str}\n"
        f"Modules in scope: {modules_str}\n"
        f"Target: SAP S/4HANA Public Cloud. Do NOT generate tasks for transport\n"
        f"management system (TMS/STMS), RFC destinations, Fiori backend catalog sync,\n"
        f"BW info objects, Enterprise Search setup, authorisation trace validation,\n"
        f"cache invalidation, or role validation in a prod-equivalent tenant \u2014 none\n"
        f"of these exist in public cloud.\n"
        f"{('Industry: ' + industry_str + chr(10)) if industry_str else ''}"
        f"{ricefw_block}"
        f"{bws_block}"
        f"{scope_block}"
        f"{act_block}"
        f"{ctx_block}"
        f"{activate_block}\n"
        f"Generate the COMPLETE cutover plan covering PRE / CUT / HC phases.\n\n"
        f"RULES:\n"
        f"- PRE = pre-cutover preparation (weeks before go-live). PRE tasks MUST be from these categories ONLY:\n"
        f"    Runbook sign-off or review, workstream readiness confirmation, dress rehearsal, cutover simulation,\n"
        f"    EUT gate, UAT go-live gate, schedule or communication to stakeholders,\n"
        f"    confirmation that something built in Realize is READY (e.g. 'Confirm transport landscape ready', 'Confirm security roles validated in pre-prod', 'Confirm interfaces tested in QA').\n"
        f"  PRE MUST NOT contain: any setup, configuration, architecture definition, backlog creation, infrastructure build,\n"
        f"    software development, functional or technical spec, code review, training delivery, or workshop.\n"
        f"  If you find yourself generating a setup or configuration task for PRE, do NOT include it.\n"
        f"- CUT = cutover execution weekend: legacy freeze, lock posting periods, close open transactions, "
        f"RICEFW transports (one task per item from the list above — no bundling), "
        f"smoke tests (one per RICEFW item), workstream sign-offs, Go/No-Go decision, system handover\n"
        f"- HC = hypercare (first 2 weeks post go-live): hypercare support per workstream, system monitoring, RICEFW defect triage, BAU handover\n\n"
        f"OUTPUT FORMAT — one task per line, pipe-separated, exactly 7 fields:\n"
        f"TASK|<task name>|<workstream>|<phase PRE/CUT/HC>|<priority HIGH/MEDIUM>|<wave 0/1/2>|<duration_hours>\n"
        f"Wave: 0=PRE, 1=CUT weekend, 2=HC\n"
        f"Priority HIGH = go/no-go gate, freeze/lock, RICEFW transport/smoke-test, sign-off, user unlock, system handover\n"
        f"Duration guidance — assign hours based on task type:\n"
        f"  Meeting / decision (Go/No-Go, sign-off, debrief) → 1\n"
        f"  Config validation / smoke test → 1\n"
        f"  Transport execution → 1\n"
        f"  Data extraction / reconciliation → 4\n"
        f"  Data migration load → 8\n"
        f"  Dress rehearsal / cutover simulation → 8\n"
        f"  Runbook finalization/review → 8\n"
        f"  Hypercare support per workstream → 40\n"
        f"  All other tasks → 4\n\n"
        f"WORKSTREAM ASSIGNMENT — classify every task by asking: who EXECUTES it?\n"
        f"  Workstream = Cutover ONLY for whole-programme orchestration events that no\n"
        f"  single team owns. This is a SHORT list — if one team executes the task, it is\n"
        f"  not Cutover:\n"
        f"    runbook finalisation and sign-off, dress rehearsal / cutover simulation,\n"
        f"    Go/No-Go decision, go-live abort authority, point of no return, fallback to\n"
        f"    legacy, legacy system freeze, end-user lockout, close legacy to display-only,\n"
        f"    system handover to business, transition to BAU, EUT gate, UAT go-live gate\n"
        f"  Everything else names the team that executes it:\n"
        f"    Transport <object> to Production      → Development and Technical\n"
        f"    Smoke test <object> in Production     → Development and Technical\n"
        f"    RICEFW defect triage, custom object monitoring → Development and Technical\n"
        f"    system performance / interface monitoring      → Development and Technical\n"
        f"    user creation, access provisioning, user unlock, role assignment → Security\n"
        f"    data load, extract, reconciliation, post-conversion validation  → Data Migration\n"
        f"    anything naming a business object (G/L, open items, sales orders, stock,\n"
        f"      production orders, purchase orders) → the business area that owns it\n"
        f"  One task, one workstream, one business object type. If a task would cover two\n"
        f"  areas (e.g. 'close open purchase orders and sales orders'), emit it as TWO\n"
        f"  separate tasks, one per area.\n"
        f"  Do NOT use Cutover as a catch-all for anything you are unsure about, and do NOT\n"
        f"  use a single business workstream as a catch-all either.\n\n"
        f"MANDATORY SAP CUTOVER TASKS — the following are SAP platform constants that the L4 will rarely contain.\n"
        f"Check if each is already covered by a task you derived from the L4. If absent, generate it:\n"
        f"  PRE phase (wave 0):\n"
        f"  - Finalize and sign off cutover runbook|Cutover|PRE|HIGH|0|8\n"
        f"  - Readiness confirmation — one per business workstream (e.g. 'Finance readiness confirmation')\n"
        f"  - Dress rehearsal / cutover simulation|Cutover|PRE|HIGH|0|8\n"
        f"  - EUT gate|Cutover|PRE|HIGH|0|1\n"
        f"  - UAT go-live gate|Cutover|PRE|HIGH|0|1\n"
        f"  CUT phase (wave 1) — in execution order:\n"
        f"  - Legacy system freeze — stop new transactions entering legacy|Cutover|CUT|HIGH|1|1  (separate from posting lock)\n"
        f"  - Legacy system posting period lock|Cutover|CUT|HIGH|1|1\n"
        f"  - End-user lockout in legacy system|Cutover|CUT|HIGH|1|1  (separate task — do not merge with posting lock)\n"
        f"  - Close open purchase orders and sales orders in legacy|Cutover|CUT|HIGH|1|4\n"
        f"  - Close legacy systems to display-only (read-only access after cutover)|Cutover|CUT|HIGH|1|1\n"
        f"  - Execute user creation and access provisioning in Production|Cutover|CUT|HIGH|1|4\n"
        f"  - Execute ramp-up activities — activate batch jobs, interfaces, scheduled processes|Cutover|CUT|HIGH|1|4\n"
        f"  - Complete required regulatory and compliance documentation|Cutover|CUT|MEDIUM|1|4\n"
        f"  - For EACH RICEFW item: Transport <item name> to Production|Cutover|CUT|HIGH|1|1\n"
        f"  - For EACH RICEFW item: Smoke test — <item name> in Production|Cutover|CUT|HIGH|1|1\n"
        f"  - Workstream sign-off — one per business workstream\n"
        f"  - Post-conversion validation|Cutover|CUT|HIGH|1|4\n"
        f"  - Go/No-Go decision meeting|Cutover|CUT|HIGH|1|1\n"
        f"  - Unlock users in Production / grant go-live access|Cutover|CUT|HIGH|1|2\n"
        f"  - System handover to business|Cutover|CUT|HIGH|1|1\n"
        f"  HC phase (wave 2):\n"
        f"  - System performance monitoring|Cutover|HC|HIGH|2|4\n"
        f"  - RICEFW defect triage|Cutover|HC|MEDIUM|2|4\n"
        f"  - Transition to BAU / handover to run team|Cutover|HC|HIGH|2|4\n\n"
        f"TECHNICAL WORKSTREAM COVERAGE — generate ALL of the following for each detected workstream:\n"
        f"  Data Migration (if present — generate ALL 5):\n"
        f"    1. Execute transactional data load in Production\n"
        f"    2. Validate data completeness and integrity in Production\n"
        f"    3. End-user data confirmation and sign-off\n"
        f"    4. Formal data migration sign-off (business and technical)\n"
        f"    5. Post go-live data monitoring and error correction\n"
        f"  Security / Authorisation (if present — generate ALL 7):\n"
        f"    1. Establish BTP-IAS trust for Production and create IAS/BTP groups and role collections\n"
        f"    2. Transport ALL IAM artefacts (roles, catalogs, spaces, pages) to Production as a SINGLE consolidated transport task\n"
        f"    3. Provision Production access for functional consultants supporting hypercare\n"
        f"    4. Confirm MFA and SSO are functioning correctly in Production\n"
        f"    5. Confirm security logging and cloud monitoring are active in Production\n"
        f"    6. Confirm break-glass emergency administrator access is available and tested before go-live\n"
        f"    7. Security hypercare monitoring (post go-live)\n"
        f"  SIT Management / Integration (if present — generate ALL 5):\n"
        f"    1. Execute final interface and integration smoke tests in Production\n"
        f"    2. Validate certificates and trust configurations in Production\n"
        f"    3. Confirm ALM and monitoring tools are active\n"
        f"    4. SIT sign-off for go-live readiness\n"
        f"    5. Integration hypercare flow monitoring (post go-live)\n"
        f"  Do not skip any of the numbered tasks above — each is a mandatory go-live execution step.\n\n"
        f"{area_block}"
        f"HYPERCARE COVERAGE — for EACH business workstream generate 3 to 5 SEPARATE HC tasks,\n"
        f"  each naming the specific activity monitored. Emit them as distinct TASK lines:\n"
        f"    1. Daily monitoring of that workstream's failed or erroring transactions\n"
        f"    2. Defect triage and resolution for that workstream\n"
        f"    3. Reconciliation of that workstream's key balances or open backlogs\n"
        f"    4. End-user support and issue resolution for that workstream\n"
        f"  A single combined 'Hypercare support — <workstream>' line is not acceptable output.\n\n"
        f"ROLLBACK / CONTINGENCY COVERAGE — generate ALL of the following:\n"
        f"    1. For EACH business workstream, one rollback task stating exactly what is\n"
        f"       reverted if that workstream's load or migration fails in Production.\n"
        f"    2. One go/no-go abort task naming who holds authority to abort go-live.\n"
        f"    3. One fallback task for continuing on the legacy system if go-live is\n"
        f"       aborted after the legacy freeze.\n"
        f"    4. One point-of-no-return task marking the last moment rollback is possible.\n"
        f"  Assign each rollback task to the workstream it protects, phase CUT.\n\n"
        f"WORKSTREAM NAMING AND SIGN-OFF:\n"
        f"    1. Each task's workstream must name exactly ONE business function. Where the\n"
        f"       L4 supplies a combined label joining several functions with '/', emit a\n"
        f"       SEPARATE task per function rather than one combined task.\n"
        f"    2. Every sign-off task must name what is signed off and what evidence is\n"
        f"       produced (system report, reconciliation output, approval record).\n"
        f"       A bare '<workstream> sign-off' is not executable.\n\n"
        f"Output ONLY the TASK lines — no headers, no prose, no explanation.\n"
    )

    # Area coverage blocks push output past 140 tasks; a measured run reached
    # 248s, which left too little headroom under the previous 300s ceiling.
    text, err, meta = call_claude(prompt, timeout=420, model=_HAIKU_MODEL)
    _L("generate_claude_raw", chars=len(text or ""), first_300=(text or "")[:300], err=err)
    if not text:
        raise HTTPException(status_code=503, detail=err or "Claude did not respond")

    # Parse TASK lines — accept both "TASK|name|..." and bare "name|workstream|..." formats
    _VALID_PHASES = {"PRE", "CUT", "HC"}
    tasks = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Strip optional TASK| prefix (Haiku sometimes omits it)
        if line.upper().startswith("TASK|"):
            line = line[5:]
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 5:
            continue
        # Without prefix: fields are name|ws|phase|priority|wave[|duration]
        name, ws, phase, priority = parts[0], parts[1], parts[2], parts[3]
        # Validate phase field to reject non-task lines that happen to have pipes
        if phase.upper() not in _VALID_PHASES:
            continue
        wave_raw = parts[4] if len(parts) > 4 else ""
        duration_raw = parts[5] if len(parts) > 5 else ""
        phase = phase.upper()
        if phase not in ("PRE","CUT","HC"):
            phase = "CUT"
        priority = priority.upper()
        if priority not in ("HIGH","MEDIUM"):
            priority = "MEDIUM" if "MEDIUM" in priority else "HIGH"
        try:
            wave = int(wave_raw)
        except Exception:
            wave = {"PRE":0,"CUT":1,"HC":2}.get(phase, 1)
        wave = max(0, min(2, wave))
        try:
            duration_h = max(1, int(float(duration_raw)))
        except Exception:
            # Fall back on what the activity actually is, not just its phase.
            _r = _activity_rank(name)
            duration_h = {1: 2, 2: 4, 3: 1, 4: 8, 5: 2, 6: 2, 7: 1, 8: 40}.get(_r, 4)
            if phase == "HC":
                duration_h = 40 if _r == 8 else max(duration_h, 4)
        if not name:
            continue
        # This tool targets SAP S/4HANA Public Cloud only. There is no TMS/RFC
        # or backend-catalog layer there, and reviewers flagged every such task.
        if _ONPREM_RE.search(name):
            continue
        # Server-side safety: drop PRE tasks that are Realize-phase build activities.
        # Prompt rules alone are insufficient for Haiku — filter algorithmically.
        _PRE_BUILD_RE = _re.compile(r'^\s*(develop|build\b|design\b|configure\b|set\s+up\b)', _re.I)
        if phase == "PRE" and _PRE_BUILD_RE.match(name):
            continue
        tasks.append({
            "task": name, "workstream": ws or "Cutover",
            "phase": phase, "priority": priority, "wave": wave,
            "durationH": duration_h,
            "assessment": "keep", "assessmentReason": "AI-generated from L4"
        })

    # ── Algorithmic dedup only: collapse duplicate transport/smoke tasks for the same RICEFW item ──
    # Claude may generate one per sprint-doc row (FSD prep, FSD review) — keep first occurrence only.
    _TRANSP_RE = _re.compile(r'^transport\s+(.+?)\s+to\s+prod(?:uction)?\s*$', _re.I)
    _SMOKE_RE  = _re.compile(r'^smoke\s+test\s*[—\-–]\s*(.+?)\s+in\s+prod(?:uction)?\s*$', _re.I)

    def _ricefw_key(name: str) -> str:
        k = name.lower().strip()
        # Strip build/TSD/FSD doc suffixes (mirrors _STRIP_SFXS in detection)
        k = _re.sub(
            r'\s*[-–]\s*(build(\s*[&/]\s*(unit\s*test|ut|tut))?'
            r'|unit\s*test|ut\b|tut'
            r'|tsd(\s+(creation|review(\s*[&/]\s*(approval|sign[\s-]*off)?)?))?'
            r'|fsd(\s+(preparation|review(\s*[&/]\s*(approval|sign[\s-]*off)?)?))?'
            r'|final(\s+version)?|prep(aration)?'
            r'|sprint\s*\d+(\s+(build|review|retro|planning|prep))?'
            r'|review(\s*[&/]\s*(approval|sign[\s-]*off))?'
            r'|config(uration)?)\s*.*$', '', k)
        # Strip navigational qualifiers and WIP markers
        k = _re.sub(r'\s+(through\s+an?\s*(request|navigation(\s+from\s+\S+)?)|via\s+\w+)\s*.*$', '', k)
        # Strip trailing parentheticals
        k = _re.sub(r'\s*\([^)]*\)\s*$', '', k)
        return k.strip()

    seen_t: set = set()
    seen_s: set = set()
    deduped: list = []
    for t in tasks:
        nm = t["task"]
        tm = _TRANSP_RE.match(nm)
        sm = _SMOKE_RE.match(nm)
        if tm:
            key = _ricefw_key(tm.group(1))
            if key in seen_t:
                continue
            seen_t.add(key)
        elif sm:
            key = _ricefw_key(sm.group(1))
            if key in seen_s:
                continue
            seen_s.add(key)
        deduped.append(t)
    tasks = deduped

    # Server-side guarantee: every detected RICEFW item must have exactly one transport + one smoke test.
    # Haiku sometimes skips items — this fills the gap algorithmically, no Claude call needed.
    covered_t: set = set()
    covered_s: set = set()
    for t in tasks:
        nm = t["task"]
        tm2 = _TRANSP_RE.match(nm)
        sm2 = _SMOKE_RE.match(nm)
        if tm2:
            covered_t.add(_ricefw_key(tm2.group(1)))
        elif sm2:
            covered_s.add(_ricefw_key(sm2.group(1)))

    for item in ricefw_items:
        k = _ricefw_key(item)
        if k not in covered_t:
            tasks.append({"task": f"Transport {item} to Production", "workstream": _RICEFW_WS,
                          "phase": "CUT", "priority": "HIGH", "wave": 1, "durationH": 1,
                          "assessment": "keep", "assessmentReason": "AI-generated from L4"})
        if k not in covered_s:
            tasks.append({"task": f"Smoke test — {item} in Production", "workstream": _RICEFW_WS,
                          "phase": "CUT", "priority": "HIGH", "wave": 1, "durationH": 1,
                          "assessment": "keep", "assessmentReason": "AI-generated from L4"})

    # ── Repair workstream miscategorisation ────────────────────────────────
    # Reviewers flagged stream-specific work sitting under "Cutover". The prompt
    # rule above handles most of it, but Haiku defaults to Cutover when unsure,
    # so the two unambiguous cases are corrected deterministically. Only tasks
    # currently labelled Cutover are touched — a correct specific assignment is
    # never overridden.
    _DEV_WS_RE = _re.compile(
        r"^transport\b.*\bto production\b|^smoke test\b"
        r"|ricefw.{0,24}(defect|triage|monitor)"
        r"|system performance monitoring|interface.{0,20}monitoring", _re.I)
    # Narrow on purpose: must not steal business reconciliations such as
    # "Reconcile AR open items", which belong to Finance.
    _DM_WS_RE = _re.compile(
        r"post.?conversion\s+validation|post.?load\s+validation"
        r"|data (conversion|load).{0,20}validation", _re.I)
    _SEC_WS_RE = _re.compile(
        r"user creation|access provisioning|provision.{0,20}(user|access)"
        r"|user unlock|unlock users|role assignment|business role.{0,20}assign", _re.I)
    _reclass = 0
    for _t in tasks:
        if (_t.get("workstream") or "") != "Cutover":
            continue
        _nm = _t["task"]
        if _DEV_WS_RE.search(_nm):
            _t["workstream"] = _RICEFW_WS
            _reclass += 1
        elif _SEC_WS_RE.search(_nm):
            _t["workstream"] = "Security"
            _reclass += 1
        elif _DM_WS_RE.search(_nm):
            _t["workstream"] = "Data Migration"
            _reclass += 1
    _L("generate_reclassified", moved_out_of_cutover=_reclass)

    # ── Execution sequence and dependencies ─────────────────────────────────
    # Reviewers asked for tasks in execution order with explicit dependencies.
    # Order is (phase, activity rank, original position); predecessors chain
    # consecutive tasks within a workstream, and the first CUT task of every
    # workstream hangs off the legacy freeze when the plan has one.
    _PH_ORD = {"PRE": 0, "CUT": 1, "HC": 2}
    for _i, _t in enumerate(tasks):
        _t["_rank"] = _activity_rank(_t["task"])
        _t["_ord"] = _i
    tasks.sort(key=lambda t: (_PH_ORD.get(t["phase"], 1), t["_rank"], t["_ord"]))

    _freeze_idx = next((i for i, t in enumerate(tasks)
                        if t["phase"] == "CUT" and t["_rank"] == 1), None)
    _last_in_ws: dict = {}
    for _i, _t in enumerate(tasks):
        _ws = _t.get("workstream") or "Cutover"
        _prev = _last_in_ws.get(_ws)
        if _prev is None and _t["phase"] == "CUT" and _freeze_idx is not None and _i != _freeze_idx:
            _prev = _freeze_idx
        _t["predIdx"] = _prev
        _last_in_ws[_ws] = _i
        _t.pop("_rank", None)
        _t.pop("_ord", None)
    # ── Fit the cutover window ──────────────────────────────────────────────
    # The prompt states the per-workstream budget but Haiku overshoots on the
    # busiest areas. Trim proportionally where the overrun is modest (estimates
    # carry that much noise anyway); leave a large overrun alone and report it,
    # because silently compressing 3x of work would hide a real planning problem.
    _adjusted = 0
    _still_over = []
    if _win_h:
        _by_ws: dict = {}
        for _t in tasks:
            if _t["phase"] == "CUT":
                _by_ws.setdefault(_t.get("workstream") or "Cutover", []).append(_t)
        for _ws_name, _items in _by_ws.items():
            _tot = sum(_t.get("durationH") or 0 for _t in _items)
            if _tot <= _win_h or _tot <= 0:
                continue
            if _tot > _win_h * 1.25:
                _still_over.append("%s:%dh" % (_ws_name, _tot))
                continue
            _scale = _win_h / float(_tot)
            for _t in sorted(_items, key=lambda x: -(x.get("durationH") or 0)):
                _new = max(1, int(round((_t.get("durationH") or 0) * _scale)))
                if _new != _t.get("durationH"):
                    _t["durationH"] = _new
                    _t["durationAdjusted"] = True
                    _adjusted += 1
            _after = sum(_t.get("durationH") or 0 for _t in _items)
            if _after > _win_h:
                _still_over.append("%s:%dh" % (_ws_name, _after))
    _L("generate_window_fit", window_h=_win_h or None, adjusted=_adjusted,
       still_over=", ".join(_still_over) or "none")

    # Longest dependency chain = elapsed time, because independent workstreams
    # run concurrently. Total effort overstates it badly (169h of effort across
    # 11 parallel workstreams is nowhere near 169h elapsed).
    _finish = [0.0] * len(tasks)
    for _i, _t in enumerate(tasks):
        _pi = _t.get("predIdx")
        _base = _finish[_pi] if (_pi is not None and 0 <= _pi < _i) else 0.0
        _finish[_i] = _base + float(_t.get("durationH") or 0)
    _cut_idx = [i for i, t in enumerate(tasks) if t["phase"] == "CUT"]
    _critical_h = int(round(max((_finish[i] for i in _cut_idx), default=0)))
    _cut_effort = int(sum(tasks[i].get("durationH") or 0 for i in _cut_idx))
    _fits = (not _win_h) or (_critical_h <= _win_h)
    meta["criticalPathH"] = _critical_h
    meta["cutEffortH"] = _cut_effort
    meta["cutoverWindowH"] = _win_h or None
    meta["fitsWindow"] = _fits
    meta["durationsAdjusted"] = _adjusted
    meta["workstreamsOverWindow"] = _still_over
    _L("generate_sequenced", tasks=len(tasks),
       with_predecessor=sum(1 for t in tasks if t.get("predIdx") is not None),
       critical_path_h=_critical_h, cut_effort_h=_cut_effort,
       window_h=_win_h or None, fits_window=_fits)

    return {"tasks": tasks, "meta": meta, "ricefw_count": len(ricefw_items), "bws": bws}


class EnrichRequest(BaseModel):
    project_name: str = ""
    modules: list = []
    industry: str = ""
    task_summary: str = ""
    existing_tasks: list = []   # [{id, task, workstream, phase}]
    extra: str = ""
    include_missing: bool = True  # only True on first batch to avoid dup suggestions
    locked_assessments: dict = {}  # {task_id: "keep"|"remove"|"review"} — bypass Claude
    l4_context: list = []         # non-Deploy tasks from full L4 (for RICEFW detection)

# ── Pre-filter: deterministic non-cutover task detection ─────────────────────
# Tasks whose primary verb is clearly implementation/build work are auto-removed
# without calling Claude, cutting token load significantly on large plans.
_NON_CUTOVER_RE = _re.compile(
    r"(?i)^\s*(?:the\s+|a\s+)?"
    r"(?:develop(?:ing|ment)?|design(?:ing)?|build(?:ing)?|create\s+(?:a\s+)?(?:document|spec|plan|template)|"
    r"conduct\s+(?:a\s+)?(?:workshop|training|session|meeting|review\s+session)|"
    r"deliver\s+(?:training|workshop)|"
    r"facilitate\s+(?:a\s+)?(?:workshop|session)|"
    r"run\s+(?:a\s+)?(?:workshop|training|sprint)|"
    r"prepare\s+(?:training|documentation|materials|presentations?)|"
    r"draft\s+|write\s+(?:a\s+)?(?:document|report|spec|procedure)|"
    r"develop\s+and\s+test)"
    r"\b"
)
# Safe-list: tasks that ARE cutover activities even if they start with a build-like verb
_CUTOVER_SAFE_RE = _re.compile(
    r"(?i)\b(?:verify|validate|confirm|check|test|activate|execute|"
    r"freeze|lock|restrict|cutover|migrate|convert|sign.?off|"
    r"go.?(?:live|no.?go)|parallel\s+run|reconcil|monitor|handover|"
    r"restrict\s+access|revoke|disable|enable\s+in\s+prod|"
    r"produc(?:tion|t)|prod\b|in\s+prod)"
)

def _is_auto_remove(task_text: str) -> str | None:
    """Return a short reason if task is deterministically a non-cutover activity, else None."""
    t = (task_text or "").strip()
    if _NON_CUTOVER_RE.match(t) and not _CUTOVER_SAFE_RE.search(t):
        return "Build/project task, not cutover"
    return None


@app.post("/api/enrich")
def enrich_plan(req: EnrichRequest):
    """Task-level review — pre-filters obvious non-cutover tasks, then calls Claude
    only on the ambiguous remainder to stay within token/time limits."""
    run_id = str(uuid.uuid4())[:8]
    t0 = time.monotonic()
    all_tasks = req.existing_tasks or []
    modules_str = ", ".join(req.modules) if req.modules else "Not specified"
    industry_str = (req.industry or "").strip()
    valid_ids = {t.get("id", "") for t in all_tasks}

    def _is_gate(task_id: str) -> bool:
        """GATE-xx rows are always KEEP — they replace removed workstream blocks."""
        return bool(_re.match(r"^GATE-\d+$", str(task_id)))

    auto_assessments = []   # pre-determined assessments (gate or pre-filtered)
    claude_tasks = []       # tasks that need Claude's nuanced judgment
    for t in all_tasks:
        tid = str(t.get("id", "")).strip()
        if _is_gate(tid):
            auto_assessments.append({"id": tid, "verdict": "KEEP", "note": "Readiness gate — always keep"})
        else:
            reason = _is_auto_remove(t.get("task", ""))
            if reason:
                auto_assessments.append({"id": t["id"], "verdict": "REMOVE", "note": reason})
            else:
                claude_tasks.append(t)

    _L("enrich_prefilter", run_id=run_id, total=len(all_tasks),
       auto_removed=len(auto_assessments), sent_to_claude=len(claude_tasks))

    # ── Pass 2: brain context for Claude — three targeted queries ───────────────
    # Smaller chunks (200 chars) and fewer results (4/3) vs before to stay lean.
    # Q1 — genuine cutover execution examples
    # Q2 — finance/legacy close tasks (FICO gap detection)
    # Q3 — interface/workflow verification (RW-/IF- precision)

    client_types = ("contributed_plan", "xlsx", "pptx")

    def _brain_query(conn, has_industry, fts_q, limit=5):
        """Run one FTS5 query, return ranked rows (client plans first, SAP ref second)."""
        # Extract meaningful keywords and quote each for exact FTS5 token match
        words = _re.findall(r'\b[a-zA-Z]\w*\b', fts_q.lower())
        keywords = [w for w in words if w not in _STOP and len(w) > 2][:12]
        if not keywords:
            return []
        fts = " OR ".join(f'"{w}"' for w in keywords)
        try:
            if has_industry and industry_str:
                rows = conn.execute(
                    """SELECT c.heading, c.text, s.source_type, s.industry
                       FROM chunks c
                       JOIN sources s ON c.source_id = s.id
                       JOIN chunks_fts ON c.id = chunks_fts.rowid
                       WHERE chunks_fts MATCH ?
                         AND (s.industry IS NULL OR s.industry='' OR LOWER(s.industry)=LOWER(?))
                       ORDER BY chunks_fts.rank LIMIT ?""",
                    (fts, industry_str, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT c.heading, c.text, s.source_type, s.industry
                       FROM chunks c
                       JOIN sources s ON c.source_id = s.id
                       JOIN chunks_fts ON c.id = chunks_fts.rowid
                       WHERE chunks_fts MATCH ?
                       ORDER BY chunks_fts.rank LIMIT ?""",
                    (fts, limit)
                ).fetchall()
        except Exception as _fts_err:
            nonlocal brain_error
            brain_error = f"FTS query failed ({fts[:60]!r}): {_fts_err}"
            return []
        def _rank(r):
            ind = (r["industry"] or "").lower()
            is_client = r["source_type"] in client_types
            if is_client and industry_str and ind == industry_str.lower():
                return 0
            if is_client:
                return 1
            return 2
        return sorted(rows, key=_rank)

    def _fmt_rows(rows, tag_override=None):
        out = []
        for row in rows:
            h = (row["heading"] or "").strip()
            ind = (row["industry"] or "").strip()
            if tag_override:
                tag = tag_override
            elif row["source_type"] in client_types:
                tag = f"[CLIENT PLAN{(' - ' + ind) if ind else ''}] "
            else:
                tag = "[SAP REF] "
            out.append(f"{tag}{h + ': ' if h else ''}{row['text'].strip()[:350]}")
        return out

    ctx_cutover_activities = []   # Q1: genuine cutover execution examples
    ctx_finance_close = []        # Q2: FICO legacy close tasks
    ctx_ricefw_verify = []        # Q3: interface/workflow verification at go-live
    ctx_module_scope = []         # Q4: module-specific scope
    ctx_security_dm = []          # Q5: security / data migration
    brain_error = None

    try:
        with get_db() as conn:
            has_industry = "industry" in [r[1] for r in conn.execute("PRAGMA table_info(sources)").fetchall()]

            # Q1 — genuine cutover execution examples (boosted limit so client plans surface)
            rows1 = _brain_query(conn, has_industry,
                f"cutover execute verify confirm freeze lock migrate validate sign-off {modules_str}", limit=6)
            ctx_cutover_activities = _fmt_rows(rows1)

            # Q2 — FICO/Finance legacy close tasks
            rows2 = _brain_query(conn, has_industry,
                "legacy close period finance trial balance GR IR material ledger posting close books", limit=4)
            ctx_finance_close = _fmt_rows(rows2)

            # Q3 — Interface/workflow cutover verification (not develop/build)
            rows3 = _brain_query(conn, has_industry,
                "interface workflow form approval verify activate production test cutover", limit=4)
            ctx_ricefw_verify = _fmt_rows(rows3)

            # Q4 — module-specific scope catalog entries for the project's in-scope workstreams
            mod_query = f"{modules_str} cutover deploy activate production mandatory checklist tasks"
            rows4 = _brain_query(conn, has_industry, mod_query, limit=6)
            ctx_module_scope = _fmt_rows(rows4)

            # Q5 — security, authorisation, data migration — most commonly missed tasks
            rows5 = _brain_query(conn, has_industry,
                "security authorization user access role production unlock lock data migration load validate reconcile sign-off", limit=5)
            ctx_security_dm = _fmt_rows(rows5)

    except Exception as e:
        brain_error = str(e)
        _LE("enrich_brain_error", run_id=run_id, error=brain_error)

    # Detect whether finance modules are in scope (drives close-task ADD instructions)
    fi_in_scope = any(m.lower() in ("fi", "co", "fico", "finance", "controlling", "financial accounting")
                      for m in (req.modules or []))

    # Build structured context sections — each labelled so Claude knows what they represent
    def _section(label, chunks):
        if not chunks:
            return ""
        return f"=== {label} ===\n" + "\n".join(chunks) + "\n"

    brain_context = (
        _section("WHAT GENUINE CUTOVER TASKS LOOK LIKE (execute / verify / freeze / migrate)", ctx_cutover_activities) +
        _section("MODULE-SPECIFIC CUTOVER TASKS FOR IN-SCOPE WORKSTREAMS", ctx_module_scope) +
        _section("SECURITY, AUTHORISATION & DATA MIGRATION CUTOVER TASKS", ctx_security_dm) +
        _section("FINANCE / LEGACY CLOSE TASKS FROM REFERENCE PLANS", ctx_finance_close) +
        _section("INTERFACE & WORKFLOW CUTOVER VERIFICATION EXAMPLES", ctx_ricefw_verify)
    ).strip()

    brain_chunk_total = len(ctx_cutover_activities) + len(ctx_finance_close) + len(ctx_ricefw_verify) + len(ctx_module_scope) + len(ctx_security_dm)
    _L("enrich_brain_ctx", run_id=run_id,
       cutover_chunks=len(ctx_cutover_activities), finance_chunks=len(ctx_finance_close),
       ricefw_chunks=len(ctx_ricefw_verify), module_chunks=len(ctx_module_scope),
       security_chunks=len(ctx_security_dm), total=brain_chunk_total)

    # ── Claude only sees the non-pre-filtered tasks ──────────────────────────────
    task_lines = "\n".join(
        f"{t.get('id','')}: {t.get('task','')[:80]} [{t.get('workstream','')}] ({t.get('phase','')}) pri={t.get('priority','MEDIUM')} wave={t.get('wave','?')}"
        for t in claude_tasks
    )

    existing_workstreams = sorted({str(t.get("workstream", "")).strip() for t in all_tasks if t.get("workstream", "").strip()})
    ws_list_str = ", ".join(f'"{w}"' for w in existing_workstreams) if existing_workstreams else '"Cutover"'

    # Build RICEFW context from non-Deploy L4 tasks.
    # Clean item names by stripping build suffixes and TSD prefixes, then deduplicate.
    ricefw_items = []
    if req.l4_context:
        _BUILD_WS_RE  = _re.compile(r'develop|build|ricefw|extension|technical|custom|config', _re.I)
        _SKIP_TASK_RE = _re.compile(
            r'^\s*(sprint\s+(review|retro)|daily\s+stand|review\s+daily|'
            r'tsd\s+(creation|review|review\s+&|review\s+and)|'
            r'tsd\s+review|status\s+update|participate\s+in|review\s+daily\s+status)',
            _re.I
        )
        # Strip common build/TSD suffixes to get a clean item name
        _STRIP_SUFFIX = _re.compile(
            r'\s*[-–]\s*(build\s*(&|and)\s*ut|build\s*(&|and)\s*tut|build\s*(&|and)\s*unit\s*test|'
            r'build|unit\s*test|ut|tsd\s*creation|tsd\s*review|tsd)\s*.*$',
            _re.I
        )
        _STRIP_PREFIX = _re.compile(
            r'^\s*(tsd\s+(creation|review)\s*[-–]\s*|build\s*(&|and)\s*(unit\s*test|ut)\s*[-–]\s*)',
            _re.I
        )
        seen_items: set = set()
        for t in req.l4_context:
            if not _BUILD_WS_RE.search(t.get("workstream", "")):
                continue
            # Skip Prepare/Explore phase rows — they produce enablement items, not real transports
            phase_ctx = (t.get("phase") or "").lower()
            if _re.search(r'\bprepare\b|\bexplore\b', phase_ctx):
                continue
            raw = t.get("task", "").strip()
            if not raw or _SKIP_TASK_RE.match(raw):
                continue
            clean = _STRIP_PREFIX.sub("", raw)
            clean = _STRIP_SUFFIX.sub("", clean).strip(" -–")
            clean = _re.sub(r'\s+(through\s+an?\s+(request|navigation)|via\s+\w+|\bwip\b)\s*.*$', '', clean, flags=_re.I).strip(" -–/")
            if not clean or len(clean) < 5:
                continue
            key = clean.lower()[:70]
            if key not in seen_items:
                seen_items.add(key)
                ricefw_items.append(clean)
        ricefw_items = ricefw_items[:15]  # cap at 15 items

    ricefw_add_instr = ""
    if ricefw_items and req.include_missing:
        numbered = "\n".join(f"  {i+1}. {name}" for i, name in enumerate(ricefw_items))
        ricefw_add_instr = (
            f"\nRICEFW / CUSTOM DEVELOPMENTS IN SCOPE (from L4 Realize phase — {len(ricefw_items)} items):\n"
            f"{numbered}\n"
            "MANDATORY: For EACH numbered item above, output EXACTLY TWO ADD lines — one transport and one smoke test.\n"
            "Use the EXACT item name. Do NOT combine items into a single generic task.\n"
            "  ADD|Transport <item name> to Production|Cutover|CUT|HIGH|1|Must transport before go-live\n"
            "  ADD|Smoke test — <item name> in Production|Cutover|CUT|HIGH|1|Verify custom code works in prod\n"
        )

    # Derive workstream list for sign-off / freeze gap-check
    ws_for_gaps = [w for w in existing_workstreams if w.lower() not in ("cutover", "hypercare", "technical architecture & infrastructure")]

    add_instr = (
        "\nPART 2 — MISSING TASKS (MANDATORY — output ADD lines for every gap below):\n"
        "A. STANDARD CUTOVER GATES — add these if not already in the plan:\n"
        "   - Go/No-Go decision meeting (CUT/W1/HIGH)\n"
        "   - Legacy system posting period lock / freeze (CUT/W1/HIGH)\n"
        "   - Unlock users in Production / grant go-live access (CUT/W1/HIGH)\n"
        "   - Post-conversion validation sign-off (CUT/W1/HIGH)\n"
        f"B. WORKSTREAM SIGN-OFFS — for each business workstream add a sign-off task. Workstreams in scope: {', '.join(ws_for_gaps) or 'all'}\n"
        "   Format: ADD|<Workstream> cutover sign-off|Cutover|CUT|HIGH|1|Workstream lead confirms readiness\n"
        f"{ricefw_add_instr}"
        "C. ANY OTHER SAP ACTIVATE GAPS — identify 1–3 additional tasks the plan is missing.\n"
        "Format — one task per line, pipe-separated, exactly 7 fields:\n"
        "ADD|<task name>|<workstream>|<phase CUT/PRE/HC>|<priority HIGH/MEDIUM>|<wave 0/1/2>|<why it is missing>\n"
        f"WORKSTREAM must be one of: {ws_list_str} — do NOT invent new workstream names.\n"
        "Example: ADD|Lock legacy posting periods|Cutover|CUT|HIGH|1|Mandatory before go-live to prevent duplicate postings\n"
        "Priority HIGH = go/no-go gate, freeze/lock, production execution, data sign-off, user unlock/creation, system shutdown/startup.\n"
        "Wave: 0=PRE-cutover prep, 1=CUT execution weekend, 2=HC post go-live.\n"
        if req.include_missing else ""
    )

    fi_add_instr = (
        "- FINANCE/LEGACY CLOSE gap-check (FI/CO in scope): verify the plan has tasks for: last document "
        "postings, close legacy books, trial balance download, GR/IR balance, material ledger review, "
        "posting period lock, compare legacy vs SAP trial balance, year-end close access revocation. "
        "These may have indirect titles — scan by intent not just keywords. Flag missing ones as ADD lines.\n"
        if fi_in_scope and req.include_missing else ""
    )

    industry_line = f"INDUSTRY: {industry_str}\n" if industry_str else ""
    industry_job = (
        f" Flag tasks irrelevant to {industry_str} and suggest industry-specific cutover tasks in ADD lines."
        if industry_str else ""
    )

    # If all tasks were pre-filtered (unlikely) skip Claude entirely
    if not claude_tasks:
        all_assessments = auto_assessments
        flagged = [{"id": a["id"], "reason": a["note"]} for a in auto_assessments if a["verdict"] == "REMOVE"]
        _L("enrich_all_prefiltered", run_id=run_id, auto_removed=len(auto_assessments))
        return {"missing_tasks": [], "flagged_tasks": flagged, "assessments": all_assessments, "meta": {}, "brain_chunks": brain_chunk_total}

    prompt = (
        f"You are an SAP S/4HANA cutover specialist reviewing a cutover plan.\n"
        f"NOTE: Obvious build/develop tasks have already been removed — these are the borderline tasks.\n\n"
        f"SCOPE OF A CUTOVER PLAN: A cutover plan covers ONLY what happens during the go-live execution\n"
        f"window (Deploy phase). It must NOT include planning, strategy, preparation, rehearsal organisation,\n"
        f"training delivery, or project management tasks — even if those tasks are labelled 'cutover'.\n"
        f"Only tasks that a team member physically executes on cutover weekend belong here.\n\n"
        f"MODULES IN SCOPE: {modules_str}\n"
        f"{industry_line}"
        f"APPROACH: {req.extra or 'Big Bang'}\n\n"
        f"REFERENCE — from SAP Activate methodology and past client plans:\n"
        f"{brain_context[:5000]}\n\n"
        f"ASSESSMENT DECISION FRAMEWORK — work through these steps in order for every task:\n\n"
        f"STEP 1 — PHASE CHECK (stop here if applies):\n"
        f"  Phase = HC  → output nothing (always KEEP, no further evaluation)\n"
        f"  Phase = PRE → KEEP and output nothing, UNLESS the task is clearly a build/develop/training-delivery activity\n"
        f"    (i.e. its primary action is: develop, build software/interface/report, create functional or technical spec,\n"
        f"     deliver end-user training, run a workshop, design system architecture, set up landscape/infrastructure)\n"
        f"    If it IS such an activity → continue to Step 3 and flag REMOVE.\n\n"
        f"STEP 2 — STANDARD SAP EXECUTION STEPS (always KEEP — do not flag these):\n"
        f"  Freeze/lock/close legacy: posting period lock, PO/SO close, end-user lockout, system shutdown\n"
        f"  Transport to Production / smoke test in Production — KEEP only when the subject is a technical RICEFW artifact\n"
        f"    (custom report, interface, form, workflow, enhancement, conversion, custom code object).\n"
        f"    If the transport subject is a user-enablement activity, tutorial, workshop, analytics approach,\n"
        f"    product configuration for non-production use, or user-adoption task → go to Step 3 (REMOVE).\n"
        f"  Go/No-Go decision (any phrasing)\n"
        f"  Data migration load, reconciliation, or sign-off\n"
        f"  User unlock / access grant in Production\n"
        f"  System handover to business\n"
        f"  Cutover runbook authoring, review, or sign-off\n"
        f"  Dress rehearsal / cutover simulation\n"
        f"  Post-conversion or post-migration validation\n"
        f"  'Execute [X] Tasks' from any workstream (parallel execution on cutover day — not a summary)\n"
        f"  Security role validation / authorisation check in Production\n"
        f"  GATE rows (id starts with GATE-) — readiness gate inputs, always keep\n"
        f"  'Setup X in Production' or 'Prepare X support structure' in Deploy/HC phase\n"
        f"  SAP CQC readiness checks in Deploy phase\n\n"
        f"STEP 3 — CLEAR NON-CUTOVER (always REMOVE):\n"
        f"  Develop / build / design software, interfaces, reports, or configurations\n"
        f"  Workshop, training session, or user education delivery\n"
        f"  Strategy definition, planning document creation, or project team setup\n"
        f"  SIT/UAT testing rounds that are NOT identified as go-live gates\n"
        f"  Sprint ceremonies: planning, review, retrospective, daily stand-up\n"
        f"  KUT workstream tasks that are NOT about Production access or user role assignment\n"
        f"  Q-Gate prefixed duplicates when an equivalent non-prefixed task already exists\n\n"
        f"STEP 4 — JUDGMENT (task fits neither Step 2 nor Step 3):\n"
        f"  Lean toward KEEP for go-live-adjacent activities in Deploy phase\n"
        f"  Apply rules CONSISTENTLY: if you keep integration/security/RICEFW monitoring in HC, also keep OCM adoption support\n"
        f"  Flag as REVIEW (not REMOVE) when genuinely uncertain\n"
        f"  Duplicates: flag REMOVE only when two tasks have substantially identical names AND the same workstream\n\n"
        f"TASKS ({len(claude_tasks)}):\n{task_lines}\n\n"
        f"YOUR JOB:\n"
        f"1. Flag tasks NOT a genuine go-live execution activity (REMOVE or REVIEW).\n"
        f"2. Flag tasks out of scope for modules listed (REMOVE).\n"
        f"3. Flag true duplicates only — same activity, same workstream (REMOVE).{industry_job}\n\n"
        f"PART 1 — FLAGGED TASKS (output only tasks that fail — skip tasks that pass):\n"
        f"REMOVE|<exact task id>|<3-6 word reason>\n"
        f"REVIEW|<exact task id>|<3-6 word reason>\n"
        f"Part 1 rules: copy task IDs exactly · reasons 3-6 words · no headers · no prose · output nothing for tasks that pass\n"
        f"{add_instr}"
        f"{fi_add_instr}"
    )

    _L("enrich_claude_batch", run_id=run_id, tasks=len(claude_tasks), prompt_chars=len(prompt))
    text, err, meta = call_claude(prompt, timeout=300, model=_HAIKU_MODEL)
    _L("enrich_claude_response", run_id=run_id, response_chars=len(text or ""), ok=bool(text))

    if not text:
        # Return pre-filter results even if Claude fails
        flagged = [{"id": a["id"], "reason": a["note"]} for a in auto_assessments if a["verdict"] == "REMOVE"]
        return {"missing_tasks": [], "flagged_tasks": flagged, "assessments": auto_assessments, "meta": meta,
                "error": err or "Claude did not respond"}

    flagged_tasks, missing_tasks, claude_assessments = [], [], []
    for line in text.splitlines():
        line = line.strip()
        up = line.upper()
        if up.startswith("REMOVE|") or up.startswith("REVIEW|"):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 2 and parts[1] in valid_ids:
                verdict = "REMOVE" if up.startswith("REMOVE|") else "REVIEW"
                note = parts[2] if len(parts) > 2 else ("Not in scope" if verdict == "REMOVE" else "Review scope")
                claude_assessments.append({"id": parts[1], "verdict": verdict, "note": note})
                if verdict == "REMOVE":
                    flagged_tasks.append({"id": parts[1], "reason": note})
        elif line.startswith("ADD|"):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 6:
                # 7-part format: ADD|task|ws|phase|priority|wave|why
                # 6-part format (old): ADD|task|ws|phase|priority|why
                has_wave = len(parts) >= 7 and parts[5].lstrip("-").isdigit()
                if has_wave:
                    wave_val = int(parts[5])
                    reason   = parts[6]
                else:
                    # derive wave from phase when not provided
                    ph = (parts[3] or "PRE").upper()
                    wave_val = 2 if ph == "HC" else (1 if ph == "CUT" else 0)
                    reason   = parts[5]
                _valid_pris = {"HIGH", "MEDIUM", "LOW"}
                pri_raw = (parts[4] or "MEDIUM").upper().strip()
                # Map non-standard values Claude sometimes returns
                pri = pri_raw if pri_raw in _valid_pris else (
                    "HIGH" if pri_raw in ("CRITICAL", "URGENT", "P0", "P1", "VERY HIGH") else "MEDIUM"
                )
                task_text = (parts[1] or "").strip()
                # Reject AI-suggested tasks that are clearly planning/kickoff, not execution
                _ADD_REJECT = _re.compile(r"(?i)^\s*(?:kick.?off|team\s+meeting|planning\s+session|project\s+meeting|status\s+update|lessons\s+learned)")
                if _ADD_REJECT.match(task_text):
                    continue
                missing_tasks.append({
                    "task": task_text, "workstream": parts[2], "phase": parts[3] or "PRE",
                    "priority": pri, "wave": wave_val,
                    "reason": reason, "owner": "",
                })

    # Merge: pre-filter auto-removes + Claude's nuanced assessments
    all_assessments = auto_assessments + claude_assessments
    all_flagged = [{"id": a["id"], "reason": a["note"]} for a in auto_assessments if a["verdict"] == "REMOVE"] + flagged_tasks

    _L("enrich_done", run_id=run_id, auto_removed=len(auto_assessments),
       claude_assessed=len(claude_assessments), missing=len(missing_tasks),
       in_tok=meta.get("input_tokens", 0), out_tok=meta.get("output_tokens", 0),
       elapsed_s=round(time.monotonic() - t0, 1))
    return {"missing_tasks": missing_tasks, "flagged_tasks": all_flagged,
            "assessments": all_assessments, "meta": meta,
            "brain_chunks": brain_chunk_total,
            "brain_error": brain_error}


# ── Contribute finalized plan to brain ─────────────────────────────────────────

class ContributeRequest(BaseModel):
    label: str = ""          # e.g. "S4HANA Greenfield – APAC – 2025"
    modules: list = []
    approach: str = ""
    size: str = ""
    tasks: list = []         # scrubbed tasks [{task, workstream, phase, priority, status, durationH, notes}]

@app.post("/api/contribute-plan")
def contribute_plan(req: ContributeRequest):
    """Insert a scrubbed cutover plan into the brain as searchable chunks."""
    from datetime import datetime

    if not req.tasks:
        return {"ok": False, "error": "No tasks provided"}

    tasks = req.tasks
    label = req.label or "SAP Cutover Plan"
    filename = f"cutover_plan_{_re.sub(r'[^a-z0-9]+', '_', label.lower())}.txt"
    title = f"Contributed Cutover Plan: {label}"

    # Group tasks by workstream → one chunk per workstream (keeps context together for FTS5)
    by_ws: dict = {}
    for t in tasks:
        ws = (t.get("workstream") or "General").strip()
        by_ws.setdefault(ws, []).append(t)

    try:
        with get_db() as conn:
            # Remove any previous contribution with same filename so re-contributing replaces it
            existing = conn.execute("SELECT id FROM sources WHERE filename=?", (filename,)).fetchone()
            if existing:
                conn.execute("DELETE FROM chunks WHERE source_id=?", (existing["id"],))
                conn.execute("DELETE FROM sources WHERE id=?", (existing["id"],))
                conn.commit()

            source_id = conn.execute(
                "INSERT INTO sources (filename, filepath, source_type, title) VALUES (?,?,?,?)",
                (filename, "", "contributed_plan", title)
            ).lastrowid
            conn.commit()

            chunk_idx = 0
            meta_chunk = (
                f"SAP Cutover Plan Reference: {label}\n"
                f"Modules: {', '.join(req.modules) if req.modules else 'Not specified'}\n"
                f"Approach: {req.approach or 'Not specified'} | Size: {req.size or 'Not specified'}\n"
                f"Total tasks: {len(tasks)}\n"
                f"Workstreams: {', '.join(by_ws.keys())}\n"
                f"Phases: {', '.join(sorted({t.get('phase','') for t in tasks if t.get('phase')}))}"
            )
            conn.execute(
                "INSERT INTO chunks (source_id, chunk_idx, heading, text, char_count) VALUES (?,?,?,?,?)",
                (source_id, chunk_idx, "Plan Overview", meta_chunk, len(meta_chunk))
            )
            chunk_idx += 1

            for ws, ws_tasks in by_ws.items():
                lines = [f"Workstream: {ws}"]
                for t in ws_tasks:
                    phase = t.get("phase", "")
                    status = t.get("status", "")
                    dur = t.get("durationH", "")
                    priority = t.get("priority", "")
                    notes = (t.get("notes") or "").strip()
                    line = f"  [{phase}] {t.get('task','')} — {status}, {dur}h, {priority}"
                    if notes:
                        line += f" | {notes}"
                    lines.append(line)
                chunk_text = "\n".join(lines)
                conn.execute(
                    "INSERT INTO chunks (source_id, chunk_idx, heading, text, char_count) VALUES (?,?,?,?,?)",
                    (source_id, chunk_idx, ws, chunk_text, len(chunk_text))
                )
                chunk_idx += 1

            conn.commit()

        return {"ok": True, "source_id": source_id, "chunks": chunk_idx, "filename": filename}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Knowledge Base file upload (scrub → index → vectorize) ──────────────────────

def _scrub_pii(text: str):
    """Auto-anonymize extracted text before it is indexed/vectorized.
    Redacts the realistic client-identity leak paths: emails, URLs/hostnames (these embed
    company domains), phone numbers, and person names after role labels.
    Conservative on numbers — SAP IDs (GL accounts, transports, material numbers) are preserved.
    Returns (scrubbed_text, num_redactions)."""
    n = 0
    def _sub(pattern, repl, t):
        nonlocal n
        t2, k = _re.subn(pattern, repl, t)
        n += k
        return t2
    text = _sub(r'\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[email]', text)                          # emails
    text = _sub(r'(?i)\b(?:https?://|www\.)\S+', '[url]', text)                                    # URLs (carry client hostnames)
    text = _sub(r'(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?!\d)', '[phone]', text)  # phones
    # Person names after a role label (First Last[ Last]) — where owners/approvers appear in plans.
    # Requires >= 2 capitalised words so single workstream words (e.g. "Lead: Finance") are NOT matched.
    text = _sub(r'(?i)\b(owner|lead|contact|approver|responsible|manager|assignee|prepared by|reviewed by|sign[- ]?off)(\s*[:\-]\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})',
                lambda m: m.group(1) + m.group(2) + '[name]', text)
    return text, n

# Industry keywords recognised in filenames (token -> canonical industry key)
INDUSTRY_KEYWORDS = {
    "utilities": "utilities", "utility": "utilities",
    "consumer": "consumer", "cpg": "consumer", "fmcg": "consumer", "retail": "consumer", "beverage": "consumer", "beverages": "consumer",
    "manufacturing": "manufacturing", "discrete": "manufacturing", "industrial": "manufacturing",
    "lifesciences": "lifesciences", "lifescience": "lifesciences", "pharma": "lifesciences", "pharmaceutical": "lifesciences",
    "publicsector": "publicsector", "public": "publicsector", "government": "publicsector", "govt": "publicsector",
    "oilgas": "oilgas", "oil": "oilgas", "gas": "oilgas", "energy": "oilgas",
    "financial": "financial", "banking": "financial", "bank": "financial", "insurance": "financial", "finserv": "financial",
    "automotive": "automotive", "auto": "automotive",
}
# Known client names -> industry (used to infer industry AND to scrub client references).
# Deliberately empty: client names belong in the "Client name(s) to remove" field on
# the Knowledge Base upload screen, not in source control. Add entries here only for
# a local deployment, never in a committed file.
CLIENT_INDUSTRY: dict = {}
# Doc-type / filler tokens that are NOT client names (so they aren't scrubbed)
DOC_STOPWORDS = {
    "cutover", "plan", "strategy", "template", "runbook", "checklist", "reference", "ref",
    "copy", "of", "for", "the", "excel", "doc", "document", "final", "draft", "v1", "v2", "v3",
    "sap", "s4hana", "s4h", "s", "4hana", "activate", "how", "to", "approach", "remote", "fp",
    "data", "migration", "production", "system", "setup", "guide", "and", "documentation", "xlsx", "pptx", "pdf",
}

def _detect_industry_and_clients(filename: str):
    """From a filename, infer the industry and any client-name tokens to scrub.
    Returns (industry_key, [client_tokens]).

    Safe rule: KNOWN client names are always scrubbed. Unknown descriptive tokens are
    treated as client names ONLY when the file follows the convention (i.e. it also
    contains a recognised industry keyword) — otherwise legitimate words in arbitrary
    SAP reference filenames would be wrongly redacted."""
    base = filename.rsplit(".", 1)[0].lower()
    tokens = [t for t in _re.split(r'[\s_\-.()]+', base) if t]
    industry = ""
    known_clients = []
    unknown_tokens = []
    for tok in tokens:
        if tok in CLIENT_INDUSTRY:
            known_clients.append(tok)
            industry = industry or CLIENT_INDUSTRY[tok]
        elif tok in INDUSTRY_KEYWORDS:
            industry = industry or INDUSTRY_KEYWORDS[tok]
        elif tok not in DOC_STOPWORDS and not tok.isdigit() and len(tok) > 2:
            unknown_tokens.append(tok)
    clients = list(known_clients)
    if industry and unknown_tokens:   # follows convention → leftover tokens are likely the client
        clients += unknown_tokens
    return industry, clients

def _scrub_clients(text: str, clients, min_len: int = 4):
    """Replace client-name tokens with [client]. Substring, case-insensitive — catches the
    name even when embedded in URLs/emails/compounds (e.g. 'acmesscTest', 'ess_acme').
    Only tokens of length >= 4 are scrubbed as substrings, to avoid over-matching. Returns (text, count)."""
    n = 0
    for c in clients:
        if not c or len(c) < min_len:
            continue
        text, k = _re.subn(r'(?i)' + _re.escape(c), '[client]', text)
        n += k
    return text, n

def _ensure_industry_column(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(sources)").fetchall()]
    if "industry" not in cols:
        conn.execute("ALTER TABLE sources ADD COLUMN industry TEXT DEFAULT ''")
        conn.commit()

class KbUploadRequest(BaseModel):
    files: list = []       # [{name, ext, base64}]
    industry: str = ""     # user-selected industry for the whole batch ("" = cross-industry)
    scrub: bool = True
    client_names: str = ""  # comma-separated names the uploader wants redacted

# In-memory job registry for background uploads: {job_id: {status, total, done, result, error}}
_kb_jobs = {}

def _process_kb_job(job_id, saved_files, industry_override, scrub, client_names=""):
    """Background worker: extract → scrub → index (FTS5). Updates _kb_jobs[job_id]."""
    import importlib, sys
    sys.path.insert(0, str(Path(__file__).parent))
    import indexer as _ix
    importlib.reload(_ix)
    db  = os.environ.get("BRAIN_DB", str(Path(__file__).parent / "brain.db"))
    extractors = {"pdf": _ix.extract_pdf, "xlsx": _ix.extract_xlsx, "pptx": _ix.extract_pptx, "json": _ix.extract_json, "html": _ix.extract_html}
    job = _kb_jobs[job_id]
    # Names typed by the uploader are authoritative: filename-based detection only
    # fires for a known client or a recognised industry keyword, so a new client
    # would otherwise never be redacted. Allowed down to 2 chars (e.g. "CDI")
    # because an explicit name carries no over-matching risk.
    explicit_clients = [c.strip() for c in (client_names or "").split(",") if c.strip()]
    files_out, total_chunks, total_pii, total_client = [], 0, 0, 0
    try:
        conn = _ix.init_db(db)
        _ensure_industry_column(conn)
        for (fpath, filename, stype) in saved_files:
            detected_ind, clients = _detect_industry_and_clients(filename)
            industry = (industry_override or detected_ind or "").strip().lower()
            # Replace any prior version of this file (same path) so re-upload updates, not duplicates
            old = conn.execute("SELECT id FROM sources WHERE filepath=?", (str(fpath),)).fetchall()
            for (oid,) in old:
                conn.execute("DELETE FROM chunks WHERE source_id=?", (oid,))
                conn.execute("DELETE FROM sources WHERE id=?", (oid,))
            if old:
                conn.commit()
            try:
                segments = extractors[stype](Path(fpath)) or []
            except Exception as e:
                segments = []
                job.setdefault("errors", []).append(f"{filename}: text extraction failed ({e})")
            def _clean_meta(v):
                if not v or not scrub:
                    return v
                v, _ = _scrub_pii(v)
                if clients:
                    v, _ = _scrub_clients(v, clients)
                if explicit_clients:
                    v, _ = _scrub_clients(v, explicit_clients, min_len=2)
                return v

            title = (segments[0].get("heading") if segments else None) or Path(fpath).stem
            title = _clean_meta(title)
            source_id = _ix.insert_source(conn, filename, str(fpath), stype, title)
            conn.execute("UPDATE sources SET industry=? WHERE id=?", (industry, source_id))
            chunk_idx = 0
            for seg in segments:
                txt = seg.get("text", "") or ""
                if scrub:
                    txt, k = _scrub_pii(txt); total_pii += k
                    if clients:
                        txt, ck = _scrub_clients(txt, clients); total_client += ck
                    if explicit_clients:
                        txt, ck = _scrub_clients(txt, explicit_clients, min_len=2)
                        total_client += ck
                head = _clean_meta(seg.get("heading", "") or "")
                chunk_idx += _ix.insert_chunks(conn, source_id, head, txt, chunk_idx)
            conn.commit()
            total_chunks += chunk_idx
            files_out.append({"file": filename, "chunks": chunk_idx, "industry": industry or "cross-industry"})
            job["done"] += 1
            print(f"[kb-job {job_id}] {filename}: {chunk_idx} chunks, industry={industry or 'cross-industry'}")
        conn.close()
        job["status"] = "done"
        job["result"] = {"files": files_out, "chunks": total_chunks, "redactions": total_pii,
                         "client_scrubs": total_client}
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)

@app.post("/api/kb-upload")
def kb_upload(req: KbUploadRequest):
    """Save uploaded files, then process (scrub → index → vectorize) in the background.
    Returns a jobId immediately so the UI never blocks. Poll /api/kb-status/{jobId}."""
    import uuid
    data_path = Path(DATA_DIR)
    files_path = data_path / "files"
    files_path.mkdir(parents=True, exist_ok=True)
    db = os.environ.get("BRAIN_DB", str(Path(__file__).parent / "brain.db"))
    ext_map = {"pdf": "pdf", "xlsx": "xlsx", "xls": "xlsx", "pptx": "pptx", "ppt": "pptx", "json": "json", "html": "html"}

    saved_files, errors = [], []
    for f in (req.files or []):
        name = (f.get("name") or "file").strip()
        ext = (f.get("ext") or "").lower().lstrip(".")
        content = f.get("base64", "")
        if not content:
            continue
        if ext not in ext_map:
            errors.append(f"{name}.{ext}: unsupported type (allowed: pdf, xlsx, pptx, json, html)")
            continue
        filename = f"{name}.{ext}"
        fpath = (files_path / filename).resolve()
        try:
            fpath.write_bytes(base64.b64decode(content))
        except Exception as e:
            errors.append(f"{filename}: could not save ({e})")
            continue
        # Re-uploading the same filename REPLACES the prior version (re-scrubbed + re-indexed)
        saved_files.append((str(fpath), filename, ext_map[ext]))

    if not saved_files:
        return {"ok": False, "error": "No valid files to process", "errors": errors}

    job_id = uuid.uuid4().hex[:12]
    _kb_jobs[job_id] = {"status": "processing", "stage": "indexing", "total": len(saved_files),
                        "done": 0, "result": None, "error": None, "errors": errors}
    threading.Thread(target=_process_kb_job,
                     args=(job_id, saved_files, (req.industry or "").strip(),
                           req.scrub, req.client_names or ""),
                     daemon=True).start()
    return {"ok": True, "jobId": job_id, "queued": len(saved_files), "errors": errors}

@app.get("/api/kb-status/{job_id}")
def kb_status(job_id: str):
    job = _kb_jobs.get(job_id)
    if not job:
        return {"status": "unknown"}
    return job


# ── A2A Agent Card ─────────────────────────────────────────────────────────────

@app.get("/.well-known/agent.json")
def agent_card():
    """A2A-standard agent card — describes this agent's capabilities to orchestrators."""
    return {
        "name": "SAP Cutover Agent",
        "version": "1.0.0",
        "description": "Builds, enriches, and validates SAP S/4HANA cutover plans using project-specific knowledge.",
        "url": "http://localhost:7878",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
        },
        "skills": [
            {
                "id": "enrich",
                "name": "Enrich Cutover Plan",
                "description": "Reviews a list of cutover tasks, flags non-cutover activities, and suggests missing mandatory tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "existing_tasks": {"type": "array"},
                        "modules": {"type": "array", "items": {"type": "string"}},
                        "industry": {"type": "string"},
                        "include_missing": {"type": "boolean"},
                    },
                    "required": ["existing_tasks"],
                },
            },
            {
                "id": "ask",
                "name": "Ask Knowledge Base",
                "description": "Answers questions about SAP cutover methodology using indexed reference plans and SAP Activate materials.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}, "industry": {"type": "string"}},
                    "required": ["query"],
                },
            },
            {
                "id": "index",
                "name": "Index Document",
                "description": "Uploads and indexes a PDF, XLSX, or PPTX document into the knowledge base.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "files": {"type": "array"},
                        "industry": {"type": "string"},
                        "scrub": {"type": "boolean"},
                    },
                    "required": ["files"],
                },
            },
        ],
    }


# ── Serve the frontend static files ────────────────────────────────────────────
# Vanilla HTML/CSS/JS — no Node.js or build step required.
# API routes defined above take precedence over static file serving.
_STATIC = Path(__file__).parent / "static"
_SERVER_VERSION = str(int(time.time()))  # changes on every restart → busts browser cache

@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def _serve_index():
    """Serve index.html with versioned asset URLs so browsers always load fresh JS/CSS."""
    from fastapi.responses import HTMLResponse
    _idx = _STATIC / "index.html"
    html = _idx.read_text(encoding="utf-8")
    # Inject ?v=<timestamp> into all local script/link tags (not vendor .min.js files)
    import re as _re2
    html = _re2.sub(
        r'(src|href)="(/(?:js|css)/(?!vendor/)([^"]+))"',
        lambda m: f'{m.group(1)}="{m.group(2)}?v={_SERVER_VERSION}"',
        html
    )
    return HTMLResponse(content=html, headers={"Cache-Control": "no-store"})

if _STATIC.exists():
    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="app")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7878, reload=False)
