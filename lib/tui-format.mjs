/**
 * Terminal formatting: the ANSI palette, column padding that ignores escape codes, the number
 * and time helpers every view prints, and the small wrapping/boxing primitives.
 *
 * Pure string work, kept out of pinglab.mjs so the executable is about state and keys. `vis`
 * strips escapes, `pad`/`padL` measure with it, and every view builds its lines from these.
 */

export const R = "\x1b[0m";
export const B = "\x1b[1m";
export const D = "\x1b[2m";
export const RED = "\x1b[31m";
export const GRN = "\x1b[32m";
export const YEL = "\x1b[33m";
export const CYN = "\x1b[36m";
export const GRY = "\x1b[90m";
export const INV = "\x1b[7m";

export const vis = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const pad = (s, n) => {
  const t = String(s);
  const len = vis(t).length;
  return len >= n ? t : t + " ".repeat(n - len);
};
export const padL = (s, n) => {
  const t = String(s);
  const len = vis(t).length;
  return len >= n ? t : " ".repeat(n - len) + t;
};

export const n1 = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
export const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "—");
export const clock = (t) => {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export function colour(value, good, warn) {
  if (value === null || value === undefined) return GRY;
  if (value <= good) return GRN;
  if (value <= warn) return YEL;
  return RED;
}

export function box(title, lines, W) {
  const out = [` ${B}${title}${R}`];
  for (const l of lines) out.push("  " + l);
  return out;
}

export function kv(pairs, width = 13) {
  return pairs
    .filter(Boolean)
    .map(([k, v]) => `${D}${pad(k, width)}${R} ${v}`)
    .join("\n  ");
}

export function wrapText(text, width) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines;
}
