# PingLab

A local Windows network doctor for gaming: it measures latency, jitter, loss, bufferbloat, DNS and Wi-Fi quality, explains what it finds, and applies a small set of **reversible** fixes. Every change is recorded before it is made and can be undone, and every claim is checked by reading the setting back from Windows rather than trusting a command that returned without error.

It runs entirely on your machine. The only network traffic is the measurements themselves (your endpoint pings, DNS lookups, bufferbloat transfer). There is no telemetry, no account and no cloud.

## Requirements

- Windows 10 or 11.
- **Node.js 22 or newer** for the terminal app and the local web UI (the run history uses Node's built-in `node:sqlite`).
- PowerShell 5.1, which ships with Windows, for the desktop GUI.
- A wireless adapter if you want the Wi-Fi rows; a machine without one shows those rows as "not applicable" instead of guessing.
- Location services enabled for your account if you want SSID/signal/channel detail on Windows 11. When Windows hides those fields, the web UI reports that reason and offers to open the Location settings page; elevation does not bypass it.
- Administrator approval (UAC) for each setting that changes something; a preset asks once per step it actually needs, and every step is a separate undo. Reading state never needs it.

## Launching it

Three surfaces, one engine (`lib/`) and one dispatch table for every action (`lib/tweaks.mjs`), so they cannot drift apart.

| surface | how | notes |
|---|---|---|
| Desktop GUI | double-click `PingLab.cmd` | PowerShell WinForms; tabs for Overview, Fixes, Wi-Fi, Latency, Soak test |
| Terminal | `PingLab-TUI.cmd`, or `node pinglab.mjs` | keys shown at the bottom of each view |
| Web UI | `node server.mjs` (or `npm start`) → <http://127.0.0.1:4747> | bound to loopback only |

One-shot commands from a terminal:

```
node pinglab.mjs --once        render the dashboard once
node pinglab.mjs --fixes       list the reversible settings, their risk and their state
node pinglab.mjs --presets     the named presets and exactly what each applies
node pinglab.mjs --preset X    X = safe | latency (applies that preset)
node pinglab.mjs --audit       every managed setting vs what Windows/the driver reports
node pinglab.mjs --self-check  catalog, presets, dispatch and live state, changes nothing
node pinglab.mjs --wifi        channel and band diagnosis
node pinglab.mjs --probe       latency to the configured game endpoints
node pinglab.mjs --dns         DNS resolver benchmark
node pinglab.mjs --soak [min]  soak test, default 10 minutes
node pinglab.mjs --apply X     X = plan | nic | nagle | wifi | order
node pinglab.mjs --revert X    undo that one setting
node pinglab.mjs --restore     restore everything PingLab changed
node pinglab.mjs --json        raw snapshot as JSON
```

In the terminal app, `f` opens the fixes view and `1`–`5` apply or revert one row, `S` applies the safe preset, `L` the lowest-latency preset, `R` restores everything. DNS lives in its own `d` view because choosing a resolver needs the benchmark first.

Which surface offers what:

| | plan | NIC | Nagle | radio | auto-connect order | DNS benchmark + apply |
|---|---|---|---|---|---|---|
| TUI | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`d` view) |
| GUI | ✓ | ✓ | ✓ | ✓ | ✓ | reads the current servers in Overview; no benchmark |
| Web | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

All three call the same `runTweakAction` dispatch table, and all three draw their names, descriptions, risk tags and preset lists from `lib/catalog.mjs`, so a row that exists on one surface exists on the others; the web UI has no separate allowlist of actions.

## Settings you can change

Nothing here is applied at startup, and **every setting is off by default**: the `default` column below is checked by `--self-check`, so no future edit can quietly make one of them aggressive.

