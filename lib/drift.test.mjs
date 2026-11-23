/**
 * Drift, driven on a fake Windows with restore points written by an earlier run.
 *
 * The question this suite answers is the one the app could not answer before: a setting
 * PingLab wrote, which Windows has since put back. Each case describes a machine where that
 * happened and asserts the row says so - and, just as important, that a setting still in place
 * is not reported as drift, and that a reading which cannot settle the question is not guessed
 * either way.
 *
 * The fake is lib/ps-fake.mjs through PINGLAB_PS_STUB, so no PowerShell process starts and
 * nothing on this machine is read or written: the data folder is inside a throwaway directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pinglab-drift-"));
process.env.PINGLAB_DATA_DIR = join(dir, "data");
process.env.PINGLAB_PS_STUB = join(ROOT, "lib", "ps-fake.mjs");
delete process.env.PINGLAB_PS_LOG;
delete process.env.PINGLAB_ELEVATION;

const tweaks = await import("../lib/tweaks.mjs");
const drift = await import("../lib/drift.mjs");

const EMPTY = { dns: {}, planPower: {}, nicPower: {}, nagle: {}, adapterTuning: {}, wifiOrder: {}, history: [] };
const AT = "2026-01-01T00:00:00.000Z";

function seed(sections) {
  const b = structuredClone(EMPTY);
  Object.assign(b, sections);
  tweaks.writeBackups(b);
}

/**
 * Read one adapter's state off a described machine. `wlan` defaults to a joined network with
 * two saved profiles and `HomeNet` second, which is the order the auto-connect row changes.
 */
async function statusFor(alias, spec = {}, extra = {}) {
  process.env.PINGLAB_PS_SCENARIO = JSON.stringify({
    elevatedUser: false,
    machines: { [alias]: spec },
    wlan: {
      wifi: true,
      joined: "HomeNet",
      profiles: ["HomeNet", "Neighbour"],
      ...(extra.wlan || {}),
    },
    ...(extra.dns ? { dns: extra.dns } : {}),
    ...(extra.dnsStatic ? { dnsStatic: extra.dnsStatic } : {}),
  });
  const tw = await tweaks.tweakState(alias);
  return { tw, drift: drift.driftStatus(tw) };
}

const reverted = (d, key) => {
  const r = d.rows.find((x) => x.key === key);
  assert.ok(r, `no drift row for ${key}`);
  assert.equal(r.state, "reverted", `expected ${key} to be reported as reverted, got ${r.state}: ${r.observation}`);
  return r;
};

