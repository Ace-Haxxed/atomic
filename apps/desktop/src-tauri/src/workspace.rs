// Path scoping.
//
// This is the security boundary for every file-touching tool. The rule is simple
// and absolute: a tool may only touch paths inside the workspace the user
// opened. Everything else -- `..`, absolute paths, symlinks pointing out,
// Windows drive and UNC escapes -- is refused here, in the native layer, where
// the real filesystem is visible.
//
// The checks are deliberately layered rather than clever:
//
//   1. Reject syntactically dangerous input before touching the disk.
//   2. Join against the root and canonicalize the *deepest existing ancestor*,
//      so a not-yet-created file still resolves.
//   3. Canonicalize the root too, and compare prefixes on path *components*.
//
// Comparing components rather than string prefixes matters: `/home/a` must not
// be treated as inside `/home/ab`. That mistake is the classic way a sandbox is
// escaped with a sibling directory.

use std::path::{Component, Path, PathBuf};

/// Why a path was refused. Carried to the tool layer so the model gets a
/// message it can act on, rather than a generic "permission denied".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeError {
    /// A `..` component appeared in the input.
    ParentEscape,
    /// A Windows drive prefix, UNC path, or rooted path appeared.
    Rooted,
    /// The path exists and is a directory.
    NotAFile,
    /// Canonicalizing the path failed (permissions, broken symlink loop).
    Unresolvable(String),
    /// The resolved path is outside the workspace. Carries the root so the
    /// message can name the folder that *is* open: telling a model "outside the
    /// workspace" without saying which workspace leaves it nothing to repeat to
    /// the user, and the fix -- open that folder -- needs to be nameable.
    ///
    /// Only the root is ever included, never the resolved path. The root is the
    /// folder this conversation was opened on, so it is not a disclosure; the
    /// resolved path is wherever the model was reaching, which may well be
    /// somewhere the user never mentioned.
    OutsideWorkspace(String),
    /// Symlink resolution landed outside the workspace.
    SymlinkEscape,
}

impl ScopeError {
    /// Model-facing text. Never includes the resolved absolute path, which can
    /// reveal the user's directory layout beyond what they shared.
    pub fn message(&self) -> String {
        match self {
            ScopeError::ParentEscape => {
                "The path may not contain `..` to reach outside the workspace.".to_string()
            }
            ScopeError::Rooted => {
                "The path may not be a Windows drive, UNC, or otherwise rooted path.".to_string()
            }
            ScopeError::NotAFile => "That path is a directory, not a file.".to_string(),
            ScopeError::Unresolvable(why) => format!("The path could not be resolved: {why}"),
            ScopeError::OutsideWorkspace(root) => {
                format!(
                    "That path is outside the folder this conversation has open ({root}). \
                     To work there, ask the user to open that folder as the project first."
                )
            }
            ScopeError::SymlinkEscape => {
                "That path resolves through a symlink to outside the workspace.".to_string()
            }
        }
    }
}

/// A workspace root plus the resolved-path check.
pub struct Workspace {
    /// The canonicalized root. Every resolved path is compared against this, not
    /// against the spelling the user chose: their root may itself be a symlink
    /// (`~/projects` often is) while the model uses the real path underneath.
    canonical_root: PathBuf,
}

impl Workspace {
    pub fn new(root: &Path) -> Result<Self, ScopeError> {
        let canonical_root = root
            .canonicalize()
            .map_err(|error| ScopeError::Unresolvable(error.to_string()))?;
        Ok(Self { canonical_root })
    }

