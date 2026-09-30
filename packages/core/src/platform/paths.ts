/**
 * Path helpers.
 *
 * Rules enforced here (see the cross-platform rules in the spec):
 *  - never hardcode `/` or `\` as a separator; always use `join` / `basename` / `dirname`
 *  - never assume case sensitivity
 *  - never assume a home directory
 * The host supplies the roots; this module only composes them.
 */

import type { PlatformInfo } from "./platform.js";

/** Join path segments using the platform separator. Does not touch the filesystem. */
export function joinPath(platform: PlatformInfo, ...segments: string[]): string {
  const parts: string[] = [];
  for (const raw of segments) {
    if (!raw) continue;
    const pieces = raw.split(/[\\/]+/);
    for (const piece of pieces) {
      if (piece === "" || piece === ".") continue;
      parts.push(piece);
    }
  }
  if (parts.length === 0) return "";
  const sep = platform.sep;
  // Preserve a leading separator for absolute-looking paths (POSIX root, UNC, drive-relative).
  const first = segments[0] ?? "";
  const isUnc = first.startsWith("\\\\") || first.startsWith("//");
  // A Windows drive is its own root: `C:\x`, never `\C:\x`.
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "") ? parts[0] : null;
  const isAbsolute = drive !== null || /^[\\/]/.test(first) || /^[A-Za-z]:[\\/]/.test(first);
  const tail = drive === null ? parts : parts.slice(1);
  const body = tail.join(sep);
  if (isUnc) return `\\\\${body}`;
  if (drive !== null) return body ? `${drive}${sep}${body}` : `${drive}\\`;
  if (isAbsolute) return `${sep}${body}`;
  return body;
}

export function basename(path: string, platform?: PlatformInfo): string {
  const sepPattern = platform?.sep === "\\" ? /\\+/ : /[\\/]+/;
  const trimmed = path.replace(/[\\/]+$/, "");
  const pieces = trimmed.split(sepPattern);
  return pieces[pieces.length - 1] ?? "";
}

export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}

export function dirname(path: string, platform: PlatformInfo): string {
  const sepPattern = platform.sep === "\\" ? /\\+/ : /[\\/]+/;
  const pieces = path.split(sepPattern).filter((p) => p !== "");
  if (pieces.length <= 1) return ".";
  pieces.pop();
  if (pieces.length === 0) return platform.sep;
  const body = pieces.join(platform.sep);
  return /^[A-Za-z]:$/.test(pieces[0] ?? "") ? body : `${platform.sep}${body}`;
}

export function isAbsolutePath(path: string, platform: PlatformInfo): boolean {
  if (platform.os === "windows") {
    return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
  }
  return path.startsWith("/");
}

export function resolvePath(platform: PlatformInfo, base: string, target: string): string {
  if (isAbsolutePath(target, platform)) return joinPath(platform, target);
  return joinPath(platform, base, target);
}

/**
 * Normalise a path for comparison. Collapses separators, resolves `.`/`..`
 * textually, and lower-cases on case-insensitive platforms.
 */
export function normalizePath(path: string, platform: PlatformInfo): string {
  const sep = platform.sep;
  const unc = path.startsWith("\\\\") || path.startsWith("//");
  const driveMatch = /^([A-Za-z]):[\\/]/.exec(path);
  const drive = driveMatch?.[1] ? `${driveMatch[1].toUpperCase()}:` : "";
  const rest = driveMatch ? path.slice(driveMatch[0].length) : path;

  const out: string[] = [];
  for (const piece of rest.split(/[\\/]+/)) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "..") out.pop();
      else if (!drive && !unc) out.push("..");
      continue;
    }
    out.push(piece);
  }
  const body = out.join(sep);
  // A POSIX absolute path keeps its root: `/a/c`, never `a/c`.
  const posixAbsolute = path.startsWith("/") && !unc && !drive;
  const joined = unc
    ? `\\\\${body}`
    : drive
      ? `${drive}${sep}${body}`
      : posixAbsolute
        ? `${sep}${body}`
        : body;
  return platform.caseSensitivePaths ? joined : joined.toLowerCase();
}

/** True when `child` is `parent` or lives beneath it. Both paths are normalised first. */
export function isPathInside(child: string, parent: string, platform: PlatformInfo): boolean {
  const c = normalizePath(child, platform);
  const p = normalizePath(parent, platform);
  if (c === p) return true;
  const prefix = p.endsWith(platform.sep) ? p : `${p}${platform.sep}`;
  return c.startsWith(prefix);
}

export function relativePath(from: string, to: string, platform: PlatformInfo): string {
  const fromParts = normalizePath(from, platform).split(platform.sep).filter(Boolean);
  const toParts = normalizePath(to, platform).split(platform.sep).filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.length - i;
  const tail = toParts.slice(i);
  const segs = [...Array<string>(up).fill(".."), ...tail];
  return segs.join(platform.sep) || ".";
}

/** Quote a path for the host shell. Single quotes on POSIX, double quotes elsewhere. */
export function shellQuote(value: string, platform: PlatformInfo): string {
  if (platform.os === "windows") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