| setting | risk | what it changes | what it trades | undo |
|---|---|---|---|---|
| **Wireless power saving (power plan)** | safe | `powercfg` AC/DC index for *Wireless Adapter Settings → Power Saving Mode* set to `0` = maximum performance, for the active scheme | *battery*: the radio stops stepping down to save power, so a laptop loses some runtime; *latency*: no more 10–50 ms spikes when the radio wakes mid-fight | the recorded AC/DC values are written back (restore-all also drops the per-scheme override when it matches the scheme default) |
| **NIC power management (device)** | safe | `Disable-NetAdapterPowerManagement` for the adapter | *battery*: Windows can no longer park the device while idle; *stability*: removes the missed first packets after the card wakes. Many Wi-Fi drivers expose no such setting — the row then says "not available" instead of pretending | the setting is re-enabled, but only if PingLab was the one that disabled it |
| **Nagle's algorithm (per adapter)** | **moderate** | `TcpAckFrequency=1`, `TCPNoDelay=1` under `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{adapter GUID}` | *latency*: small packets go out immediately, which is the shape of game and voice traffic; *throughput*: more, smaller packets — on a saturated or high-latency uplink this can cost a little bandwidth and CPU, and it bypasses Windows' delayed-ACK timer for this adapter only | the recorded values are written back; keys that did not exist before are removed again |
| **Wi-Fi radio power save (driver properties)** | **experimental** | driver properties `MIMOPowerSaveMode=3` (No SMPS) and `RoamAggressiveness=0` (Lowest) — a hardware property, not a Windows preference | *battery*: both streams stay awake; *stability*: the card holds the current AP until the link drops (good with one router, bad on a mesh). Measured across repeated soaks here: **no gain**, which is why it is experimental and in no preset | the values the driver reported before the write are written back and verified |
| **Wi-Fi auto-connect order** | safe | `netsh wlan set profileorder` moves the profile of the network you are *currently joined to* to priority 1 | *stability*: after an adapter reset Windows rejoins that network instead of whichever saved network is first; the cost is that a deliberately different order is overridden until you restore | the exact previous precedence is replayed and read back; profiles deleted since are left out, never recreated |
| **DNS servers on this adapter** | **moderate** | `Set-DnsClientServerAddress` with the resolver that won the benchmark, or ones you type in | *page loads and sign-ins*: usually faster; *privacy*: queries go to the resolver you pick; *stability*: anything local in your router's DNS (Pi-hole, `.lan`/`.home` names, some captive portals) stops resolving unless you point at the router. Does not change in-game ping | the adapter is handed back to DHCP-provided DNS; the servers in use are recorded first |

Risk levels mean:

- **safe** — one Windows setting, read back, one press to undo. It cannot strand the machine.
- **moderate** — reversible, but it changes behaviour beyond what PingLab measures (throughput shaping, local DNS), so read the trade before applying.
- **experimental** — no measurement here has shown a gain and it writes a hardware property. Never part of a preset; only applied by name.

There is exactly one setting I judged doubtful and kept only as an experiment: the Wi-Fi radio power-save row above. It was applied and soaked repeatedly on this machine and produced no measurable latency or jitter gain, so it is not offered as "tuning" and cannot be reached from any preset or bundled button. It stays in the list because it is fully reversible and someone with a specific adapter complaint may still want it — as a named, explicitly experimental choice.

## Presets

A preset is a short list of settings above, applied in order through the same rows, each with its own restore point and its own undo.

| preset | applies | leaves alone |
|---|---|---|
| **safe** / *Safe / recommended* | wireless power saving, NIC power management, Wi-Fi auto-connect order | Nagle (moderate), the radio experiment, DNS |
| **latency** / *Lowest latency* | the safe preset plus Nagle's algorithm | the radio experiment, DNS |

Rules the presets hold to:

- **Nothing experimental, ever.** `--self-check` fails if a preset lists a tweak marked experimental.
- **DNS is never changed by a preset.** Which resolver is fastest is a measurement, not a preset; it stays a separate button with its own benchmark rule.
- **Every step is separately undoable.** Each setting records its restore point before it is applied, so a preset is three or four individual changes, not one opaque one.
- **Nothing is hidden.** The result lists every step and what happened: applied, already in place, not available on this adapter, or failed.
- The old "apply every fix" action is now an alias for the **safe** preset; there is no bundled button that applies the whole list.

