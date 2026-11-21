import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, "pinglab.sqlite"));
db.exec(`
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
`);

db.exec(`
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
`);

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

export function markTweaksUndone() {
  db.prepare("UPDATE tweaks SET undone_at = ? WHERE undone_at IS NULL").run(now());
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
