/**
 * The audit row for the radio properties compares the app's claim with the driver. It must
 * not also require a restore point: a fresh install on a machine that is already tuned (or
 * whose data/ folder was left behind) has the values in place but no record, and that used
 * to fail the audit while printing the same reading on both sides.
 */
import assert from "node:assert/strict";

import { auditRows } from "./tweaks.mjs";

const items = (values) =>
  values.map(([keyword, value, want, display]) => ({ keyword, value, want, wantText: display, display }));

const tuned = items([
  ["MIMOPowerSaveMode", 3, 3, "No SMPS"],
  ["RoamAggressiveness", 0, 0, "1. Lowest"],
]);
const vendor = items([
  ["MIMOPowerSaveMode", 0, 3, "Auto SMPS"],
  ["RoamAggressiveness", 2, 0, "3. Medium"],
]);

const base = {
  planPower: "off",
  powerRaw: { planAc: 0, planDc: 0, ndis: "unreadable", wmiEnable: null },
  nicPower: "unsupported",
  nagleDisabled: true,
  nagleValues: { tcpAckFrequency: 1, tcpNoDelay: 1 },
  wifiOrder: null,
};
const radioRow = (tw) => auditRows(tw).find((r) => r.key === "adapterTuning");

const noRecord = radioRow({ ...base, adapterTuning: { items: tuned, needsFix: false }, adapterTuningAppliedByUs: false });
assert.equal(noRecord.match, true, "tuned values without a restore point must still match the driver");
assert.equal(noRecord.reported, "tuned");
assert.match(noRecord.note, /no restore point/);

const withRecord = radioRow({ ...base, adapterTuning: { items: tuned, needsFix: false }, adapterTuningAppliedByUs: true });
assert.equal(withRecord.match, true);
assert.match(withRecord.note, /applied on request/);

const atVendor = radioRow({ ...base, adapterTuning: { items: vendor, needsFix: true }, adapterTuningAppliedByUs: false });
assert.equal(atVendor.match, true, "vendor values must match the claim that they are not tuned");
assert.equal(atVendor.reported, "not tuned for a fixed desktop");

const unreadable = radioRow({ ...base, adapterTuning: null });
assert.equal(unreadable.match, false, "an unreadable driver must never be reported as a match");
assert.equal(unreadable.reported, "unreadable");

console.log("all audit checks passed");
