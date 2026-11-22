/**
 * Where PingLab writes what it keeps.
 *
 * Up to 1.0.2 the app wrote into `<app>\data`, so an uninstall could not remove the folder
 * the installer had created: the restore points and the database stayed behind and stranded
 * the directory. The install folder now stays exactly as the installer left it, and the data
 * lives in a stable per-user folder that an upgrade replaces nothing in and an uninstall
 * leaves alone (it is the user's record of what their machine looked like, not program
 * files).
 *
 * Which folder, in order:
 *   PINGLAB_DATA_DIR  an explicit folder - the tests point this at a throwaway one
 *   source checkout   `<repo>\data`, which is what the developer docs describe
 *   anything else     `%LOCALAPPDATA%\PingLab` (or the platform's per-user data folder)
 *
 * An installed copy that still carries the old `<app>\data` has its files copied across once
 * - a restore point is the only way back from a change, so an upgrade must carry them over -
 * and the old copies are removed so the install folder can be deleted cleanly.
 */
import { copyFileSync, existsSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder the app was unpacked into: `<app>/lib/paths.mjs` -> `<app>`. */
export const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The files 1.0.2 and earlier kept beside the program. */
const LEGACY_FILES = ["backups.json", "pinglab.sqlite", "config.json"];

function perUserDir() {
  const base =
    process.env.LOCALAPPDATA ||
    process.env.XDG_DATA_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "share") : null);
  return base ? join(base, "PingLab") : null;
}

/**
 * Take over an old in-install data folder, once. The copy is what matters: a file that could
 * not be copied (locked by another instance, say) is left where it is rather than deleted,
 * and the folder simply survives that uninstall instead of losing a restore point.
 */
function adoptLegacy(legacy, target) {
  if (resolve(legacy) === resolve(target) || !existsSync(legacy)) return;
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    return; // nowhere to put it: leaving the old folder alone is the safe outcome
  }
  for (const name of LEGACY_FILES) {
    const from = join(legacy, name);
    const to = join(target, name);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      copyFileSync(from, to);
      rmSync(from, { force: true });
    } catch {
      /* see above: never delete what was not copied */
    }
  }
  try {
    rmdirSync(join(legacy, "tmp")); // the elevated-call scratch folder, if it is empty
  } catch {
    /* still in use, or holds something we did not put there */
  }
  try {
    rmdirSync(legacy);
  } catch {
    /* not empty: the installer's uninstaller will report it, nothing is lost */
  }
}

function pickDataDir() {
  const override = process.env.PINGLAB_DATA_DIR;
  if (override) return resolve(override);
  // A checkout keeps its data beside the code. Nothing is installed there, so the rule that
  // matters for installations does not apply, and `node pinglab.mjs` from the repo behaves
  // as the docs say it does.
  if (existsSync(join(APP_ROOT, ".git"))) return join(APP_ROOT, "data");
  const own = perUserDir();
  if (!own) return join(APP_ROOT, "data"); // no profile folder to use: better than failing
  adoptLegacy(join(APP_ROOT, "data"), own);
  return own;
}

/** The folder holding backups.json, pinglab.sqlite, config.json and transient files. */
export const DATA_DIR = pickDataDir();
mkdirSync(DATA_DIR, { recursive: true });

/** Full path of a file PingLab keeps, so no caller rebuilds the folder itself. */
export const dataPath = (name) => join(DATA_DIR, name);
