import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, dataPath } from "./paths.mjs";

mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = dataPath("pinglab.sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tweaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    applied_at TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_kind ON runs(kind, id DESC);
`;

const SOAK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS soak_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    seconds INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL,
    config TEXT,
    summary TEXT
  );
  CREATE TABLE IF NOT EXISTS soak_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    target TEXT NOT NULL,
    ms REAL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soak_samples_run ON soak_samples(run_id, target, ts);
`;

function openAt(file) {
  const opened = new DatabaseSync(file);
  // The constructor alone does not read the file: a file that is not a database only
  // fails here, on the first statement. The handle still counts as open after a failed
  // statement and Windows then refuses to move the file (EBUSY), so it is closed on the
  // way out: that is what lets the caller put the damaged file aside.
  try {
    opened.exec(SCHEMA);
    opened.exec(SOAK_SCHEMA);
  } catch (err) {
    try {
      opened.close();
    } catch {
      /* already closed */
    }
    throw err;
  }
  return opened;
}

/**
 * Move an unreadable database out of the way under a name this app never opens again, so a
 * fresh one can take its place. The bytes are the user's history, so they are kept.
 *
 * A file that is locked by another instance cannot be moved, and that is reported rather
 * than worked around by deleting it.
 */
function keepUnreadableCopy() {
  let bytes;
  try {
    bytes = readFileSync(DB_FILE);
  } catch (err) {
    return { error: String(err?.code || err?.message || err) };
  }
  // One copy per distinct broken file: a later run with the same bytes reuses the copy
  // instead of filling the folder with identical ones.
  try {
    const kept = readdirSync(DATA_DIR).filter((n) => /^pinglab\.corrupt-.*\.sqlite$/.test(n)).sort();
    for (const name of kept) {
      try {
        const prev = readFileSync(join(DATA_DIR, name));
        if (prev.length === bytes.length && prev.equals(bytes)) {
          rmSync(DB_FILE, { force: true }); // the bytes are already safe under `name`
          return { name };
        }
      } catch {
        /* an unreadable copy is no reason to stop looking */
      }
    }
  } catch {
    /* the scan is best effort; the move below is what matters */
  }

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  for (let n = 0; n < 50; n += 1) {
    const name = n ? `pinglab.corrupt-${stamp}-${n}.sqlite` : `pinglab.corrupt-${stamp}.sqlite`;
    if (existsSync(join(DATA_DIR, name))) continue;
    try {
      renameSync(DB_FILE, join(DATA_DIR, name));
      return { name };
    } catch (err) {
      return { error: String(err?.code || err?.message || err) };
    }
  }
  return { error: "no free name for a copy" };
}

/**
 * Open the history database, and never let a damaged one stop the app from starting. Every
 * surface imports this module, so anything thrown here would take the terminal UI, the GUI
 * and the web UI down together before they could say a word.
 *
 * A file that is not a database is moved aside (the history in it is kept, not deleted) and
 * an empty one takes its place; the problem is then reported through dbStatus(). If even that
 * fails - the file is locked, or the folder is not writable - history for this run lives in
 * memory only, which is a working app with an honest warning rather than a crash.
 */
function openDatabase() {
  try {
    return { db: openAt(DB_FILE), problem: null };
  } catch (err) {
    const detail = String(err?.message || err).split("\n")[0].trim() || "could not be read";
    const kept = keepUnreadableCopy();
    const where = kept.name
      ? `A copy was kept as ${kept.name}, so its history is not lost.`
      : `A copy could not be made either (${kept.error}), so the file was left in place.`;
    let db;
    let note;
    try {
      db = openAt(DB_FILE);
      note = "A new, empty database was started.";
    } catch {
      db = new DatabaseSync(":memory:");
      db.exec(SCHEMA);
      db.exec(SOAK_SCHEMA);
      note = "A new database could not be started here, so this run keeps history in memory only.";
    }
    return {
      db,
      problem: {
        file: DB_FILE,
        detail,
        copy: kept.name ? join(DATA_DIR, kept.name) : null,
        message: `${DB_FILE} ${detail}, so its history could not be read. ${where} ${note}`,
      },
    };
  }
}

const opened = openDatabase();
const db = opened.db;

/** Whether the history database is usable, for every surface that reports it. */
export function dbStatus() {
  return opened.problem ? { ok: false, problem: opened.problem } : { ok: true, problem: null };
}

const now = () => new Date().toISOString();

export function saveRun(kind, summary, data) {
  const info = db
    .prepare("INSERT INTO runs (kind, created_at, summary, data) VALUES (?, ?, ?, ?)")
    .run(kind, now(), summary ?? null, JSON.stringify(data));
  return Number(info.lastInsertRowid);
}

export function listRuns(kind = null, limit = 30) {
  const rows = kind
    ? db.prepare("SELECT id, kind, created_at, summary, data FROM runs WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
    : db.prepare("SELECT id, kind, created_at, summary, data FROM runs ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    summary: r.summary,
    data: safeParse(r.data),
  }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function saveTweak(action, detail) {
  const info = db
    .prepare("INSERT INTO tweaks (action, detail, applied_at) VALUES (?, ?, ?)")
    .run(action, detail ? JSON.stringify(detail) : null, now());
  return Number(info.lastInsertRowid);
}

export function listTweaks(limit = 30) {
  return db
    .prepare("SELECT id, action, detail, applied_at, undone_at FROM tweaks ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      id: r.id,
      action: r.action,
      detail: safeParse(r.detail),
      appliedAt: r.applied_at,
      undoneAt: r.undone_at,
    }));
}

/** Previous run of a kind, useful for before/after comparisons. */
export function previousRun(kind) {
  const rows = db.prepare("SELECT id, created_at, summary, data FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 2").all(kind);
  if (rows.length < 2) return null;
  return { id: rows[1].id, createdAt: rows[1].created_at, summary: rows[1].summary, data: safeParse(rows[1].data) };
}

/* ---------------------------------------------------------------- soak tests */

let insertSampleStmt = null;

export function createSoakRun({ seconds, intervalMs, targets, label }) {
  const info = db
    .prepare("INSERT INTO soak_runs (started_at, seconds, interval_ms, config) VALUES (?, ?, ?, ?)")
    .run(now(), seconds, intervalMs, JSON.stringify({ targets, label: label ?? null }));
  return Number(info.lastInsertRowid);
}

export function insertSoakSample(runId, ts, target, ms, ok) {
  if (!insertSampleStmt) {
    insertSampleStmt = db.prepare("INSERT INTO soak_samples (run_id, ts, target, ms, ok) VALUES (?, ?, ?, ?, ?)");
  }
  insertSampleStmt.run(runId, ts, target, ms === null || ms === undefined ? null : ms, ok ? 1 : 0);
}

export function finishSoakRun(runId, summary) {
  db.prepare("UPDATE soak_runs SET ended_at = ?, summary = ? WHERE id = ?").run(now(), JSON.stringify(summary ?? null), runId);
}

export function getSoakSamples(runId) {
  return db
    .prepare("SELECT ts, target, ms, ok FROM soak_samples WHERE run_id = ? ORDER BY ts ASC")
    .all(runId)
    .map((r) => ({ ts: r.ts, target: r.target, ms: r.ms, ok: r.ok === 1 }));
}

export function getSoakRun(runId) {
  const row = db
    .prepare("SELECT id, started_at, ended_at, seconds, interval_ms, config, summary FROM soak_runs WHERE id = ?")
    .get(runId);
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seconds: row.seconds,
    intervalMs: row.interval_ms,
    config: safeParse(row.config),
    summary: safeParse(row.summary),
  };
}

export function listSoakRuns(limit = 10) {
  return db
    .prepare("SELECT id, started_at, ended_at, seconds, interval_ms, config, summary FROM soak_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      seconds: r.seconds,
      intervalMs: r.interval_ms,
      config: safeParse(r.config),
      summary: safeParse(r.summary),
    }));
}