    /// The canonical root, for comparisons and error messages.
    pub fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    /// Resolve a workspace-relative path to an absolute, verified path.
    ///
    /// `must_exist` is false for writes, where the target may be a new file. The
    /// deepest existing ancestor is canonicalized instead, which is what makes
    /// the check sound for a not-yet-created path: without it, a symlinked
    /// parent directory would let a "new" file land outside the workspace.
    pub fn resolve(&self, relative: &str, must_exist: bool) -> Result<PathBuf, ScopeError> {
        if relative.trim().is_empty() {
            return Err(ScopeError::Unresolvable("the path is empty".to_string()));
        }

        // Windows separators are accepted on every platform so a model that
        // learned Windows habits on one project does not silently produce a
        // file literally named `src\main.rs` on Linux.
        let normalized = relative.replace('\\', "/");

        // Rootedness is checked *textually*, before the OS parses the path. On
        // Unix `C:/Windows` parses as two ordinary components named `C:` and
        // `Windows`, so a component-based check would happily create a
        // directory called `C:` instead of refusing. A model emitting a
        // Windows path on a Linux workspace is confused, and silently
        // "succeeding" by writing somewhere unexpected is the worst answer.
        if looks_rooted(&normalized) {
            return Err(ScopeError::Rooted);
        }

        let candidate = Path::new(&normalized);
        for component in candidate.components() {
            match component {
                Component::ParentDir => return Err(ScopeError::ParentEscape),
                // Defence in depth: `looks_rooted` already refused these, but a
                // path this module would otherwise accept must not reach the
                // disk on the strength of one textual check alone.
                Component::RootDir | Component::Prefix(_) => return Err(ScopeError::Rooted),
                Component::CurDir => {}
                _ => {}
            }
        }

        let joined = self.canonical_root.join(candidate);
        let resolved = self.canonicalize_deepest_existing(&joined)?;

        if !is_within(&self.canonical_root, &resolved) {
            // Distinguishing the two cases helps the model correct itself, but
            // only the symlink case is likely to be an attempted escape.
            if self.exists_below_root(&joined) {
                return Err(ScopeError::SymlinkEscape);
            }
            return Err(ScopeError::OutsideWorkspace(
                self.canonical_root.display().to_string(),
            ));
        }

        if must_exist && !resolved.exists() {
            return Err(ScopeError::Unresolvable(
                "no such file in the workspace".to_string(),
            ));
        }
        Ok(resolved)
    }

    /// Resolve a path that may have been written out in full.
    ///
    /// A model asked to look in a folder will often write the whole path, either
    /// because the user named one in their message or because it copied a path
    /// out of earlier output. That is not an escape attempt, so it is not
    /// refused on the grounds of being rooted -- it is held to exactly the same
    /// containment check as a relative path and given the same answer.
    ///
    /// The distinction that matters is *who* chose the directory, not what the
    /// path looks like. This method never widens what the workspace covers: a
    /// rooted path is a different spelling of a location, not a new root. So
    /// `resolve_input` can accept `/home/me/project/src` and refuse
    /// `/home/me/.ssh` in exactly the same breath, and the guarantee the rest of
    /// this module exists to make is unchanged.
    ///
    /// What it deliberately cannot do is adopt a new root. If the user wants
    /// work done somewhere else, that folder is opened for the conversation, and
    /// the same check then passes against it -- the user picks the sandbox, not
    /// the model.
    pub fn resolve_input(&self, input: &str, must_exist: bool) -> Result<PathBuf, ScopeError> {
        let normalized = input.trim().replace('\\', "/");
        if !looks_rooted(&normalized) {
            return self.resolve(input, must_exist);
        }

        // Rooted, so there is nothing to join and no `..` to strip: the path is
        // taken at face value and then checked, rather than being normalised into
        // the root. Canonicalizing the deepest existing ancestor keeps the
        // symlink case sound here too -- a symlinked parent inside the workspace
        // cannot redirect an absolute path to somewhere outside it.
        let candidate = Path::new(&normalized);

        // Rooted on *some* platform but not on this one. `C:/Windows` is two
        // ordinary components here, so treating it as a location would resolve
        // it against the process directory and report a nonsensical answer about
        // a path this machine cannot express. Refused as what it is: a model
        // emitting a Windows path is confused, and `Rooted` says so.
        if !candidate.is_absolute() {
            return Err(ScopeError::Rooted);
        }
        let resolved = self.canonicalize_deepest_existing(candidate)?;

        if !is_within(&self.canonical_root, &resolved) {
            return Err(ScopeError::OutsideWorkspace(
                self.canonical_root.display().to_string(),
            ));
        }
        if must_exist && !resolved.exists() {
            return Err(ScopeError::Unresolvable(
                "no such file in the workspace".to_string(),
            ));
        }
        Ok(resolved)
    }

    /// Same as `resolve_input`, but refuses a directory.
    pub fn resolve_file(&self, input: &str) -> Result<PathBuf, ScopeError> {
        let path = self.resolve_input(input, true)?;
        if path.is_dir() {
            return Err(ScopeError::NotAFile);
        }
        Ok(path)
    }

