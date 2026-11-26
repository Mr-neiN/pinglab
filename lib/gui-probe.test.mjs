/**
 * The desktop window's probe grid, driven headlessly with a synthetic probe result.
 *
 * `PINGLAB_GUI_PROBETEST=1 powershell.exe -File PingLab.ps1` builds the real window without
 * showing it and calls the shipped `Update-Probe` with one completed reply, one challenge-only
 * exchange, one closed port and one silent endpoint. The test reads the ListView rows and the
 * summary label back from the controls: the four stages must be four different sentences, and
 * only the completed reply may carry latency and loss numbers.
 *
 * The window can only be built on Windows; elsewhere the suite says so and passes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "win32") {
  console.log("the GUI probe test builds a WinForms window, so it only runs on Windows");
  console.log("\nall GUI probe checks passed");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "pinglab-gui-probe-"));
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "PingLab.ps1")],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      PINGLAB_DATA_DIR: dir,
      PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
      PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
      PINGLAB_GUI_PROBETEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let out = "";
let err = "";
child.stdout.on("data", (b) => (out += b));
child.stderr.on("data", (b) => (err += b));

console.log("gui probe grid");

try {
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the GUI probe self-test did not finish in 120 s\nstdout:\n${out}\nstderr:\n${err}`));
    }, 120_000);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const line = String(out)
    .split(/\r?\n/)
    .find((l) => l.startsWith("GUIPROBETEST "));
  assert.ok(line, `no GUIPROBETEST line (exit ${code})\nstdout:\n${out}\nstderr:\n${err}`);
  const resultFile = line.slice("GUIPROBETEST ".length).trim();
  assert.ok(existsSync(resultFile), `the self-test result file was not written: ${resultFile}`);
  const seen = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.equal(code, 0, `the GUI probe self-test failed (exit ${code})\n${JSON.stringify(seen)}\n${err}`);

  const row = (prefix) => seen.rows.find((r) => r.text.startsWith(prefix));
  const complete = row("UDP: Complete");
  const partial = row("UDP: Partial");
  const closed = row("UDP: Closed");
  const silent = row("UDP: Silent");
  const mismatched = row("UDP: Mismatched");
  const unexpected = row("UDP: Unexpected");
  assert.ok(
    complete && partial && closed && silent && mismatched && unexpected,
    `every stage has a row: ${JSON.stringify(seen.rows)}`,
  );

  assert.deepEqual(complete.cells, ["40.0", "42.0", "1.0", "0.0%"], "a completed reply carries its figures");
  assert.match(
    partial.text,
    /challenge answered in 12\.5 ms; follow-up never completed - not a reply/,
    "a challenge-only exchange says it is not a reply",
  );
  assert.deepEqual(partial.cells, ["-", "-", "-", "-"], "a partial exchange carries no service figures");
  assert.match(closed.text, /port closed, path 25\.0 ms/, "a closed port keeps its path figure, labelled");
  assert.deepEqual(closed.cells, ["-", "-", "-", "-"], "a closed port has no service figures");
  assert.match(silent.text, /no reply/, "silence is named as silence");
  assert.match(mismatched.text, /datagrams from a different address\/port, untimed/, "wrong-source traffic has its own row");
  assert.match(unexpected.text, /replied with something else, untimed/, "wrong-payload traffic has its own row");
  assert.deepEqual(mismatched.cells, ["-", "-", "-", "-"], "wrong-source traffic carries no figures");
  assert.deepEqual(unexpected.cells, ["-", "-", "-", "-"], "wrong-payload traffic carries no figures");
  assert.match(seen.summary, /UDP 1\/6 answered, 40\.0 ms \| 1 challenge-only/, "the summary counts the partial exchange apart");

  console.log("  completed    one row with latency, jitter and loss");
  console.log("  challenge    one row saying the follow-up never completed, no service figures");
  console.log("  closed       one row with the path figure only");
  console.log("  silent       one row with no reply, not loss");
  console.log("  mismatched   one row for wrong-source datagrams, no figures");
  console.log("  unexpected   one row for a wrong-payload reply, no figures");
  console.log("\nall GUI probe checks passed");
} finally {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
