/**
 * Which folders a file tool is allowed to touch.
 *
 * A path is authorized if it resolves inside *any* root on this list, and the
 * list has three possible sources: the folder the user opened for this
 * conversation, folders the user added in Settings, and -- once the user has
 * either approved the request or switched on autonomy -- folders the agent asked
 * for. All three end up in the same place, because a folder that is authorized
 * should behave identically afterwards no matter how it got there.
 *
 * What the model cannot do is widen the list on its own. It names a path; the
 * user, or the user's own autonomy setting, is what turns that into a root.
 *
 * The workspace comes first, and that order is load-bearing rather than
 * incidental. When a path lies inside more than one root -- a workspace of
 * `/home/me/project` with `/home/me/project/src` also allowed -- the first match
 * wins, so the path is reported relative to the workspace and the model's
 * follow-up calls keep working against the root it already knows about.
 */

import type { Settings } from "./schema.js";
import type { PlatformInfo } from "../platform/platform.js";
import { normalizePath } from "../platform/paths.js";

/**
 * The roots in effect for a conversation, most general first.
 *
 * Takes the two sources separately rather than a `Settings`, because not every
 * caller has one: the tool layer receives the roots already split into a
 * workspace and a list, and joining them back up through a settings object would
 * mean inventing one.
 *
 * Empty when there is no workspace and the user has added no folders, which the
 * tools report as "no folder open" rather than failing obscurely later.
 */
export function authorizedRoots(
  workspace: string | null | undefined,
  allowedFolders: readonly string[] | undefined,
): readonly string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [workspace, ...(allowedFolders ?? [])]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    // Compared with a trailing separator stripped, so `/home/me/project` and
    // `/home/me/project/` are one folder and not two roots that happen to be
    // equal -- which would otherwise make the same path resolve twice.
    const key = trimmed.replace(/[/\\]+$/, "");
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    roots.push(trimmed);
  }
  return roots;
}

/** True when the user has widened file access beyond the open workspace. */
export function hasAllowedFolders(settings: Settings): boolean {
  return (settings.files?.allowedFolders?.length ?? 0) > 0;
}

/**
 * Add a folder to the list, or return `null` when it is already there.
 *
 * `null` rather than the unchanged list, so a caller can tell "added" from
 * "already authorized" -- the agent asking twice is not a failure, and saying so
 * is more useful to it than an error would be.
 *
 * Compared through `normalizePath`, the same function `isPathInside` uses, rather
 * than by lower-casing. Those differ on Linux, where `/home/me/Code` and
 * `/home/me/code` are two real folders: case-folding them would drop the second
 * from the list and the agent would be told it was added when nothing changed.
 *
 * What is stored is the path as given, with only trailing separators removed.
 * The caller is expected to pass a canonical path from the host, and rewriting
 * the spelling here would store something the filesystem never confirmed.
 */
export function withFolder(
  allowedFolders: readonly string[],
  folder: string,
  platform: PlatformInfo,
): readonly string[] | null {
  const trimmed = folder.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const key = normalizePath(trimmed, platform);
  const already = allowedFolders.some(
    (existing) => normalizePath(existing.trim().replace(/[/\\]+$/, ""), platform) === key,
  );
  return already ? null : [...allowedFolders, trimmed];
}