const cases = [
  {
    name: "plan power: the value is back and the row says so, with one shared sentence",
    seed: { planPower: { WLAN: { ac: 1, dc: 2, scheme: "SCHEME-1", at: AT } } },
    run: () => statusFor("WLAN", { power: { planAc: 2, planDc: 2, scheme: "SCHEME-1" } }),
    check: ({ drift: d }) => {
      const r = reverted(d, "plan-power");
      assert.match(r.observation, /AC 2 \/ battery 2/);
      assert.equal(d.count, 1);
      assert.match(d.text, /^1 change PingLab made has since been undone/);
      assert.match(d.text, /Wireless power saving/);
      assert.match(d.text, /restore point is still there/);
    },
  },
  {
    name: "plan power: still 0/0 is in place, not drift",
    seed: { planPower: { WLAN: { ac: 1, dc: 2, scheme: "SCHEME-1", at: AT } } },
    run: () => statusFor("WLAN", { power: { planAc: 0, planDc: 0, scheme: "SCHEME-1" } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
      assert.equal(d.text, null);
      assert.equal(d.rows.find((x) => x.key === "plan-power").state, "in-place");
    },
  },
  {
    name: "plan power: a switched plan is named as the cause",
    seed: { planPower: { WLAN: { ac: 1, dc: 2, scheme: "SCHEME-1", at: AT } } },
    run: () => statusFor("WLAN", { power: { planAc: 2, planDc: 3, scheme: "SCHEME-2" } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "plan-power").observation, /power plan was switched/);
    },
  },
  {
    name: "plan power: a switched plan that is also at maximum is not reported",
    seed: { planPower: { WLAN: { ac: 1, dc: 2, scheme: "SCHEME-1", at: AT } } },
    run: () => statusFor("WLAN", { power: { planAc: 0, planDc: 0, scheme: "SCHEME-2" } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0, "the active plan is at maximum performance, so nothing is lost");
      assert.match(d.rows.find((x) => x.key === "plan-power").observation, /different one, but it also reads maximum/);
    },
  },
  {
    name: "Nagle: both values gone is drift",
    seed: { nagle: { WLAN: { guid: "GUID-WLAN", before: { TcpAckFrequency: null, TCPNoDelay: null }, at: AT } } },
    run: () => statusFor("WLAN", { ack: null, nodelay: null }),
    check: ({ drift: d }) => {
      const r = reverted(d, "nagle");
      assert.match(r.observation, /absent \/ absent/);
      assert.match(d.text, /Nagle/);
    },
  },
  {
    name: "Nagle: a new adapter GUID explains why the values are missing",
    seed: { nagle: { WLAN: { guid: "{OLD-GUID}", before: { TcpAckFrequency: null, TCPNoDelay: null }, at: AT } } },
    run: () => statusFor("WLAN", { ack: null, nodelay: null }),
    check: ({ drift: d }) => {
      const r = reverted(d, "nagle");
      assert.match(r.observation, /GUID changed/);
      assert.match(r.observation, /\{OLD-GUID\}/);
    },
  },
  {
    name: "Nagle: values still 1 is in place",
    seed: { nagle: { WLAN: { guid: "GUID-WLAN", before: { TcpAckFrequency: null, TCPNoDelay: null }, at: AT } } },
    run: () => statusFor("WLAN", { ack: 1, nodelay: 1 }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
      assert.equal(d.rows.find((x) => x.key === "nagle").state, "in-place");
    },
  },
  {
    name: "NIC power management: Windows may power the device down again",
    seed: { nicPower: { WLAN: { before: "Disabled", at: AT } } },
    run: () => statusFor("WLAN", { power: { ndis: "Enabled", wmiEnable: true } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "nic-power").observation, /may power the device down again/);
    },
  },
  {
    name: "NIC power management: a driver that stopped exposing the setting is drift too",
    seed: { nicPower: { WLAN: { before: "Disabled", at: AT } } },
    run: () => statusFor("WLAN", { power: { ndis: "unreadable", wmiEnable: null } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "nic-power").observation, /no longer exposes/);
    },
  },
  {
    name: "radio properties: back at the driver's stock values",
    seed: { adapterTuning: { WLAN: { values: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 }, at: AT } } },
    run: () => statusFor("WLAN", { tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "radio-tuning").observation, /driver reads .* again/);
    },
  },
  {
    name: "auto-connect order: another saved network is first again",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () =>
      statusFor("WLAN", {}, { wlan: { joined: "HomeNet", profiles: ["Neighbour", "HomeNet"] } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "wifi-order").observation, /#2 again/);
    },
  },
  {
    name: "auto-connect order: still first is in place",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () => statusFor("WLAN", {}, { wlan: { joined: "HomeNet", profiles: ["HomeNet", "Neighbour"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
    },
  },
  {
    name: "auto-connect order: the profile PingLab moved is tracked, not the network joined now",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () =>
      statusFor("WLAN", {}, { wlan: { joined: "Office", profiles: ["Office", "HomeNet", "Neighbour"] } }),
    check: ({ drift: d }) => {
      const r = reverted(d, "wifi-order");
      assert.match(r.observation, /"HomeNet" is #2 again/);
      assert.equal(d.count, 1, "joining another network must not hide that HomeNet lost first place");
    },
  },
  {
    name: "auto-connect order: another joined network does not hide that the moved profile is still first",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () =>
      statusFor("WLAN", {}, { wlan: { joined: "Office", profiles: ["HomeNet", "Office", "Neighbour"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0, "HomeNet is still first, so the change is still in place");
      assert.match(d.rows.find((x) => x.key === "wifi-order").observation, /"HomeNet" is still first/);
    },
  },
  {
    name: "auto-connect order: the moved profile deleted is unknown, even while another network is joined",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () => statusFor("WLAN", {}, { wlan: { joined: "Office", profiles: ["Office", "Neighbour"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
      const r = d.rows.find((x) => x.key === "wifi-order");
      assert.equal(r.state, "unknown");
      assert.match(r.observation, /profile for "HomeNet" is gone/);
    },
  },
  {
    name: "auto-connect order: a deleted profile is reported as unknown, not as drift",
    seed: { wifiOrder: { WLAN: { profiles: ["HomeNet", "Neighbour"], joined: "HomeNet", at: AT } } },
    run: () => statusFor("WLAN", {}, { wlan: { joined: "Other", profiles: ["Neighbour"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0, "a profile that no longer exists cannot be called undone");
      const r = d.rows.find((x) => x.key === "wifi-order");
      assert.equal(r.state, "unknown");
      assert.match(r.observation, /profile for "HomeNet" is gone/, "the deleted profile is the one PingLab moved");
    },
  },
  {
    name: "DNS: back to the servers recorded before the change",
    seed: {
      dns: { WLAN: { servers: ["192.168.1.1"], staticDns: false, at: AT } },
      history: [{ action: "dns", detail: { alias: "WLAN", from: ["192.168.1.1"], to: ["1.1.1.1", "1.0.0.1"] }, at: AT }],
    },
    run: () => statusFor("WLAN", {}, { dns: { WLAN: ["192.168.1.1"] } }),
    check: ({ drift: d }) => {
      assert.match(reverted(d, "dns").observation, /192\.168\.1\.1 again/);
    },
  },
  {
    name: "DNS: still the winner is in place",
    seed: {
      dns: { WLAN: { servers: ["192.168.1.1"], staticDns: false, at: AT } },
      history: [{ action: "dns", detail: { alias: "WLAN", from: ["192.168.1.1"], to: ["1.1.1.1", "1.0.0.1"] }, at: AT }],
    },
    run: () => statusFor("WLAN", {}, { dns: { WLAN: ["1.1.1.1", "1.0.0.1"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
      assert.equal(d.rows.find((x) => x.key === "dns").state, "in-place");
    },
  },
  {
    name: "DNS: a third list is unknown, because PingLab did not set it",
    seed: {
      dns: { WLAN: { servers: ["192.168.1.1"], staticDns: false, at: AT } },
      history: [{ action: "dns", detail: { alias: "WLAN", from: ["192.168.1.1"], to: ["1.1.1.1", "1.0.0.1"] }, at: AT }],
    },
    run: () => statusFor("WLAN", {}, { dns: { WLAN: ["9.9.9.9"] } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 0);
      const r = d.rows.find((x) => x.key === "dns");
      assert.equal(r.state, "unknown");
      assert.match(r.observation, /neither what PingLab set/);
    },
  },
  {
    name: "two changes at once: one sentence names both, in the plural",
    seed: {
      planPower: { WLAN: { ac: 1, dc: 2, scheme: "SCHEME-1", at: AT } },
      nagle: { WLAN: { guid: "GUID-WLAN", before: { TcpAckFrequency: null, TCPNoDelay: null }, at: AT } },
    },
    run: () => statusFor("WLAN", { ack: null, nodelay: null, power: { planAc: 1, planDc: 2, scheme: "SCHEME-1" } }),
    check: ({ drift: d }) => {
      assert.equal(d.count, 2);
      assert.match(d.text, /^2 changes PingLab made have since been undone/);
      assert.match(d.text, /and Nagle/);
      assert.match(d.text, /restore points are still there/);
    },
  },
  {
    name: "no restore points: a stock machine is not drift and prints no sentence",
    seed: {},
    run: () => statusFor("WLAN", {}),
    check: ({ drift: d }) => {
      assert.equal(d.rows.length, 0);
      assert.equal(d.count, 0);
      assert.equal(d.text, null);
    },
  },
];

/* --------------------------------------------------------------------- run */

const passed = [];
for (const c of cases) {
  seed(c.seed);
  const res = await c.run();
  await c.check(res);
  passed.push(c.name);
}

rmSync(dir, { recursive: true, force: true });

console.log("\ndrift");
console.log(`  cases        ${passed.length}`);
console.log("  reverted     a setting PingLab wrote that Windows put back is named, not left to be noticed");
console.log("  in place     the same values are not reported as drift");
console.log("  unknown      an unreadable or third-party reading is said so, never counted");
console.log("  sentence     one text for the fixes view, the GUI, the page and --audit");
console.log("\nall drift checks passed");
