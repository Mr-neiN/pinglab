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
| Desktop GUI | double-click `PingLab.cmd` | PowerShell WinForms; tabs for Overview, Fixes, Wi-Fi, Latency (latency and bufferbloat), Soak test. The Fixes tab carries all six settings, including DNS (benchmark, then use the winner, or go back to automatic) |
| Terminal | `PingLab-TUI.cmd`, or `node pinglab.mjs` | keys shown at the bottom of each view; `b` runs the bufferbloat test |
| Web UI | `node server.mjs` (or `npm start`) → <http://127.0.0.1:4747> | loopback only; every response is sent with a strict CSP and the API only answers the page it just served (per-run token, Origin and JSON checks) |

One-shot commands from a terminal:

```
node pinglab.mjs --once        render the dashboard once
node pinglab.mjs --view NAME   draw one dashboard view once (dash, fixes, probe, wifi, dns, soak, history)
node pinglab.mjs --fixes       list the reversible settings, their risk and their state
node pinglab.mjs --presets     the named presets and exactly what each applies
node pinglab.mjs --preset X    X = safe | latency (applies that preset)
node pinglab.mjs --audit       every managed setting vs what Windows/the driver reports
node pinglab.mjs --self-check  catalog, presets, dispatch and live state, changes nothing
node pinglab.mjs --wifi        channel and band diagnosis
node pinglab.mjs --probe       latency to the configured game endpoints
node pinglab.mjs --bloat       bufferbloat, download and upload
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

### The local API

The web server is one loopback port, and it treats every request as untrusted:

- **Token.** Every `/api/...` route — reads included — requires the per-run token the page was served with, in `X-PingLab-Token`. Missing or wrong is a 403 that says to reload; the comparison is constant-time, and a length mismatch is refused before the comparison so it cannot throw.
- **Origin.** Every `POST` must also carry this exact page's `Origin`, checked before the body is read, and must be `application/json`. A form on another site can therefore not reach a state-changing route at all.
- **Host.** A `Host` other than `127.0.0.1`, `localhost` or `[::1]` on this port is a 421 on every route. That is what stops a hostile domain pointed at loopback (DNS rebinding) from reading the page and its token.
- **Input.** Bodies are capped at 2 MB and must be JSON objects. Each value is checked where it is used: endpoint hosts and ports, the bufferbloat host, duration and direction, soak minutes and interval, DNS servers, the tweak action and adapter alias. A value that would be resolved, connected to or written into a script is refused when it is out of range, never silently clamped into something else.
- **Errors.** A refusal names the rejected field and nothing else; an internal failure is logged with the token redacted and answered with a fixed sentence, so parser text, file paths and stack traces never reach the browser. A request Node's own parser rejects gets the app's 400 with the same security headers, rather than Node's bare default.

## Settings you can change

Nothing here is applied at startup, and **every setting is off by default**: the `default` column below is checked by `--self-check`, so no future edit can quietly make one of them aggressive.

| setting | risk | what it changes | what it trades | undo |
|---|---|---|---|---|
| **Wireless power saving (power plan)** | safe | `powercfg` AC/DC index for *Wireless Adapter Settings → Power Saving Mode* set to `0` = maximum performance, for the active scheme | *battery*: the radio stops stepping down to save power, so a laptop loses some runtime; *latency*: no more 10–50 ms spikes when the radio wakes mid-fight | the recorded AC/DC values are written back (restore-all also drops the per-scheme override when it matches the scheme default) |
| **NIC power management (device)** | safe | `Disable-NetAdapterPowerManagement` for the adapter | *battery*: Windows can no longer park the device while idle; *stability*: removes the missed first packets after the card wakes. Many Wi-Fi drivers expose no such setting — the row then says "not available" instead of pretending | the setting is re-enabled, but only if PingLab was the one that disabled it |
| **Nagle's algorithm (per adapter)** | **moderate** | `TcpAckFrequency=1`, `TCPNoDelay=1` under `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{adapter GUID}` | *latency*: small packets go out immediately, which is the shape of game and voice traffic; *throughput*: more, smaller packets — on a saturated or high-latency uplink this can cost a little bandwidth and CPU, and it bypasses Windows' delayed-ACK timer for this adapter only | the recorded values are written back; keys that did not exist before are removed again |
| **Wi-Fi radio power save (driver properties)** | **experimental** | driver properties `MIMOPowerSaveMode=3` (No SMPS) and `RoamAggressiveness=0` (Lowest) — a hardware property, not a Windows preference | *battery*: both streams stay awake; *stability*: the card holds the current AP until the link drops (good with one router, bad on a mesh). Measured across repeated soaks here: **no gain**, which is why it is experimental and in no preset | the values the driver reported before the write are written back and verified |
| **Wi-Fi auto-connect order** | safe | `netsh wlan set profileorder` moves the profile of the network you are *currently joined to* to priority 1 | *stability*: after an adapter reset Windows rejoins that network instead of whichever saved network is first; the cost is that a deliberately different order is overridden until you restore | the exact previous precedence is replayed and read back; profiles deleted since are left out, never recreated |
| **DNS servers on this adapter** | **moderate** | `Set-DnsClientServerAddress` with the resolver that won the benchmark, or ones you type in | *page loads and sign-ins*: usually faster; *privacy*: queries go to the resolver you pick; *stability*: anything local in your router's DNS (Pi-hole, `.lan`/`.home` names, some captive portals) stops resolving unless you point at the router. Does not change in-game ping | the adapter goes back to DHCP-provided DNS when that is where its servers came from; a static DNS configuration is written back exactly as recorded. Both are read back, and *Restore everything* follows the same rule. |

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

The elevated script never touches disk. The app opens a private one-shot pipe, passes its random name to the elevated PowerShell, and sends the script text down it once that process has connected; the result returns on the same pipe and is accepted only with the nonce from that call. Up to 1.0.11 the script was written to `data\tmp\<id>.ps1` and that path was handed to Windows — a file the same user could replace between the write and the admin prompt, in which case the replacement ran with administrator rights. There is no such file to replace now, and a call that cannot open its pipe changes nothing rather than falling back to one.

Three test hooks make these paths checkable without clicking a prompt; none of them does anything unless the variable is set:

- `PINGLAB_ELEVATION=cancel` or `refuse` — every elevated call returns as if the prompt had been closed or refused, writing nothing.
- `PINGLAB_PS_STUB=<path to lib/ps-fake.mjs>` (+ `PINGLAB_PS_SCENARIO`, `PINGLAB_PS_LOG`) — replaces every PowerShell call with a fake Windows that answers the real scripts, used by `lib/tweaks.test.mjs` to exercise apply and revert without elevation.
- `PINGLAB_DNS_STUB=quad9` (any id from `lib/dns.mjs`) — the DNS benchmark returns a deterministic run where that resolver clearly wins, so the "write the winner" path can be proven on a network where the real resolvers are within noise.
- `PINGLAB_DATA_DIR=<folder>` — where restore points, history and transient files go. The tests point it at a throwaway directory, so a test run never touches the real data folder.
- `PINGLAB_BACKUP_DELAY_MS=<ms>` — pauses inside the locked restore-point write, so `lib/concurrency.test.mjs` can make two processes collide on purpose. It only widens the critical section; there is no retry hiding behind it.
- `PINGLAB_BACKUP_LOCK_WAIT_MS=<ms>` — shortens the wait for the restore-point lock, so the test can reach the honest "another PingLab action is writing restore points" failure.

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

- **Which DNS resolver to use.** The app measures and recommends; you decide. Only a resolver that answered **every** one of the ten probes can win: a resolver that dropped even one lookup is shown in the table with its missed count and is never offered, however low its median. Among the reliable ones a winner needs a median lead of at least 10% **and** wins at least 70% of the head-to-head probes. Otherwise the message says which resolver led and why that is noise (or which fast resolver missed lookups), and DNS is left alone.
- **Wi-Fi channel and band.** Co-channel and adjacent-channel interference, and which 5 GHz channels look free, are reported from the scan Windows returns, and every count is worded as a statement about that scan ("visible", "in this scan") rather than about the air. PingLab now also asks Windows for a scan itself: a small C# shim (`Add-Type`, `lib/wlan-shim.mjs`) calls `WlanScan` and waits for WLAN AutoConfig's `wlan_notification_acm_scan_complete` **before** reading `netsh`, so the result can say when the scan finished — "Windows confirmed a scan finished 412 ms after PingLab asked for one, and this list was read straight after" — instead of only reporting what `netsh` returned. That dates the scan, not every network in it, so it is still not a claim that each visible access point is live. The wait is bounded (6 s by default, clamped to 1–15 s) and the shim is optional: when it cannot be loaded, Windows refuses the scan (usually Location services off) or no completion arrives, the app falls back to the old behaviour — reads the list and says there is no confirmation, so **no fresh-or-cached verdict is claimed**. An earlier build guessed freshness from the number of visible networks: two or fewer meant "cached", so it opened the network flyout, waited, re-read, and withheld every count-based line. On a quiet two-network home that invented a stale scan; on a stale five-network list it said "refreshed" for a re-read it could not date. There is no such threshold any more, and freshness is never inferred from the list. Signal is called what Windows reports — a coarse quality percentage, not a speed — and the app never invents an adapter limit ("2x2, 20 MHz, 144 Mbps") or assumes which visible access point is your router. A channel both 5 GHz and 6 GHz use (36–177) whose `Band` line Windows omitted is reported as **unknown**, never as 5 GHz, and is counted in neither band.
- **A game's UDP latency.** PingLab times TCP handshakes and, as an independent cross-check, ICMP echo. When the two disagree the app says which gap is connection setup, and it never calls either one "your game ping": games send UDP, and timing that path needs the game's own server. A TCP port that refuses connections while ICMP answers is reported as a blocked port, not a dead network; ICMP that never answers is reported as blocked, not as 100% packet loss.
- **Router-side settings** (QoS, SQM, band steering) and **ISP plans.** Out of scope by design; anything claiming a network speed-up from registry edits is not in this tool.
- **Windows Location services**, needed for Wi-Fi detail on Windows 11. The web UI can open the settings page for you; the app does not flip the switch.

## Undoing things

- **One setting:** press its key in the terminal, its button in the GUI, or its button in the web UI. The inverse is always derived from the stored backup, never from a default.
- **Everything:** `R` in the terminal, *Restore everything PingLab changed* in the GUI, `node pinglab.mjs --restore`, or the *Restore everything* button in the web UI. One elevation prompt restores every recorded setting to the values captured before PingLab touched them, then clears the restore points it has proven came back; the change history stays, so what was applied and reverted is still visible afterwards.
- If a restore does not read back as recorded (for example a profile was deleted in the meantime), the restore point is **kept** and the result says what disagreed, so you can retry rather than losing the original values.
- **Verified, not assumed.** Every write is read back afterwards (registry values, `powercfg` indices, driver properties, DNS server list, the netsh precedence list). If the read-back disagrees, the change is reported as failed, not as done.
- **Checked again later, not only at the moment of the change.** A restore point records that PingLab changed a setting; the live state says what Windows reports now, and the two are compared. When something else puts a setting back — a Windows or driver update resetting NIC power management, a switch to another power plan (the row is written to the active scheme), an adapter that comes back with a new GUID, DHCP handing the router's DNS back — the fixes view, the GUI's Fixes tab, the page and `--audit` say so with the same sentence, and applying that row again puts it back. Nothing is re-applied on its own, and a reading that cannot settle the question (a deleted Wi-Fi profile, an unreadable plan value, a DNS list neither side recognises) is reported as unknown instead of counted as drift.

Restore points live in `backups.json` inside PingLab's data folder — `%LOCALAPPDATA%\PingLab` for an installed copy, `data\` in a source checkout — and `node pinglab.mjs --audit` prints them under "restore points". A count of 0 means the machine is at its original values.

**One record, whoever writes it.** The terminal app, the GUI, the web page and a soak test can all be running at once, and they share one data folder. Every change to `backups.json` takes an exclusive lock (`.backups.lock`, created beside it), reads the file fresh under that lock, merges its own change and replaces the file atomically — so two changes landing together leave two restore points instead of one. A second action waits a moment for the lock; if it is still held, it says `Another PingLab action is writing restore points. Try again in a moment.` and changes nothing rather than overwriting the first. The history database runs in WAL mode with a busy timeout, and a write that still meets a busy database is retried, so two processes recording measurements at the same time both keep their rows; a database another process is merely writing is waited for, never set aside as damaged.

## Files it writes

The program folder is never written to, so an uninstall can remove it completely. Everything PingLab keeps lives in one data folder: `%LOCALAPPDATA%\PingLab` for an installed copy, `data\` beside the code in a source checkout, or wherever `PINGLAB_DATA_DIR` points.

- `backups.json` — restore points and the change history. Each apply saves its restore point here *before* Windows is touched, and the file is replaced atomically (written to a temporary file, flushed, then renamed), so an interrupted write leaves the previous restore points intact. Keep it if you have changes applied. If it is ever unreadable, PingLab treats its contents as unknown rather than empty: nothing is applied or reverted, the original is never overwritten, a copy is kept as `backups.corrupt-<time>.json` beside it, and `--audit`, `--self-check`, the fixes view and the GUI all say so.
- `pinglab.sqlite` — probe, DNS and soak history. It runs in WAL mode, so while it is open Windows also shows `pinglab.sqlite-wal` and `pinglab.sqlite-shm` beside it. If it is ever unreadable (not a database at all), PingLab starts anyway: the file is moved aside as `pinglab.corrupt-<time>.sqlite`, an empty database takes its place, and the terminal dashboard, `--audit`, `--self-check`, the GUI's status row and the web page all say so instead of the app dying at startup.
- `bridge-out.*.jsonl`, `.backups.lock` — transient files used by the GUI bridge and the restore-point lock. The lock exists only while a change is being recorded. A `tmp\` folder is only leftover scratch from a version before 1.0.12, whose elevated calls ran a script file from there; current versions write no file for elevation.
- `gui.log` — the GUI's start-up log.

An upgrade replaces programs only, so all of this survives it. A copy installed before 1.0.3 kept these files in `<install>\data`; the first run copies the restore points and the database into the per-user folder, deletes the transient files that folder had accumulated, and then removes the folder itself — so restore points survive the upgrade, nothing is left stranded in the install folder, and an uninstall can remove that folder completely. Uninstalling leaves the data folder in place: it is your record of what the machine looked like, not program files.

Deleting the database resets history; deleting `backups.json` while changes are applied means PingLab can no longer undo them.

## Development

- `lib/catalog.mjs` is the single description of every setting: label, what it changes, what it trades, risk, Windows default, how it is undone, which preset includes it. The TUI, the GUI and the web UI all render from it — add a setting there and each surface picks it up. `validateCatalog()` enforces that every entry has a description, a trade-off, a risk, an undo and `default: "off"`, and that no preset contains an experimental setting.
- `lib/tweaks.mjs` is the single dispatch table (`runTweakAction`) plus `applyPreset`, which walks a preset through that same table. `lib/tweaks.test.mjs` drives `runTweakAction`, `applyPreset` and `restoreAll` against `lib/ps-fake.mjs` (a fake Windows loaded through `PINGLAB_PS_STUB`) and pins applied / already-in-place / unavailable / refused / failed-after-write / reverted / restored, including the restore point each one leaves behind — run it with `node lib/tweaks.test.mjs`.
- `lib/state-cache.mjs` is the short-lived cache in front of `GET /api/state`. A state read pays for several PowerShell processes and the settings change only when someone acts, so a repeat within five seconds is served without reading the machine; after that the old value is served once while one background read refreshes it, and beyond two minutes the read is awaited. Every apply, revert, restore, probe, endpoint save and soak action invalidates it, and a read that started before a change can never install its old answer. `lib/state-cache.test.mjs` proves the fresh hit (with zero PowerShell calls), the TTL refresh, single flight, and — running the real server against a file-backed fake Windows — that applying a tweak is reflected by the very next state read; run it with `node lib/state-cache.test.mjs`.
- `node pinglab.mjs --self-check` is the check to run after touching any of this: it validates the catalog and presets, compares every catalog action against the dispatch table, reads each setting from Windows, and compares the app's claim with what Windows reports. It exits non-zero on any disagreement, and changes nothing.
- `node pinglab.mjs --audit` is the same comparison with more detail per row.
- `lib/backup-lock.mjs` is the one lock around `backups.json`: an exclusive-create file with a bounded wait, a stale lock broken only when its owner is gone or it has outlived any plausible write, and a release in a `finally`, so a write that fails cannot leave the file locked. `lib/concurrency.test.mjs` spawns two real child processes that start through a barrier and asserts that both restore points survive, that the file parses on every read taken mid-write, that a blocked worker gets the lock sentence and changes nothing, that two processes inserting soak samples both keep every row, and that a `backups.json` written by 1.0.10 loads unchanged — run it with `node lib/concurrency.test.mjs`. The atomic replace retries a brief Windows sharing violation (`EPERM`/`EBUSY`/`EACCES`) for up to a second: a reader in another surface can otherwise make a correct write fail, and the suite's 5 ms reader is what caught history entries being dropped that way. A lock that stays held still fails with the honest sentence.
- `lib/api-input.mjs` is the API's validation layer, and `lib/api-hardening.test.mjs` walks the whole HTTP surface the way an attacker would: every route without a token and with a wrong one, every POST with a missing or foreign Origin and a non-JSON body, every route with a foreign Host, unexpected methods, malformed and `null` and oversized bodies, 40-endpoint lists, option-shaped hosts and durations, traversal attempts, and a malformed request line — plus the page, its asset and its normal calls, so hardening that breaks the app fails the test. `lib/api-input.test.mjs` pins the boundaries of each rule. Run them with `node lib/api-input.test.mjs` and `node lib/api-hardening.test.mjs`.
- `lib/elevation-channel.mjs` is how an elevated script reaches administrator PowerShell: a named pipe this process owns, the script sent as a length-framed UTF-8 message once the elevated side has connected, and the result returned on the same pipe with a per-call nonce. Nothing is written to disk, so there is no path to replace between writing and elevation. `lib/elevation-channel.test.mjs` runs the real bootstrap through `powershell.exe` without the UAC hop and pins that the script never appears as a file, that a planted `.ps1` / `.out.json` in the data folder is never run or read, that a missing channel fails closed, and that another call's result is discarded — run it with `node lib/elevation-channel.test.mjs`.
- `lib/db.mjs` owns the history database and the rule that a damaged one is never fatal: it moves the file aside, starts a fresh one and reports it through `dbStatus()`. It opens in WAL mode with a busy timeout and retries a write that still meets a busy database, so a second process recording a soak cannot lose a sample; a database another process is merely writing is waited for, never moved aside as damaged. `lib/db.test.mjs` feeds it a text file where the database should be and pins that every surface can still start, write and read history, and that a second run with the same bytes reuses the copy — run it with `node lib/db.test.mjs`.
- `lib/db-warning.test.mjs` starts the real `server.mjs`, the GUI's bridge and `node pinglab.mjs --once` against a data folder holding a text file where `pinglab.sqlite` belongs, and requires `/api/state`, the bridge's `state` answer and the rendered dashboard to report it — those are what the page, the status row and the terminal draw from, so the warning cannot disappear from a normal start-up path again. Run it with `node lib/db-warning.test.mjs`.
- `lib/drift.mjs` compares the restore points with the live state and names a setting PingLab changed that Windows has since put back — with one sentence every surface prints, because the terminal, the GUI's Fixes tab, the page and `--audit` draw it from here. `lib/drift.test.mjs` drives it on the fake Windows: reverted, in place and unknown for every setting, plus a switched power plan that is still at maximum (not drift), a changed adapter GUID and a DNS list somebody else chose — run it with `node lib/drift.test.mjs`.
- `lib/keep-unreadable.mjs` is the one rule for putting a file that cannot be read aside: `<name>.corrupt-<time><suffix>` beside it, one copy per distinct broken file, and a file another instance has locked reported instead of worked around. `lib/db.mjs` uses it in move mode (the name has to be free for the fresh database), `lib/tweaks.mjs` in copy mode (a broken `backups.json` is never overwritten).
- `lib/dns.mjs` holds the resolver benchmark and the verdict rule, including the reliability gate: only a resolver that answered every lookup is rankable, and a faster resolver that missed one is named in the verdict rather than quietly promoted. `lib/dns-verdict.test.mjs` drives the reliability, noise, tie and 10% / 70% boundaries with fixed inputs — run it with `node lib/dns-verdict.test.mjs`.
- `lib/probe.mjs` turns raw round-trips into the figures every surface prints. Jitter there is the mean absolute difference between *consecutive* samples, measured before anything is sorted; `lib/probe-math.test.mjs` pins that order along with loss, the percentiles, the ICMP latency/jitter cross-check and the blocked-ICMP distinction — run it with `node lib/probe-math.test.mjs`. The same module owns bufferbloat in three modes (`down`, `up`, `both` sequentially, `duplex` at once); `lib/bufferbloat.test.mjs` runs the real download and upload saturators against a local HTTP server, including a blocked upload that must report "not measured" instead of a grade — run it with `node lib/bufferbloat.test.mjs`.
- `lib/report.mjs` is the single source for the sentences and selectors more than one surface prints: the DNS winner and verdict, the bufferbloat grade meaning, and the TCP-versus-ICMP explanation. `lib/report.test.mjs` pins them, so the page cannot offer a resolver the rule refused or read a field the benchmark never produced — run it with `node lib/report.test.mjs`.
- `installer/build.ps1` builds the release artifacts into `dist/`: the portable zip, the Inno Setup installer (`installer/pinglab.iss`, per-user, Node checked in `[Code]`) and `SHA256SUMS.txt`. It picks the version from `package.json` unless you pass `-Version`. The icon comes from `installer/make-icon.ps1` and is committed, so a normal build does not redraw it.
- `.github/workflows/release.yml` builds and attaches those files to a GitHub release for every tag shaped like `v1.2.3`, or on demand for an existing tag. The tag's version is passed to `build.ps1`, so the installer, the zip and the release all carry the same number.

## Limits

- Windows only, and localized `netsh` output is parsed — the profile list is found by its dashed section headers rather than by English keywords, but unusual formats make the row refuse to act instead of guessing.
- The auto-connect row needs a wireless adapter, at least one saved profile and a current connection; with no profiles, no joined network, or no profile matching the SSID it says exactly that and changes nothing. If a profile recorded in a backup has since been deleted, restore leaves it out rather than recreating it.
- One UAC prompt per setting; a preset asks once per step it needs. A dismissed prompt is reported as "nothing changed", never as success, and stops the remaining steps instead of asking again.
- The bufferbloat test needs Cloudflare's speed-test endpoint for downloads and uploads. If a network blocks it, that direction reports "not measured" with the reason instead of grading an idle line.
- No installer, no license file, no telemetry. Copy the folder, install Node, run it.
