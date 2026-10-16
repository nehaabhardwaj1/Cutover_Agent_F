"""
SAP Local Brain — Indexer
Usage: python indexer.py --dir ./files --db brain.db [--vectors ./brain-vectors]

Walks the --dir folder, extracts text from PDF/XLSX/PPTX/HTML/JSON files,
chunks into ~600-char segments, inserts into SQLite FTS5, and optionally
embeds into ChromaDB for semantic (vector) search.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


# ── Schema ──────────────────────────────────────────────────────────────────────
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  filepath    TEXT,
  source_type TEXT,
  title       TEXT,
  indexed_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  chunk_idx   INTEGER,
  heading     TEXT,
  text        TEXT NOT NULL,
  char_count  INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  heading,
  content=chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, heading)
  VALUES (new.id, new.text, new.heading);
END;

-- Without these, DELETE/UPDATE on chunks leaves stale postings in the
-- external-content FTS index, producing phantom matches and bad ranking.
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading)
  VALUES ('delete', old.id, old.text, old.heading);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, heading)
  VALUES ('delete', old.id, old.text, old.heading);
  INSERT INTO chunks_fts(rowid, text, heading)
  VALUES (new.id, new.text, new.heading);
END;
"""


# ── Chunker ─────────────────────────────────────────────────────────────────────
def chunk_text(text: str, size: int = 600, overlap: int = 100) -> list[str]:
    """Split text into ~size-char segments with overlap, preferring sentence boundaries."""
    if not text or not text.strip():
        return []
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= size:
        return [text]

    # Split on sentence boundaries: ". ", "! ", "? ", "\n"
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text)
    chunks = []
    buf = ""
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        if len(buf) + len(sent) + 1 <= size:
            buf = (buf + " " + sent).strip()
        else:
            if buf:
                chunks.append(buf)
            # Start new buffer with overlap from end of previous
            if len(sent) > size:
                # Long sentence — split by character
                for i in range(0, len(sent), size - overlap):
                    chunks.append(sent[i : i + size])
                buf = sent[max(0, len(sent) - overlap) :]
            else:
                # Carry overlap from previous chunk
                prev_end = buf[-overlap:] if buf else ""
                buf = (prev_end + " " + sent).strip() if prev_end else sent
    if buf:
        chunks.append(buf)
    return [c for c in chunks if len(c.strip()) > 20]


# ── Extractors ─────────────────────────────────────────────────────────────────

def extract_pdf(filepath: Path) -> list[dict]:
    """Extract text per page. Returns list of {heading, text}."""
    try:
        import pdfplumber
    except ImportError:
        print("  [SKIP] pdfplumber not installed — cannot read PDF")
        return []
    segments = []
    try:
        with pdfplumber.open(filepath) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                text = text.strip()
                if text:
                    segments.append({"heading": f"Page {i + 1}", "text": text})
    except Exception as e:
        print(f"  [WARN] PDF read error: {e}")
    return segments


