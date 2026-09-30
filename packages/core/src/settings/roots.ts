/**
 * Which folders a file tool is allowed to touch.
 *
 * A path is authorized if it resolves inside *any* root on this list, and the
 * list has exactly two possible sources: the folder the user opened for this
 * conversation, and folders the user added in Settings. There is deliberately no
 * third source. A model that could propose a root would be able to read anything
 * on the machine by asking for it, so the model never gets to name one -- it can
 * only name a path, and the path is checked against roots the user chose.
 *
 * The workspace comes first, and that order is load-bearing rather than
 * incidental. When a path lies inside more than one root -- a workspace of
 * `/home/me/project` with `/home/me/project/src` also allowed -- the first match
 * wins, so the path is reported relative to the workspace and the model's
 * follow-up calls keep working against the root it already knows about.
 */

import type { Settings } from "./schema.js";

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
