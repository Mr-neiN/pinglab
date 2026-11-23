/**
 * Two PingLab processes, one data folder.
 *
 * The GUI's bridge, the web server and a terminal soak are meant to run at the same time, so
 * "one restore point per change" and "every measured sample is stored" have to hold across
 * processes, not just within one. This suite spawns real child processes against a shared
 * PINGLAB_DATA_DIR - the barrier in lib/concurrency-child.mjs makes them start together, and
 * their reports prove the two really overlapped:
 *
 *   restore points  two applies in different processes both leave their point behind
 *   valid file      backups.json parses on every read taken while those writes happen
 *   lock busy       a second process is told another action is writing, and nothing is lost
 *   samples         two processes inserting soak samples at once both persist every row
 *   legacy          a backups.json written by 1.0.10 loads unchanged and is not rewritten
 *
 * It fails on the code before lib/backup-lock.mjs and the SQLite busy handling: the same child
 * worker, pointed at that lib/ with PINGLAB_CHILD_LIB_DIR, loses one restore point and throws
 * SQLITE_BUSY on the samples.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pinglab-concurrency-"));
const dataDir = join(dir, "data");
const backupsFile = join(dataDir, "backups.json");
const goFile = join(dir, "go");
mkdirSync(dataDir, { recursive: true });
process.env.PINGLAB_DATA_DIR = dataDir;

const child = join(HERE, "concurrency-child.mjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (mode, alias) => JSON.parse(readFileSync(join(dir, `report-${mode}-${alias}.json`), "utf8"));
const files = () => readdirSync(dataDir).sort();

function env(extra) {
  return {
    ...process.env,
    PINGLAB_DATA_DIR: dataDir,
    PINGLAB_CHILD_DIR: dir,
    PINGLAB_PS_STUB: join(HERE, "ps-fake.mjs"),
    PINGLAB_PS_LOG: "",
    PINGLAB_PS_SCENARIO: JSON.stringify({
      elevatedUser: false,
      machines: {
        A: { power: { planAc: 1, planDc: 2, scheme: "SCHEME-A" } },
        B: { power: { planAc: 2, planDc: 1, scheme: "SCHEME-B" } },
        C: { power: { planAc: 1, planDc: 1, scheme: "SCHEME-C" } },
      },
      wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet", "Neighbour"] },
    }),
    ...extra,
  };
}

/** Start one worker and return a promise for its exit. */
function start(mode, alias, extra = {}) {
  const proc = spawn(process.execPath, [child], {
    env: env({ PINGLAB_CHILD_MODE: mode, PINGLAB_CHILD_ALIAS: alias, ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const done = new Promise((resolve) => proc.on("close", (code) => resolve({ code, output })));
  return { proc, done };
}

/** Run two workers that start at the same instant, and require their lifetimes to overlap. */
async function together(mode, aliases, extra = {}) {
  rmSync(goFile, { force: true });
  for (const alias of aliases) rmSync(join(dir, `report-${mode}-${alias}.json`), { force: true });
  const workers = aliases.map((alias) => start(mode, alias, extra));
  await wait(150);
  writeFileSync(goFile, "go\n");
  const exits = await Promise.all(workers.map((w) => w.done));
  const reports = aliases.map((alias) => report(mode, alias));
  for (let i = 0; i < aliases.length; i += 1) {
    assert.equal(exits[i].code, 0, `worker ${aliases[i]} exited ${exits[i].code}: ${exits[i].output}`);
    assert.equal(reports[i].error, null, `worker ${aliases[i]} failed: ${reports[i].error}`);
  }
  const [a, b] = reports;
  assert.ok(
    a.started < b.finished && b.started < a.finished,
    `the two workers did not overlap (${a.started}-${a.finished} vs ${b.started}-${b.finished}); the race was not exercised`,
  );
  return reports;
}

const passed = [];
try {
  /* 1. Two applies, two restore points. The 400 ms pause inside the critical section is what
   *    made this lose a point before the lock existed; it is a wait, not a retry, so the lock
   *    is the only thing that can make the writes serialise. */
  {
    let watching = true;
    const invalid = [];
    const watcher = (async () => {
      while (watching) {
        try {
          const text = readFileSync(backupsFile, "utf8");
          JSON.parse(text);
        } catch (err) {
          if (err?.code !== "ENOENT") invalid.push(String(err?.message || err));
        }
        await wait(5);
      }
    })();
    const reports = await together("apply", ["A", "B"], { PINGLAB_BACKUP_DELAY_MS: "400" });
    watching = false;
    await watcher;

    assert.deepEqual(invalid, [], "backups.json must parse on every read, including mid-write");
    const json = JSON.parse(readFileSync(backupsFile, "utf8"));
    assert.ok(json.planPower.A, "the first process's restore point survived the second process's write");
    assert.ok(json.planPower.B, "the second process's restore point is there too");
    assert.equal(Object.keys(json.planPower).length, 2, "exactly the two points, from two processes");
    const changes = json.history.filter((h) => h.action === "plan-power-off");
    assert.equal(
      changes.length,
      2,
      `both changes are in the history (saw ${JSON.stringify(json.history)}; workers said ${reports
        .map((r) => `${r.alias}: ${r.detail}`)
        .join(" | ")})`,
    );
    assert.deepEqual(
      files().filter((f) => f.endsWith(".tmp") || f.includes(".lock") || f.includes(".stale-")),
      [],
      "no temporary or lock file is left behind",
    );
    assert.ok(reports.every((r) => r.detail), "each worker saw a normal success message");
    passed.push("restore points from two processes both survive");
  }

  /* 2. The lock is held by this process: the worker waits, then says so, and changes nothing. */
  {
    const { acquireLock } = await import("../lib/backup-lock.mjs");
    const lockFile = join(dataDir, ".backups.lock");
    const before = readFileSync(backupsFile, "utf8");
    const release = acquireLock(lockFile, { waitMs: 1000 });
    assert.ok(release, "the test could take the lock");
    const worker = start("apply", "C", { PINGLAB_BACKUP_LOCK_WAIT_MS: "300" });
    const exit = await worker.done;
    release();
    assert.equal(exit.code, 0, `worker exited ${exit.code}: ${exit.output}`);
    const r = report("apply", "C");
    assert.equal(r.ok, false, "a blocked apply must not report success");
    assert.match(r.error, /Another PingLab action is writing restore points\. Try again in a moment\./);
    assert.equal(readFileSync(backupsFile, "utf8"), before, "the file is untouched by the blocked worker");
    assert.ok(!existsSync(lockFile), "the test's own lock is released");
    passed.push("lock contention is reported, not overwritten");
  }

  /* 3. Two processes inserting soak samples at once: every row lands in the database. */
  {
    const reports = await together("insert", ["X", "Y"]);
    const verifier = start("verify-samples", "all");
    const exit = await verifier.done;
    assert.equal(exit.code, 0, `verifier exited ${exit.code}: ${exit.output}`);
    const stored = report("verify-samples", "all").detail.runs;
    for (const r of reports) {
      assert.equal(r.detail.samples, r.detail.wanted, `${r.alias} stored ${r.detail.samples}/${r.detail.wanted} samples`);
      const row = stored.find((s) => s.id === r.detail.runId);
      assert.ok(row, `${r.alias}'s run is in the database`);
      assert.equal(row.samples, r.detail.wanted, `${r.alias}'s rows are readable afterwards`);
    }
    assert.notEqual(reports[0].detail.runId, reports[1].detail.runId, "each worker wrote its own run");
    assert.equal(stored.length, 2, "exactly the two workers' runs are in the database");
    assert.deepEqual(
      files().filter((f) => f.includes(".corrupt-")),
      [],
      "opening the database while another process writes it must not set a healthy file aside",
    );
    passed.push("samples from two processes both persist");
  }

  /* 4. A 1.0.10-era file: same fields, same count, byte-identical after a read. */
  {
    const legacy = {
      dns: { WLAN: { servers: ["192.168.1.1"], staticDns: false, at: "2026-11-20T10:00:00.000Z" } },
      planPower: {
        WLAN: {
          ac: 0,
          dc: 2,
          acSource: "user",
          dcSource: "user",
          scheme: "381b4222-f694-41f0-9685-ff5bb260df2e",
          at: "2026-11-20T10:00:00.000Z",
        },
      },
      nicPower: { WLAN: { before: "Disabled", at: "2026-11-20T10:00:00.000Z" } },
      nagle: {
        WLAN: {
          guid: "{BDF5A313-5B84-4695-B5E5-7F37F9C5E2F5}",
          key: "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{BDF5A313-5B84-4695-B5E5-7F37F9C5E2F5}",
          before: { TcpAckFrequency: null, TCPNoDelay: null },
          at: "2026-11-20T10:00:00.000Z",
        },
      },
      adapterTuning: {},
      wifiOrder: {},
      history: [
        {
          action: "dns",
          detail: { alias: "WLAN", from: ["192.168.1.1"], to: ["1.1.1.1", "1.0.0.1"] },
          at: "2026-11-20T10:00:00.000Z",
        },
      ],
    };
    const text = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(backupsFile, text, "utf8");
    const worker = start("inspect", "legacy");
    const exit = await worker.done;
    assert.equal(exit.code, 0, `worker exited ${exit.code}: ${exit.output}`);
    const r = report("inspect", "legacy");
    assert.ok(r.ok, `a 1.0.10 file must load: ${r.error}`);
    assert.deepEqual(r.detail.backups, legacy, "every recorded field comes back unchanged");
    assert.equal(r.detail.pending, 4, "all four restore points are counted");
    assert.equal(readFileSync(backupsFile, "utf8"), text, "reading a file does not rewrite it");
    passed.push("a 1.0.10 restore-point file loads unchanged");
  }
} finally {
  // The SQLite database lives here; if a handle were still open Windows would refuse this,
  // which is itself worth failing on rather than leaving a temp folder behind.
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

console.log("\nconcurrency");
console.log(`  cases        ${passed.length}`);
for (const name of passed) console.log(`  · ${name}`);
console.log("  processes    real children, started together through a barrier, lifetimes overlapped");
console.log("\nall concurrency checks passed");
