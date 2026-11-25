/**
 * The terminal app was split into views (lib/tui-views.mjs), the GUI bridge
 * (lib/gui-bridge.mjs) and the shell in pinglab.mjs. `--once` draws the opening frame through
 * the same render() the interactive session uses, so it is the cheapest proof that the split
 * did not break the wiring: state is read, the views are built, and the footer is drawn.
 *
 * The fake Windows answers the state reads; the update check points at a closed loopback port
 * so the test never waits for GitHub.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pinglab-tui-"));

const child = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--once"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PINGLAB_DATA_DIR: dir,
    PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO: JSON.stringify({
      elevatedUser: false,
      machines: { WLAN: {} },
      wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet"] },
    }),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (b) => (out += b));
child.stderr.on("data", (b) => (err += b));

const code = await new Promise((resolve) => {
  child.once("exit", resolve);
  setTimeout(() => {
    child.kill();
    resolve("timeout");
  }, 60_000);
});

const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
assert.equal(code, 0, `--once exited ${code}: ${err || plain.slice(-300)}`);
assert.match(plain, /PingLab v\d+\.\d+\.\d+ · network doctor/, "the title line is drawn");
assert.match(plain, /Overview/, "the dashboard view is selected");
assert.match(plain, /Connection/, "the connection box is drawn");
assert.match(plain, /p probe · b bloat/, "the footer is drawn");
assert.doesNotMatch(plain, /PingLab failed/, "the shell did not fall back to its error line");

rmSync(dir, { recursive: true, force: true });
console.log("\ntui render");
console.log("  --once       title, overview, connection box and footer drawn");
console.log("\nall tui render checks passed");