    /// Canonicalize as much of `path` as exists, and re-append the remainder.
    ///
    /// This is the load-bearing detail for writes: `a/b/c.rs` where `c.rs` does
    /// not exist still gets its existing prefix checked, so a symlinked `a/b`
    /// cannot smuggle the new file out of the workspace.
    fn canonicalize_deepest_existing(&self, path: &Path) -> Result<PathBuf, ScopeError> {
        let mut existing = path.to_path_buf();
        let mut trailing: Vec<std::ffi::OsString> = Vec::new();

        loop {
            match existing.canonicalize() {
                Ok(canonical) => {
                    let mut out = canonical;
                    for part in trailing.iter().rev() {
                        out.push(part);
                    }
                    return Ok(out);
                }
                Err(_) => {
                    let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                        return Err(ScopeError::Unresolvable(
                            "no existing ancestor directory".to_string(),
                        ));
                    };
                    trailing.push(name);
                    if !existing.pop() {
                        return Err(ScopeError::Unresolvable(
                            "reached the filesystem root without an existing ancestor".to_string(),
                        ));
                    }
                }
            }
        }
    }

    /// Whether the literal path sits under the root before symlink resolution.
    /// Used only to choose the more specific error message.
    fn exists_below_root(&self, joined: &Path) -> bool {
        is_within(&self.canonical_root, joined)
    }
}

/// Whether `text` looks rooted on *any* platform.
///
/// Covers the three spellings the OS would only understand natively: a leading
/// `/`, a Windows drive prefix like `C:`, and a UNC share like `//server/share`
/// (which arrives here as `//` because separators are normalized first).
fn looks_rooted(text: &str) -> bool {
    if text.starts_with('/') {
        return true;
    }
    let bytes = text.as_bytes();
    // `C:` or `C:/...` -- two bytes, a letter, then a colon.
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Component-wise containment, including the root itself.
///
/// Not a string `starts_with`: `/home/ab` must not count as inside `/home/a`.
/// That mistake is the classic way a sandbox is escaped with a sibling directory.
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let root_components: Vec<Component> = root.components().collect();
    let candidate_components: Vec<Component> = candidate.components().collect();

    if candidate_components.len() < root_components.len() {
        return false;
    }
    root_components
        .iter()
        .zip(candidate_components.iter())
        .all(|(a, b)| a == b)
}

/// Directories never worth walking: they are huge, generated, or both.
///
/// Applied to the workspace-relative path only, so a user who genuinely names a
/// folder `dist` inside `src/` is not silenced -- the rule is scoped to the
/// conventional top-level names.
const ALWAYS_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
    ".svelte-kit",
    "vendor",
    ".gradle",
    ".idea",
    ".DS_Store",
];

