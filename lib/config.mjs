import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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

export async function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return { endpoints: DEFAULT_ENDPOINTS };
    const parsed = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    const endpoints =
      Array.isArray(parsed.endpoints) && parsed.endpoints.length ? parsed.endpoints : DEFAULT_ENDPOINTS;
    return { ...parsed, endpoints };
  } catch {
    return { endpoints: DEFAULT_ENDPOINTS };
  }
}

export async function saveConfig(config) {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
