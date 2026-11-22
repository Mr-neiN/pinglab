/**
 * One worker for lib/concurrency.test.mjs - spawned as a real second process.
 *
 * It waits for the parent's `go` file, so two of these start together, then does exactly one
 * thing (via PINGLAB_CHILD_MODE) and writes a report with its own start and end timestamps.
 * The reports are what prove the two processes really overlapped rather than ran one after
 * the other, and PINGLAB_CHILD_LIB_DIR lets the same worker be pointed at an older lib/ so the
 * race can be reproduced against the code as it was.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.env.PINGLAB_CHILD_MODE;
const alias = process.env.PINGLAB_CHILD_ALIAS || "WLAN";
const dir = process.env.PINGLAB_CHILD_DIR;
const libDir = process.env.PINGLAB_CHILD_LIB_DIR || fileURLToPath(new URL("./", import.meta.url));
const lib = (name) => import(pathToFileURL(join(libDir, name)).href);

const report = { alias, mode, started: null, finished: null, ok: false, error: null, detail: null };
const began = Date.now();

// The barrier: both workers are alive before either one starts, so a lock is the only thing
// that can serialise them.
const go = join(dir, "go");
while (!existsSync(go) && Date.now() - began < 20000) {
  await new Promise((r) => setTimeout(r, 5));
}

report.started = Date.now();
try {
  if (mode === "apply") {
    const { runTweakAction } = await lib("tweaks.mjs");
    const res = await runTweakAction(alias, "plan-power-off");
    report.ok = Boolean(res.ok);
    report.error = res.ok ? null : res.error || res.data?.message || "the action failed";
    report.detail = res.data?.message || null;
  } else if (mode === "insert") {
    const db = await lib("db.mjs");
    const own = db.createSoakRun({
      seconds: 60,
      intervalMs: 200,
      targets: [{ id: "t", label: "test", host: "1.1.1.1", port: 443 }],
      label: `worker-${alias}`,
    });
    const samples = 60;
    for (let i = 0; i < samples; i += 1) {
      db.insertSoakSample(own, Date.now(), "t", 10 + i, true);
      await new Promise((r) => setTimeout(r, 2));
    }
    db.finishSoakRun(own, { samples });
    report.detail = { runId: own, samples: db.getSoakSamples(own).length, wanted: samples };
    report.ok = report.detail.samples === samples;
    if (!report.ok) report.error = `only ${report.detail.samples} of ${samples} samples landed`;
  } else if (mode === "verify-samples") {
    // Read from a separate process: this test's own process must not hold the database open,
    // or Windows refuses to remove the throwaway folder afterwards.
    const db = await lib("db.mjs");
    const runs = db.listSoakRuns(20).filter((r) => String(r.config?.label || "").startsWith("worker-"));
    report.detail = {
      runs: runs.map((r) => ({ id: r.id, label: r.config.label, samples: db.getSoakSamples(r.id).length })),
    };
    report.ok = true;
  } else if (mode === "inspect") {
    const { readBackups, pendingTweaks, backupStatus } = await lib("tweaks.mjs");
    report.detail = {
      backups: readBackups(),
      pending: pendingTweaks().count,
      ok: backupStatus().ok,
    };
    report.ok = backupStatus().ok;
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} catch (err) {
  report.error = String(err?.message || err);
}
report.finished = Date.now();
writeFileSync(join(dir, `report-${mode}-${alias}.json`), JSON.stringify(report));