## What it deliberately only advises

These are never changed automatically, because the right answer depends on your hardware, your flat or your ISP:

- **Which DNS resolver to use.** The app measures and recommends; you decide. DNS is only offered when one resolver answered at least 80% of probes, leads the median by at least 10%, **and** wins at least 70% of the head-to-head probes. Otherwise the message says which resolver led and why that is noise, and DNS is left alone.
- **Wi-Fi channel and band.** Co-channel and adjacent-channel interference, and whether a 5 GHz channel is free, are reported. Moving the access point or changing its channel is your router's job.
- **Router-side settings** (QoS, SQM, band steering) and **ISP plans.** Out of scope by design; anything claiming a network speed-up from registry edits is not in this tool.
- **Windows Location services**, needed for Wi-Fi detail on Windows 11. The web UI can open the settings page for you; the app does not flip the switch.

## Undoing things

- **One setting:** press its key in the terminal, its button in the GUI, or its button in the web UI. The inverse is always derived from the stored backup, never from a default.
- **Everything:** `R` in the terminal, *Restore everything PingLab changed* in the GUI, `node pinglab.mjs --restore`, or the *Restore everything* button in the web UI. One elevation prompt restores every recorded setting to the values captured before PingLab touched them, then clears the restore points.
- If a restore does not read back as recorded (for example a profile was deleted in the meantime), the restore point is **kept** and the result says what disagreed, so you can retry rather than losing the original values.
- **Verified, not assumed.** Every write is read back afterwards (registry values, `powercfg` indices, driver properties, DNS server list, the netsh precedence list). If the read-back disagrees, the change is reported as failed, not as done.

Restore points live in `data/backups.json`; `node pinglab.mjs --audit` prints them under "restore points". A count of 0 means the machine is at its original values.

## Files it writes

Everything stays inside this folder:

- `data/backups.json` — restore points and the change history. Keep it if you have changes applied.
- `data/pinglab.sqlite` — probe, DNS and soak history.
- `data/bridge-out.*.jsonl`, `data/tmp/` — transient files used by the GUI bridge and elevated calls.

Deleting the database resets history; deleting `backups.json` while changes are applied means PingLab can no longer undo them.

## Development

- `lib/catalog.mjs` is the single description of every setting: label, what it changes, what it trades, risk, Windows default, how it is undone, which preset includes it. The TUI, the GUI and the web UI all render from it — add a setting there and each surface picks it up. `validateCatalog()` enforces that every entry has a description, a trade-off, a risk, an undo and `default: "off"`, and that no preset contains an experimental setting.
- `lib/tweaks.mjs` is the single dispatch table (`runTweakAction`) plus `applyPreset`, which walks a preset through that same table.
- `node pinglab.mjs --self-check` is the check to run after touching any of this: it validates the catalog and presets, compares every catalog action against the dispatch table, reads each setting from Windows, and compares the app's claim with what Windows reports. It exits non-zero on any disagreement, and changes nothing.
- `node pinglab.mjs --audit` is the same comparison with more detail per row.
- `lib/dns.mjs` holds the resolver benchmark and the verdict rule; `lib/dns-verdict.test.mjs` drives both verdict branches and the 10% / 70% / tie boundaries with fixed inputs — run it with `node lib/dns-verdict.test.mjs`.

## Limits

- Windows only, and localized `netsh` output is parsed — the profile list is found by its dashed section headers rather than by English keywords, but unusual formats make the row refuse to act instead of guessing.
- The auto-connect row needs a wireless adapter, at least one saved profile and a current connection; with no profiles, no joined network, or no profile matching the SSID it says exactly that and changes nothing. If a profile recorded in a backup has since been deleted, restore leaves it out rather than recreating it.
- One UAC prompt per setting; a preset asks once per step it needs. A dismissed prompt is reported as "nothing changed", never as success, and stops the remaining steps instead of asking again.
- No installer, no license file, no telemetry. Copy the folder, install Node, run it.