def extract_xlsx(filepath: Path) -> list[dict]:
    """Extract text from each sheet.

    Sheets that look like task tables (a detectable header row plus several data
    rows) emit ONE segment per row, so an individual activity stays retrievable
    instead of being buried in a whole-sheet blob. Anything else keeps the
    previous whole-sheet behaviour.

    Columns whose header names a person, owner or organisation are dropped: real
    client plans carry staff names and customer names that must not enter the
    index.
    """
    try:
        import openpyxl
    except ImportError:
        print("  [SKIP] openpyxl not installed \u2014 cannot read XLSX")
        return []

    # Column headers whose values are people, organisations or free-text chatter.
    # Client plans carry staff names in all of these; none is reusable knowledge.
    drop_re = re.compile(
        r"person|owner|responsible|assign|contact|e-?mail|approver"
        r"|organi[sz]ation|company|client\b|customer\s*name|vendor\s*name"
        r"|full\s*name|backup|changed\s*by|created\s*by|modified\s*by"
        r"|request(er|or)|reviewer|comment|remark|\bnotes?\b", re.I)
    task_re = re.compile(
        r"task|activity|description|step|summary|deliverable|milestone", re.I)
    cat_re = re.compile(
        r"categor|stream|area|team|phase|stage|type|group|module", re.I)

    segments = []
    seen_rows: set[str] = set()
    try:
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            raw = []
            for row in ws.iter_rows(values_only=True):
                cells = [str(c).strip() if c is not None else "" for c in row]
                if any(cells):
                    raw.append(cells)
            if not raw:
                continue

            # Header = the most label-like row among the first few. Rows that name
            # owner/person columns are weighted heavily: on messy sheets the real
            # header sits below a preamble, and missing it would leak those columns.
            hi, hw = 0, 0
            for idx, cells in enumerate(raw[:10]):
                labels = [c for c in cells if c and len(c) <= 60]
                w = len(labels) + 3 * sum(1 for c in labels if drop_re.search(c))
                if w > hw:
                    hi, hw = idx, w
            header = raw[hi] if len([c for c in raw[hi] if c]) >= 3 else []
            body = raw[hi + 1:] if header else raw

            keep = [c for c in range(len(header)) if not drop_re.search(header[c] or "")]

            def _avg_len(col):
                vals = [r[col] for r in body[:60] if col < len(r) and r[col]]
                return (sum(len(v) for v in vals) / len(vals)) if vals else 0.0

            # Prefer a column that is task-like but not category-like, then the
            # one carrying the longest values (real text, not Yes/No flags).
            cands = [c for c in keep
                     if task_re.search(header[c] or "") and not cat_re.search(header[c] or "")]
            if not cands:
                cands = [c for c in keep if task_re.search(header[c] or "")]
            t_col = max(cands, key=_avg_len) if cands else None
            c_col = next((c for c in keep
                          if c != t_col and cat_re.search(header[c] or "")), None)

            if header and t_col is not None and len(body) >= 5:
                for cells in body:
                    task = cells[t_col].strip() if t_col < len(cells) else ""
                    if len(task) < 3:
                        continue
                    cat = (cells[c_col].strip()
                           if c_col is not None and c_col < len(cells) else "")
                    parts = []
                    for c in keep:
                        if c == t_col or c >= len(cells) or not cells[c]:
                            continue
                        lbl = (header[c] or "").strip()
                        parts.append(f"{lbl}: {cells[c]}" if lbl else cells[c])
                    text = task + ((" | " + " | ".join(parts)) if parts else "")
                    key = text.lower().replace(" ", "")[:300]
                    if key in seen_rows:
                        continue
                    seen_rows.add(key)
                    heading = f"{cat} \u2014 {task}" if cat and cat != task else task
                    segments.append({"heading": heading[:160], "text": text})
            elif header and len(body) >= 5:
                # A data table we cannot interpret (pivot, reference list).
                # Dumping it wholesale is how row labels, often people, leak in.
                continue
            else:
                lines = []
                for cells in body:
                    vals = [v for c, v in enumerate(cells)
                            if v and (not header or c in keep)]
                    if not vals:
                        continue
                    line = " | ".join(vals)
                    key = line.lower().replace(" ", "")
                    if key in seen_rows:
                        continue
                    seen_rows.add(key)
                    lines.append(line)
                if lines:
                    segments.append({"heading": sheet_name, "text": "\n".join(lines)})
        wb.close()
    except Exception as e:
        print(f"  [WARN] XLSX read error: {e}")
    return segments


def extract_pptx(filepath: Path) -> list[dict]:
    """Extract text per slide. Returns list of {heading, text}."""
    try:
        from pptx import Presentation
    except ImportError:
        print("  [SKIP] python-pptx not installed — cannot read PPTX")
        return []
    segments = []
    try:
        prs = Presentation(str(filepath))
        for i, slide in enumerate(prs.slides):
            texts = []
            slide_title = ""
            for shape in slide.shapes:
                if not shape.has_text_frame:
                    continue
                for para in shape.text_frame.paragraphs:
                    line = " ".join(run.text for run in para.runs).strip()
                    if line:
                        texts.append(line)
            if texts:
                # First text block is often the title
                slide_title = texts[0] if texts else f"Slide {i + 1}"
                full_text = " ".join(texts)
                segments.append({"heading": slide_title, "text": full_text})
    except Exception as e:
        print(f"  [WARN] PPTX read error: {e}")
    return segments


