import fs from "node:fs/promises";
import path from "node:path";

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Turns a work or chapter title into a single readable folder/file name.
 * Illegal characters are replaced, and the result is capped so long titles
 * cannot blow past the Windows path limit. `fallback` is used when a title is
 * empty or survives sanitising as nothing but dots and spaces.
 */
export const folderName = (value: string | undefined, fallback: string) => {
  const cleaned = (value ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  let name = [...cleaned].slice(0, 60).join("");
  name = name.replace(/[.\s]+$/, "").trim();
  if (!name) return fallback;
  return RESERVED.test(name) ? `_${name}` : name;
};

/** Returns `base`, or `base (2)`, `base (3)`… while the path is already taken. */
export const claimPath = (base: string, taken: Set<string>) => {
  let candidate = base;
  for (let index = 2; taken.has(candidate.toLowerCase()); index++)
    candidate = `${base} (${index})`;
  taken.add(candidate.toLowerCase());
  return candidate;
};

/**
 * Moves a folder, copying across volumes when `rename` cannot. Missing sources
 * resolve to `false` so callers can still repair their stored path.
 */
export const movePath = async (from: string, to: string) => {
  if (from === to) return true;
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    if (error?.code !== "EXDEV") throw error;
    await fs.cp(from, to, { recursive: true });
    await fs.rm(from, { recursive: true, force: true });
    return true;
  }
};

/** True when `candidate` is `folder` or lives inside it, in any separator case. */
export const insideFolder = (candidate: string, folder: string) => {
  const target = folder.replace(/\\/g, "/").toLowerCase(),
    value = candidate.replace(/\\/g, "/").toLowerCase();
  return value === target || value.startsWith(`${target}/`);
};

/**
 * Removes empty folders from `from` upwards, stopping at (and never removing)
 * the download root, so deleting the last chapter of a work also drops the
 * empty work and source folders.
 */
export const pruneEmptyFolders = async (from: string, root: string) => {
  if (!root || !from) return;
  let folder = from;
  for (;;) {
    const relative = path.relative(root, folder);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      return;
    try {
      await fs.rmdir(folder);
    } catch {
      return;
    }
    folder = path.dirname(folder);
  }
};
