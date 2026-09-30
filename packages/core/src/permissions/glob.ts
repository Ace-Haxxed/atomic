/**
 * Glob matching for allow/deny lists.
 *
 * Deliberately small and predictable: `*` matches within a path segment, `**`
 * crosses segments, `?` is one character. Case-insensitive on platforms with
 * case-insensitive paths.
 */

import type { PlatformInfo } from "../platform/platform.js";

const cache = new Map<string, RegExp>();

export interface GlobOptions {
  readonly caseInsensitive?: boolean;
  /**
   * When true, `*` and `?` also match `/`. Command patterns need this
   * (`*rm -rf*` must match `sudo rm -rf /`); path patterns must not, or a
   * pattern like `*secrets*` would escape into sibling directories.
   */
  readonly crossSeparators?: boolean;
}

export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const key = `${options.caseInsensitive ? "i" : "s"}${options.crossSeparators ? "x" : ""}:${pattern}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const one = options.crossSeparators ? "[\\s\\S]" : "[^/\\\\]";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — consume the segment separator that follows, if any.
        i++;
        if (pattern[i + 1] === "/") i++;
        out += ".*";
      } else {
        out += `${one}*`;
      }
      continue;
    }
    if (char === "?") {
      out += one;
      continue;
    }
    if (char === "/") {
      out += "[/\\\\]";
      continue;
    }
    out += escapeRegExp(char);
  }
  const regex = new RegExp(`^${out}$`, options.caseInsensitive ? "i" : "");
  cache.set(key, regex);
  return regex;
}

/** True when `value` matches any pattern. An empty list never matches. */
export function matchesAnyGlob(
  value: string,
  patterns: readonly string[],
  options: GlobOptions = {},
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (!pattern) return false;
    // A bare substring entry (no wildcard) is treated as a prefix match so
    // "git" allow-lists every git subcommand. The next character must not be a
    // word character, so "git" does not match "gitk". A plain \b is wrong here:
    // it never matches after a trailing "/" or "-", which every command has.
    if (!pattern.includes("*") && !pattern.includes("?")) {
      const insensitive = options.caseInsensitive ? "i" : "";
      return new RegExp(`^${escapeRegExp(pattern)}(?![A-Za-z0-9_])`, insensitive).test(value);
    }
    return globToRegExp(pattern, options).test(value);
  });
}

export function globForPlatform(pattern: string, platform: PlatformInfo): RegExp {
  return globToRegExp(pattern, { caseInsensitive: !platform.caseSensitivePaths });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
