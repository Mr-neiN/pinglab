# PingLab

A local Windows network doctor for gaming: it measures latency, jitter, loss, bufferbloat, DNS and Wi-Fi quality, explains what it finds, and applies a small set of **reversible** fixes. Every change is recorded before it is made and can be undone, and every claim is checked by reading the setting back from Windows rather than trusting a command that returned without error.

It runs entirely on your machine. The only network traffic is the measurements themselves (your endpoint pings, DNS lookups, bufferbloat transfer). There is no telemetry, no account and no cloud.

## Installing it

Grab the newest release from <https://github.com/Mr-neiN/pinglab/releases>:

| file | what it is |
|---|---|
| `PingLab-Setup-<version>.exe` | per-user installer (no administrator rights needed to install) |
| `PingLab-<version>-portable.zip` | the same app, unzip and run `PingLab.cmd` |
| `SHA256SUMS.txt` | SHA-256 of both files |

The installer puts the app in `%LOCALAPPDATA%\Programs\PingLab`, adds **PingLab** and **PingLab terminal** to the Start menu (and optionally a desktop shortcut), and registers an uninstaller under *Settings → Apps*. It checks for Node.js 22+ before copying anything: if `node` is missing or too old it stops, says so, and offers to open the Node.js download page. Uninstalling removes the program and its shortcuts but leaves `data\` in the install folder, because that is where your restore points live — delete that folder yourself once no setting is left applied.

Installing never asks for elevation. Changing a setting still does — see [Administrator rights](#administrator-rights).

## Requirements

- Windows 10 or 11.
- **Node.js 22 or newer** for the terminal app and the local web UI (the run history uses Node's built-in `node:sqlite`).
- PowerShell 5.1, which ships with Windows, for the desktop GUI.
- A wireless adapter if you want the Wi-Fi rows; a machine without one shows those rows as "not applicable" instead of guessing.
- Location services enabled for your account if you want SSID/signal/channel detail on Windows 11. When Windows hides those fields, the web UI reports that reason and offers to open the Location settings page; elevation does not bypass it.
- Administrator approval (UAC) for each setting that changes something; a preset asks once per step it actually needs, and every step is a separate undo. Reading state never needs it. A standard (non-admin) account works: Windows asks for an administrator's credentials at that point, and the app tells you exactly how to proceed if that prompt is closed — see [Administrator rights](#administrator-rights).

## Launching it

Three surfaces, one engine (`lib/`) and one dispatch table for every action (`lib/tweaks.mjs`), so they cannot drift apart.

| surface | how | notes |
|---|---|---|
| Desktop GUI | double-click `PingLab.cmd` | PowerShell WinForms; tabs for Overview, Fixes, Wi-Fi, Latency, Soak test. The Fixes tab carries all six settings, including DNS (benchmark, then use the winner, or go back to automatic) |
| Terminal | `PingLab-TUI.cmd`, or `node pinglab.mjs` | keys shown at the bottom of each view |
| Web UI | `node server.mjs` (or `npm start`) → <http://127.0.0.1:4747> | loopback only; every response is sent with a strict CSP and the API only answers the page it just served (per-run token, Origin and JSON checks) |

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
node pinglab.mjs --apply X     X = plan | nic | nagle | wifi | order | dns (dns benchmarks first and
                               writes the winner only; without a clear winner it leaves DNS alone)
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

## Administrator rights

Every setting above writes a machine-wide value, so Windows asks for administrator approval each time one is applied or reverted. Reads — the dashboard, `--fixes`, `--audit`, `--self-check`, the DNS benchmark — never need it.

| who | what happens |
|---|---|
| signed-in administrator | a consent dialog: click **Yes** |
| standard account | Windows asks for an administrator account and password (or PIN); approve it and the change runs under that account — nothing to install or configure |
| already elevated (e.g. *Run as administrator*) | no prompt at all, the action runs directly |
| prompt closed or refused | **nothing is written**; the setting is re-read and reported unchanged |

When the prompt does not go through, all three surfaces print the same sentence — built once in `lib/tweaks.mjs` (`elevationText`), so the GUI, TUI, web page and CLI cannot describe the same failure differently:

> Nagle's algorithm (per adapter) was not changed - the Windows administrator prompt was closed, so nothing was written. To do it yourself, right-click PingLab.cmd and choose "Run as administrator", or open an elevated PowerShell in the PingLab folder and run: node pinglab.mjs --apply nagle

An action that would change nothing (the setting is already in the requested state, or the adapter does not support it) says so before any prompt appears, so a standard account is never asked for credentials for a no-op.

Three test hooks make these paths checkable without clicking a prompt; none of them does anything unless the variable is set:

- `PINGLAB_ELEVATION=cancel` or `refuse` — every elevated call returns as if the prompt had been closed or refused, writing nothing.
- `PINGLAB_PS_STUB=<path to lib/ps-fake.mjs>` (+ `PINGLAB_PS_SCENARIO`, `PINGLAB_PS_LOG`) — replaces every PowerShell call with a fake Windows that answers the real scripts, used by `lib/tweaks.test.mjs` to exercise apply and revert without elevation.
- `PINGLAB_DNS_STUB=quad9` (any id from `lib/dns.mjs`) — the DNS benchmark returns a deterministic run where that resolver clearly wins, so the "write the winner" path can be proven on a network where the real resolvers are within noise.

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
- There is no bundled action that applies the whole list: presets replaced the old "apply every fix" button, and nothing can reach the experimental row without asking for it by name.

## What it deliberately only advises

These are never changed automatically, because the right answer depends on your hardware, your flat or your ISP:

- **Which DNS resolver to use.** The app measures and recommends; you decide. DNS is only offered when one resolver answered at least 80% of probes, leads the median by at least 10%, **and** wins at least 70% of the head-to-head probes. Otherwise the message says which resolver led and why that is noise, and DNS is left alone.
- **Wi-Fi channel and band.** Co-channel and adjacent-channel interference, and whether a 5 GHz channel is free, are reported. Moving the access point or changing its channel is your router's job.
- **Router-side settings** (QoS, SQM, band steering) and **ISP plans.** Out of scope by design; anything claiming a network speed-up from registry edits is not in this tool.
- **Windows Location services**, needed for Wi-Fi detail on Windows 11. The web UI can open the settings page for you; the app does not flip the switch.

## Undoing things

- **One setting:** press its key in the terminal, its button in the GUI, or its button in the web UI. The inverse is always derived from the stored backup, never from a default.
- **Everything:** `R` in the terminal, *Restore everything PingLab changed* in the GUI, `node pinglab.mjs --restore`, or the *Restore everything* button in the web UI. One elevation prompt restores every recorded setting to the values captured before PingLab touched them, then clears the restore points it has proven came back; the change history stays, so what was applied and reverted is still visible afterwards.
- If a restore does not read back as recorded (for example a profile was deleted in the meantime), the restore point is **kept** and the result says what disagreed, so you can retry rather than losing the original values.
- **Verified, not assumed.** Every write is read back afterwards (registry values, `powercfg` indices, driver properties, DNS server list, the netsh precedence list). If the read-back disagrees, the change is reported as failed, not as done.

Restore points live in `data/backups.json`; `node pinglab.mjs --audit` prints them under "restore points". A count of 0 means the machine is at its original values.

## Files it writes

Everything stays inside this folder:

- `data/backups.json` — restore points and the change history. Each apply saves its restore point here *before* Windows is touched, and the file is replaced atomically (written to a temporary file, flushed, then renamed), so an interrupted write leaves the previous restore points intact. Keep it if you have changes applied. If it is ever unreadable, PingLab treats its contents as unknown rather than empty: nothing is applied or reverted, the original is never overwritten, a copy is kept as `data/backups.corrupt-<time>.json`, and `--audit`, `--self-check`, the fixes view and the GUI all say so.
- `data/pinglab.sqlite` — probe, DNS and soak history.
- `data/bridge-out.*.jsonl`, `data/tmp/` — transient files used by the GUI bridge and elevated calls.

Deleting the database resets history; deleting `backups.json` while changes are applied means PingLab can no longer undo them.

## Development

- `lib/catalog.mjs` is the single description of every setting: label, what it changes, what it trades, risk, Windows default, how it is undone, which preset includes it. The TUI, the GUI and the web UI all render from it — add a setting there and each surface picks it up. `validateCatalog()` enforces that every entry has a description, a trade-off, a risk, an undo and `default: "off"`, and that no preset contains an experimental setting.
- `lib/tweaks.mjs` is the single dispatch table (`runTweakAction`) plus `applyPreset`, which walks a preset through that same table. `lib/tweaks.test.mjs` drives `runTweakAction`, `applyPreset` and `restoreAll` against `lib/ps-fake.mjs` (a fake Windows loaded through `PINGLAB_PS_STUB`) and pins applied / already-in-place / unavailable / refused / failed-after-write / reverted / restored, including the restore point each one leaves behind — run it with `node lib/tweaks.test.mjs`.
- `node pinglab.mjs --self-check` is the check to run after touching any of this: it validates the catalog and presets, compares every catalog action against the dispatch table, reads each setting from Windows, and compares the app's claim with what Windows reports. It exits non-zero on any disagreement, and changes nothing.
- `node pinglab.mjs --audit` is the same comparison with more detail per row.
- `lib/dns.mjs` holds the resolver benchmark and the verdict rule; `lib/dns-verdict.test.mjs` drives both verdict branches and the 10% / 70% / tie boundaries with fixed inputs — run it with `node lib/dns-verdict.test.mjs`.
- `lib/probe.mjs` turns raw round-trips into the figures every surface prints. Jitter there is the mean absolute difference between *consecutive* samples, measured before anything is sorted; `lib/probe-math.test.mjs` pins that order along with loss and the percentiles — run it with `node lib/probe-math.test.mjs`.
- `installer/build.ps1` builds the release artifacts into `dist/`: the portable zip, the Inno Setup installer (`installer/pinglab.iss`, per-user, Node checked in `[Code]`) and `SHA256SUMS.txt`. It picks the version from `package.json` unless you pass `-Version`. The icon comes from `installer/make-icon.ps1` and is committed, so a normal build does not redraw it.
- `.github/workflows/release.yml` builds and attaches those files to a GitHub release for every tag shaped like `v1.2.3`, or on demand for an existing tag. The tag's version is passed to `build.ps1`, so the installer, the zip and the release all carry the same number.

## Limits

- Windows only, and localized `netsh` output is parsed — the profile list is found by its dashed section headers rather than by English keywords, but unusual formats make the row refuse to act instead of guessing.
- The auto-connect row needs a wireless adapter, at least one saved profile and a current connection; with no profiles, no joined network, or no profile matching the SSID it says exactly that and changes nothing. If a profile recorded in a backup has since been deleted, restore leaves it out rather than recreating it.
- One UAC prompt per setting; a preset asks once per step it needs. A dismissed prompt is reported as "nothing changed", never as success, and stops the remaining steps instead of asking again.
- No installer, no license file, no telemetry. Copy the folder, install Node, run it.
