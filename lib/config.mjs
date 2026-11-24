import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import { endpointList } from "./api-input.mjs";
import { keepUnreadableAside } from "./keep-unreadable.mjs";
import { dataPath } from "./paths.mjs";

const CONFIG_FILE = dataPath("config.json");

/** Endpoints probed when the user has not customised data/config.json. */
export const DEFAULT_ENDPOINTS = [
  { id: "riot", label: "Riot / Valorant EUW", host: "euw1.chat.si.riotgames.com", port: 443, kind: "game" },
  { id: "battlenet", label: "Battle.net EU", host: "eu.actual.battle.net", port: 1119, kind: "game" },
  { id: "discord", label: "Discord gateway", host: "gateway.discord.gg", port: 443, kind: "game" },
  { id: "steam", label: "Steam", host: "steamcommunity.com", port: 443, kind: "game" },
  { id: "epic", label: "Epic / Fortnite", host: "epicgames.com", port: 443, kind: "game" },
  { id: "cloudflare", label: "Cloudflare DNS", host: "1.1.1.1", port: 443, kind: "dns" },
  { id: "google", label: "Google DNS", host: "8.8.8.8", port: 443, kind: "dns" },
  { id: "quad9", label: "Quad9 DNS", host: "9.9.9.9", port: 443, kind: "dns" },
];

/**
 * Why a settings file that could not be used is reported instead of swallowed.
 *
 * This was the one unreadable file the app still hid: a malformed or wrong-shaped
 * config.json read back as the built-in defaults with nothing said on any surface, and the
 * next endpoint save then replaced the user's file with those defaults. It now follows the
 * rule a damaged backups.json and pinglab.sqlite already follow - the bytes are kept beside
 * it as `config.corrupt-<time>.json`, the reason travels to the page, the GUI, the terminal
 * and the API in `problem` (the shape dbStatus() reports), and the app keeps working from
 * the built-in endpoints in the meantime. A read never modifies the live file.
 *
 * What comes out of the file is checked with the API's own rule (`endpointList`), never a
 * second copy of it. The save path already stores only what that rule accepts, so a file
 * edited by hand, cut short by a crash, or written by an older version cannot sneak an
 * endpoint past the probe - and "saveConfig wrote it" is not evidence that it is usable.
 */

function broken(reason) {
  // Copy, never move: the live file is left exactly as it is, so even a bug in this module
  // cannot destroy settings. keepUnreadableAside never throws and never stores the same
  // bytes twice.
  const kept = keepUnreadableAside(CONFIG_FILE, { suffix: ".json", mode: "copy" });
  const where = kept.ok
    ? `The file was kept as ${kept.path}, so nothing you wrote was lost.`
    : `A copy could not be made either (${kept.error}), so the file was left exactly as it is.`;
  return {
    file: CONFIG_FILE,
    detail: reason,
    copy: kept.path,
    message: `${CONFIG_FILE} ${reason}, so the endpoint list in it was not used. ${where}`,
  };
}

/** The endpoints the file holds, or the sentence that says why it holds none. */
function endpointsOf(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "does not hold a settings object" };
  }
  if (!Object.hasOwn(parsed, "endpoints")) return { reason: "has no endpoints list" };
  try {
    return { endpoints: endpointList(parsed.endpoints) };
  } catch (err) {
    return { reason: `does not hold an endpoint list the API accepts (${String(err?.message || err).trim()})` };
  }
}

/**
 * The persisted endpoint list, and why a file holding one could not be used.
 * `problem` is null for a normal read (including a missing file, which is a first run).
 */
export async function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { endpoints: DEFAULT_ENDPOINTS, problem: null };

  let text;
  try {
    text = await readFile(CONFIG_FILE, "utf8");
  } catch (err) {
    // Gone between the check and the read: still a first run, not a damaged file.
    if (err?.code === "ENOENT") return { endpoints: DEFAULT_ENDPOINTS, problem: null };
    const detail = String(err?.message || err).split("\n")[0].trim() || err?.code || "could not be read";
    return { endpoints: DEFAULT_ENDPOINTS, problem: broken(`could not be read (${detail})`) };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { endpoints: DEFAULT_ENDPOINTS, problem: broken("is not valid JSON") };
  }

  const { endpoints, reason } = endpointsOf(parsed);
  if (reason) return { endpoints: DEFAULT_ENDPOINTS, problem: broken(reason) };
  return { endpoints, problem: null };
}

/**
 * Store the endpoint list. Only what loadConfig reads is written, and it is validated first:
 * the app must not be able to produce a settings file its own loader would refuse, or the
 * next start would report a problem the user never caused. A refused save writes nothing.
 */
export async function saveConfig(config) {
  const endpoints = endpointList(config?.endpoints ?? []);
  await writeFile(CONFIG_FILE, `${JSON.stringify({ endpoints }, null, 2)}\n`, "utf8");
}
