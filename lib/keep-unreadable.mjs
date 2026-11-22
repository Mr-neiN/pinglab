/**
 * Put one unreadable file aside without ever losing its bytes.
 *
 * Two files can be damaged by the same accident - a half-written file, a disk that ran out of
 * space, something edited by hand - and both places that read them need the same answer:
 * never start over silently, never delete the only record, never crash while doing it.
 * `lib/db.mjs` (a `pinglab.sqlite` that is not a database) and `lib/tweaks.mjs` (restore
 * points that are not valid JSON) each carried a copy of this rule; this is the only copy,
 * so the naming, the dedupe and the way a locked file is reported cannot drift apart.
 *
 * The rules, in order:
 *   name         `<stem>.corrupt-<YYYYMMDD-HHMMSS><suffix>` beside the original, with `-2`,
 *                `-3` added when that name is taken. This app never reads those names back.
 *   dedupe       the same bytes are never stored twice: a copy that already holds them is
 *                reused instead of filling the folder with identical files.
 *   never fatal  a file that cannot be read, a copy that cannot be made (locked by another
 *                instance, folder not writable) comes back as `error`, never as a throw.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const failure = (err) => ({ ok: false, name: null, path: null, error: String(err?.code || err?.message || err) });

/**
 * @param {string} file  the file that could not be read
 * @param {object} opts
 * @param {string} opts.suffix       what the copy keeps, e.g. ".sqlite": the original's name
 *                                   up to that suffix becomes the copy's stem
 * @param {"move"|"copy"} [opts.mode] "move" frees the original name for the fresh file that
 *                                   replaces it; "copy" leaves the original in place, for a
 *                                   caller that refuses to overwrite it
 * @returns {{ok: boolean, name: string|null, path: string|null, error: string|null, reused: boolean}}
 */
export function keepUnreadableAside(file, { suffix, mode = "copy" } = {}) {
  const dir = dirname(file);
  const stem = basename(file, suffix);

  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    return failure(err);
  }

  try {
    const copies = readdirSync(dir)
      .filter((n) => n.startsWith(`${stem}.corrupt-`) && n.endsWith(suffix))
      .sort();
    for (const name of copies) {
      try {
        const prev = readFileSync(join(dir, name));
        if (prev.length === bytes.length && prev.equals(bytes)) {
          // The bytes are already safe under `name`. In move mode the original name is then
          // free for its replacement; if it cannot be removed, the fall-through below tries
          // to move it again and reports that instead.
          if (mode === "move") rmSync(file, { force: true });
          return { ok: true, name, path: join(dir, name), error: null, reused: true };
        }
      } catch {
        /* an unreadable copy is no reason to stop looking */
      }
    }
  } catch {
    /* the scan is best effort; the copy below is what matters */
  }

  const base = `${stem}.corrupt-${stamp(new Date())}`;
  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? `${base}${suffix}` : `${base}-${n}${suffix}`;
    if (existsSync(join(dir, name))) continue;
    try {
      if (mode === "move") renameSync(file, join(dir, name));
      else copyFileSync(file, join(dir, name));
      return { ok: true, name, path: join(dir, name), error: null, reused: false };
    } catch (err) {
      return failure(err);
    }
  }
  return { ok: false, name: null, path: null, error: "no free name for a copy", reused: false };
}