/// Whether a path is a file or directory Atomic should not walk into.
pub fn should_skip_dir(name: &str) -> bool {
    ALWAYS_SKIP.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atomic-scope-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir.canonicalize().expect("canonical scratch")
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        let root = scratch("plain");
        fs::write(root.join("a.txt"), "hi").unwrap();
        let ws = Workspace::new(&root).unwrap();
        assert_eq!(ws.resolve_file("a.txt").unwrap(), root.join("a.txt"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = scratch("parent");
        let ws = Workspace::new(&root).unwrap();
        assert_eq!(
            ws.resolve_file("../secret").unwrap_err(),
            ScopeError::ParentEscape
        );
        assert_eq!(
            ws.resolve_file("a/../../secret").unwrap_err(),
            ScopeError::ParentEscape
        );
    }

    #[test]
    fn rejects_an_absolute_path_outside_the_workspace() {
        // No longer refused for being rooted: it is held to the same containment
        // rule as everything else, and this is what that rule says.
        let root = scratch("absolute");
        let ws = Workspace::new(&root).unwrap();
        assert!(matches!(
            ws.resolve_file("/etc/passwd").unwrap_err(),
            ScopeError::OutsideWorkspace(_)
        ));
    }

    #[test]
    fn accepts_an_absolute_path_inside_the_workspace() {
        // The case this exists for: the user says "look in
        // /home/me/project/src" and the model writes that in full. Same file, same
        // containment, spelled absolutely.
        let root = scratch("absolute-inside");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "hi").unwrap();
        let ws = Workspace::new(&root).unwrap();
        assert_eq!(
            ws.resolve_file(root.join("src/a.txt").to_str().unwrap())
                .unwrap(),
            root.join("src/a.txt")
        );
    }

    #[test]
    fn accepts_an_absolute_directory_path_for_listing() {
        let root = scratch("absolute-dir");
        fs::create_dir_all(root.join("src")).unwrap();
        let ws = Workspace::new(&root).unwrap();
        let resolved = ws
            .resolve_input(root.join("src").to_str().unwrap(), true)
            .unwrap();
        assert!(resolved.is_dir());
    }

    #[test]
    fn an_absolute_path_cannot_escape_via_a_symlinked_parent() {
        // The reason the deepest existing ancestor is canonicalized rather than
        // the leaf: a link inside the workspace must not turn an absolute write
        // into a write outside it.
        let root = scratch("absolute-symlink");
        let outside = scratch("absolute-symlink-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let ws = Workspace::new(&root).unwrap();
        let via_link = root.join("link/secret.txt");
        assert!(matches!(
            ws.resolve_file(via_link.to_str().unwrap()).unwrap_err(),
            ScopeError::SymlinkEscape | ScopeError::OutsideWorkspace(_)
        ));
    }

    #[test]
    fn rejects_a_windows_rooted_path() {
        let root = scratch("winroot");
        let ws = Workspace::new(&root).unwrap();
        assert_eq!(
            ws.resolve_file("C:/Windows").unwrap_err(),
            ScopeError::Rooted
        );
    }

    #[test]
    fn rejects_a_directory() {
        let root = scratch("dir");
        fs::create_dir_all(root.join("sub")).unwrap();
        let ws = Workspace::new(&root).unwrap();
        assert_eq!(ws.resolve_file("sub").unwrap_err(), ScopeError::NotAFile);
    }

    /// The prefix bug: `/home/ab` is not inside `/home/a`.
    #[test]
    fn containment_compares_components_not_string_prefixes() {
        assert!(is_within(Path::new("/home/a"), Path::new("/home/a/b/c")));
        assert!(is_within(Path::new("/home/a"), Path::new("/home/a")));
        assert!(!is_within(Path::new("/home/a"), Path::new("/home/ab")));
        assert!(!is_within(Path::new("/home/a"), Path::new("/etc/passwd")));
        // A prefix of the root is not within it.
        assert!(!is_within(Path::new("/home/a/b"), Path::new("/home/a")));
    }

    #[test]
    fn a_sibling_directory_is_outside() {
        let base = scratch("sibling");
        let root = base.join("app");
        let other = base.join("app-secrets");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("key.txt"), "shh").unwrap();
        let ws = Workspace::new(&root).unwrap();
        let error = ws.resolve_file("../app-secrets/key.txt").unwrap_err();
        assert!(matches!(
            error,
            ScopeError::ParentEscape | ScopeError::OutsideWorkspace(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_points_out_of_the_workspace() {
        let base = scratch("symlink");
        let root = base.join("app");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "shh").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let ws = Workspace::new(&root).unwrap();
        assert_eq!(
            ws.resolve_file("link/secret.txt").unwrap_err(),
            ScopeError::SymlinkEscape
        );
    }

    #[cfg(unix)]
    #[test]
    fn allows_a_symlink_that_stays_inside() {
        let root = scratch("symlink-inside");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/a.txt"), "ok").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let ws = Workspace::new(&root).unwrap();
        assert!(ws.resolve_file("link/a.txt").is_ok());
    }

    #[cfg(unix)]
    /// The load-bearing case: a new file under a symlinked parent. Resolving only
    /// the file itself would pass, because the file does not exist yet.
    #[test]
    fn refuses_a_new_file_under_a_symlinked_parent() {
        let base = scratch("symlink-new");
        let root = base.join("app");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let ws = Workspace::new(&root).unwrap();
        assert_eq!(
            ws.resolve("link/created.rs", false).unwrap_err(),
            ScopeError::SymlinkEscape
        );
    }

    #[test]
    fn accepts_a_backslash_path_on_unix() {
        let root = scratch("backslash");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        let ws = Workspace::new(&root).unwrap();
        assert!(ws.resolve_file("src\\main.rs").is_ok());
    }

    #[test]
    fn skips_the_conventional_generated_directories() {
        for name in ["node_modules", ".git", "target", "dist"] {
            assert!(should_skip_dir(name), "{name} should be skipped");
        }
        assert!(!should_skip_dir("src"));
    }

    /// A live check against a real tree, including a symlink that points at a
    /// file outside the workspace. The unit tests build their own fixtures; this
    /// one is the end-to-end statement that the composed rules refuse it.
    #[test]
    fn refuses_a_symlinked_file_that_points_outside() {
        let base = scratch("symlink-file");
        fs::write(base.join("real.txt"), "ok").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", base.join("leak.txt")).unwrap();

        let ws = Workspace::new(&base).unwrap();
        assert_eq!(
            ws.resolve_file("leak.txt").unwrap_err(),
            ScopeError::SymlinkEscape
        );
    }

    #[test]
    fn every_refusal_has_a_model_facing_message() {
        for error in [
            ScopeError::ParentEscape,
            ScopeError::Rooted,
            ScopeError::NotAFile,
            ScopeError::OutsideWorkspace("/tmp/root".into()),
            ScopeError::SymlinkEscape,
            ScopeError::Unresolvable("x".into()),
        ] {
            assert!(!error.message().is_empty());
        }
    }
}
