/**
 * The split of lib/tweaks.mjs into backups / apply / tuning / wlan / facade must keep every
 * generated PowerShell script byte for byte. The fixture is the fingerprint of every
 * multi-line template literal in the pre-split file: the same strings, in any order, from
 * the modules that now own them.
 *
 * The second half drives one apply and the matching restore through the new module
 * boundaries, so a missing import or a restore point that never reaches the file is caught
 * here rather than only by the dispatch table.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------- script bytes */

const MODULES = ["tweak-shared", "backups", "tweaks-apply", "tweaks-tuning", "tweaks-wlan", "tweaks"];
const literal = /`(?:\\[\s\S]|[^\\`])*`/g;
const hash = (body) => createHash("sha256").update(body).digest("hex");
// The fixture is about the script text, not about how Git checked this commit out: a Windows
// checkout may hold CRLF, and a hash of those bytes would fail on a runner that got LF.
const lf = (text) => text.replace(/\r\n/g, "\n");

const found = [];
for (const name of MODULES) {
  const src = lf(readFileSync(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), "utf8"));
  literal.lastIndex = 0;
  let m;
  while ((m = literal.exec(src))) {
    const body = m[0].slice(1, -1);
    if (body.includes("\n")) found.push(hash(body));
  }
}

found.sort();
if (process.argv.includes("--update")) {
  writeFileSync(
    fileURLToPath(new URL("./ps-scripts.snapshot.json", import.meta.url)),
    JSON.stringify(
      {
        note: "SHA-256 (LF line endings) of every multi-line PowerShell template literal in the tweaks modules. Regenerate with `node lib/tweaks-split.test.mjs --update` after an intentional script change.",
        count: found.length,
        sortedSha256: found,
      },
      null,
      2,
    ) + "\n",
  );
}
const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL("./ps-scripts.snapshot.json", import.meta.url)), "utf8"));
assert.equal(found.length, snapshot.count, "no PowerShell script was lost or duplicated by the split");
assert.deepEqual(found, snapshot.sortedSha256, "every PowerShell template is byte-identical to the pre-split file");

/* ------------------------------------------------------- apply and restore */

const dir = mkdtempSync(join(tmpdir(), "pinglab-split-"));
process.env.PINGLAB_DATA_DIR = join(dir, "data");
process.env.PINGLAB_PS_STUB = fileURLToPath(new URL("./ps-fake.mjs", import.meta.url));
delete process.env.PINGLAB_ELEVATION;

const tw = await import("../lib/tweaks.mjs");
const backups = await import("../lib/backups.mjs");

const machine = (spec = {}, wlan = {}) => ({
  elevatedUser: false,
  machines: { WLAN: spec },
  wlan: { wifi: true, joined: "HomeNet", profiles: ["Neighbour", "HomeNet"], ...wlan },
});

// Apply: the point is in the file before the elevated call, and pendingTweaks sees it.
process.env.PINGLAB_PS_SCENARIO = JSON.stringify(machine({ ack: null, nodelay: null }));
let res = await tw.runTweakAction("WLAN", "nagle-off");
assert.equal(res.ok, true, `apply failed: ${res.data?.message || res.error}`);
assert.deepEqual(backups.readBackups().nagle.WLAN.before, { TcpAckFrequency: null, TCPNoDelay: null });
assert.equal(backups.readBackups().nagle.WLAN.at.length > 0, true, "the point carries its timestamp");
assert.equal(tw.pendingTweaks().count, 1, "the pending count comes from the same file");

// Revert: the recorded values are written back and the point is dropped, history kept.
process.env.PINGLAB_PS_SCENARIO = JSON.stringify(machine({ ack: null, nodelay: 3 }));
res = await tw.runTweakAction("WLAN", "nagle-on");
assert.equal(res.ok, true, `revert failed: ${res.data?.message || res.error}`);
assert.deepEqual(backups.readBackups().nagle, {});
assert.ok(backups.readBackups().history.length >= 2, "both changes are still in the history");
assert.equal(tw.pendingTweaks().count, 0);

// Restore all: a seeded Wi-Fi order is replayed and dropped only after it came back.
tw.writeBackups({
  dns: {},
  planPower: {},
  nicPower: {},
  nagle: {},
  adapterTuning: {},
  wifiOrder: { "WLAN-order": { profiles: ["Neighbour", "HomeNet"], joined: "HomeNet", at: new Date().toISOString() } },
  history: [],
});
const restoreScenario = {
  elevatedUser: false,
  machines: { "WLAN-order": {} },
  wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet", "Neighbour"], profilesAfter: ["Neighbour", "HomeNet"] },
};
process.env.PINGLAB_PS_SCENARIO = JSON.stringify(restoreScenario);
res = await tw.restoreAll();
assert.equal(res.ok, true, `restore failed: ${res.data?.message || res.error}`);
assert.deepEqual(backups.readBackups().wifiOrder, {}, "the order came back, so its point is dropped");

rmSync(dir, { recursive: true, force: true });
console.log("\ntweaks split");
console.log(`  scripts      ${found.length} PowerShell templates byte-identical to the pre-split file`);
console.log("  round trip   apply records a point, revert drops it, restore-all replays the order");
console.log("\nall tweaks split checks passed");