def extract_html(filepath: Path) -> list[dict]:
    """Extract text from SAP task HTML files exported by the Chrome extension."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        print("  [SKIP] beautifulsoup4 not installed")
        return []
    segments = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            soup = BeautifulSoup(f.read(), "html.parser")
        title = soup.find("h1")
        title_text = title.get_text(strip=True) if title else filepath.stem
        # Extract each section (h2 + following content)
        current_heading = title_text
        current_parts = []
        for tag in soup.find("body").children if soup.find("body") else []:
            if not hasattr(tag, "get_text"):
                continue
            text = tag.get_text(separator=" ", strip=True)
            if not text:
                continue
            if tag.name == "h2":
                if current_parts:
                    segments.append({"heading": current_heading, "text": " ".join(current_parts)})
                current_heading = f"{title_text} — {text}"
                current_parts = []
            else:
                current_parts.append(text)
        if current_parts:
            segments.append({"heading": current_heading, "text": " ".join(current_parts)})
    except Exception as e:
        print(f"  [WARN] HTML read error: {e}")
    return segments


def extract_json(filepath: Path) -> list[dict]:
    """Extract title/description/task fields from brain-manifest and phase JSON files."""
    segments = []
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"  [WARN] JSON read error: {e}")
        return []

    def _text_from(obj, prefix=""):
        """Recursively pull text fields from a JSON object."""
        parts = []
        if isinstance(obj, dict):
            title = obj.get("title") or obj.get("name") or obj.get("task") or ""
            desc = obj.get("description") or obj.get("details") or obj.get("notes") or ""
            if title:
                parts.append(f"{prefix}{title}")
            if desc:
                parts.append(desc)
            for k, v in obj.items():
                if k in ("title", "name", "task", "description", "details", "notes"):
                    continue
                if isinstance(v, (dict, list)):
                    parts.extend(_text_from(v, prefix))
                elif isinstance(v, str) and len(v) > 30:
                    parts.append(v)
        elif isinstance(obj, list):
            for item in obj:
                parts.extend(_text_from(item, prefix))
        return parts

    try:
        from bs4 import BeautifulSoup as _Soup
    except ImportError:
        _Soup = None

    def _clean(s):
        """Strip markup from a string field that is really an HTML document."""
        if (not isinstance(s, str) or len(s) < 100
                or not re.search(r"</[A-Za-z][\w:-]*\s*>", s)):
            return s
        if _Soup is None:
            return re.sub(r"<[^>]+>", " ", s)
        soup = _Soup(s, "html.parser")
        for t in soup(["script", "style"]):
            t.decompose()
        return soup.get_text(separator=" ", strip=True)

    # Catalog/export files shaped as {..., "<key>": [{...}, {...}]} or a bare
    # list of records get ONE segment per record, so each record's identifier
    # lands in every chunk heading and the record stays retrievable. Flattened
    # into a single blob (the fallback below) individual records are unreachable.
    if isinstance(data, list):
        _cands = [data]
    elif isinstance(data, dict):
        _cands = [v for k, v in data.items()
                  if isinstance(v, list) and k not in ("phases", "tasks")]
    else:
        _cands = []

    _records = None
    for _cand in sorted(_cands, key=len, reverse=True):
        _rows = [r for r in _cand if isinstance(r, dict)]
        if len(_rows) < 5 or len(_rows) < len(_cand) * 0.9:
            continue
        # Mean string volume separates content-bearing records from thin
        # structural lists that the phases/tasks branches below already own.
        if sum(sum(len(v) for v in r.values() if isinstance(v, str))
               for r in _rows) / len(_rows) < 200:
            continue
        _records = _rows
        break

    if _records is not None:
        for _i, _rec in enumerate(_records):
            _name = next((_rec[k].strip() for k in ("name", "title", "task", "label")
                          if isinstance(_rec.get(k), str) and _rec[k].strip()), "")
            _ident = next((str(_rec[k]).strip() for k in ("id", "code", "key")
                           if isinstance(_rec.get(k), (str, int)) and str(_rec[k]).strip()), "")
            if _name and _ident and _ident.lower() not in _name.lower():
                _heading = "%s (%s)" % (_name, _ident)
            else:
                _heading = _name or _ident or "%s %d" % (filepath.stem, _i + 1)
            # Short classifier fields fall under _text_from's len>30 filter;
            # keep them so they stay searchable.
            _short = [v.strip() for k, v in _rec.items()
                      if isinstance(v, str) and 0 < len(v.strip()) <= 30
                      and k not in ("name", "title", "task", "label")]
            _parts = [_heading] + _short + [_clean(x) for x in _text_from(_rec)]
            _text = " ".join(x for x in _parts if x and x.strip())
            if _text.strip():
                segments.append({"heading": _heading, "text": _text})
        if segments:
            return segments

    # Handle brain-manifest.json structure
    if isinstance(data, dict):
        heading = data.get("title") or data.get("name") or filepath.stem
        text_parts = _text_from(data)
        if text_parts:
            segments.append({"heading": str(heading), "text": " ".join(text_parts)})

        # Handle phases list
        phases = data.get("phases") or []
        for phase in phases:
            if isinstance(phase, dict):
                ph_name = phase.get("name") or phase.get("id") or "Phase"
                ph_parts = _text_from(phase)
                if ph_parts:
                    segments.append({"heading": str(ph_name), "text": " ".join(ph_parts)})

        # Handle tasks list
        tasks = data.get("tasks") or []
        for task in tasks:
            if isinstance(task, dict):
                t_name = task.get("title") or task.get("task") or task.get("name") or "Task"
                t_parts = _text_from(task)
                if t_parts:
                    segments.append({"heading": str(t_name), "text": " ".join(t_parts)})

    return segments


# ── DB helpers ─────────────────────────────────────────────────────────────────

def init_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    return conn


def insert_source(conn: sqlite3.Connection, filename: str, filepath: str, source_type: str, title: str) -> int:
    cur = conn.execute(
        "INSERT INTO sources (filename, filepath, source_type, title) VALUES (?, ?, ?, ?)",
        (filename, filepath, source_type, title),
    )
    conn.commit()
    return cur.lastrowid


def insert_chunks(conn: sqlite3.Connection, source_id: int, heading: str, text: str, start_idx: int = 0) -> int:
    """Chunk text and insert all segments. Returns number of chunks inserted."""
    segments = chunk_text(text)
    for i, seg in enumerate(segments):
        conn.execute(
            "INSERT INTO chunks (source_id, chunk_idx, heading, text, char_count) VALUES (?, ?, ?, ?, ?)",
            (source_id, start_idx + i, heading, seg, len(seg)),
        )
    conn.commit()
    return len(segments)


# ── Main ───────────────────────────────────────────────────────────────────────

def index_directory(data_dir: str, db_path: str) -> None:
    data_path = Path(data_dir).resolve()
    if not data_path.exists():
        print(f"ERROR: Directory not found: {data_path}")
        sys.exit(1)

    print(f"Indexing: {data_path}")
    print(f"Database: {db_path}")

    conn = init_db(db_path)

    # Track what's already indexed (by filepath) to avoid duplicates
    already_indexed: set[str] = {
        row[0] for row in conn.execute("SELECT filepath FROM sources").fetchall()
    }

    file_count = 0
    chunk_count = 0
    skipped = 0

    extensions = {".pdf", ".xlsx", ".xls", ".pptx", ".ppt", ".json", ".html"}
    all_files = [
        f for f in data_path.rglob("*")
        if f.is_file() and f.suffix.lower() in extensions
    ]

    print(f"Found {len(all_files)} files to process.\n")

    for filepath in sorted(all_files):
        rel = str(filepath.relative_to(data_path))
        abs_path = str(filepath)
        ext = filepath.suffix.lower()

        if abs_path in already_indexed:
            skipped += 1
            continue

        source_type = {
            ".pdf": "pdf",
            ".xlsx": "xlsx", ".xls": "xlsx",
            ".pptx": "pptx", ".ppt": "pptx",
            ".json": "json",
            ".html": "html",
        }.get(ext, "unknown")

        print(f"  [{source_type.upper()}] {rel}")

        # Extract text segments
        if source_type == "pdf":
            segments = extract_pdf(filepath)
        elif source_type == "xlsx":
            segments = extract_xlsx(filepath)
        elif source_type == "pptx":
            segments = extract_pptx(filepath)
        elif source_type == "json":
            segments = extract_json(filepath)
        elif source_type == "html":
            segments = extract_html(filepath)
        else:
            segments = []

        if not segments:
            print(f"    (no text extracted)")
            # Still register the source so we don't re-process
            insert_source(conn, filepath.name, abs_path, source_type, filepath.stem)
            file_count += 1
            continue

        # Determine title from first segment heading or filename
        title = segments[0].get("heading") or filepath.stem

        source_id = insert_source(conn, filepath.name, abs_path, source_type, title)

        chunk_idx = 0
        for seg in segments:
            n = insert_chunks(conn, source_id, seg.get("heading", ""), seg.get("text", ""), chunk_idx)
            chunk_idx += n
            chunk_count += n

        print(f"    -> {chunk_idx} chunks from {len(segments)} sections")
        file_count += 1

    conn.close()
    print(f"\n{'=' * 50}")
    print(f"Indexed {file_count} files, {chunk_count} chunks.")
    if skipped:
        print(f"Skipped {skipped} already-indexed files.")
    print(f"Database: {db_path}")


def build_vectors(db_path: str, vectors_dir: str) -> None:
    """Embed all chunks from SQLite into ChromaDB using sentence-transformers."""
    try:
        import chromadb
        from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
    except ImportError:
        print("ERROR: chromadb / sentence-transformers not installed. Run: pip install chromadb sentence-transformers")
        return

    print(f"\nBuilding vector index → {vectors_dir}")
    ef = SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
    client = chromadb.PersistentClient(path=vectors_dir)
    col = client.get_or_create_collection("sap-cutover", embedding_function=ef)

    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        """SELECT c.id, c.text, c.heading, c.chunk_idx, s.filename, s.source_type, s.title
           FROM chunks c JOIN sources s ON c.source_id = s.id
           ORDER BY c.id"""
    ).fetchall()
    conn.close()

    if not rows:
        print("No chunks to embed.")
        return

    # Upsert in batches of 100
    BATCH = 100
    existing = set(col.get(include=[])["ids"])
    to_add = [r for r in rows if str(r[0]) not in existing]
    print(f"Embedding {len(to_add)} new chunks (skipping {len(rows)-len(to_add)} existing)…")

    for i in range(0, len(to_add), BATCH):
        batch = to_add[i:i+BATCH]
        col.upsert(
            ids=[str(r[0]) for r in batch],
            documents=[r[1] for r in batch],
            metadatas=[{
                "heading":     r[2] or "",
                "chunk_idx":   r[3],
                "source":      r[4],
                "source_type": r[5],
                "title":       r[6] or r[4],
            } for r in batch],
        )
        print(f"  {min(i+BATCH, len(to_add))}/{len(to_add)} chunks embedded")

    print(f"Vector index ready — {col.count()} total chunks in ChromaDB")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SAP Local Brain — Indexer (FTS5)")
    parser.add_argument("--dir",     required=True,  help="Directory containing exported files (files/ subfolder)")
    parser.add_argument("--db",      default="brain.db",      help="SQLite database path")
    args = parser.parse_args()
    index_directory(args.dir, args.db)
