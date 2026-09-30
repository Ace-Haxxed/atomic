// Checking that a folder exists, for `add_folder`.
//
// This is the one command in the app that looks at a path outside every
// authorized root, and it earns that by being unable to do anything with what it
// finds. It returns a verdict -- yes, this is a folder, here is its canonical
// path -- and never a name, a size, or a byte of what is inside. There is no
// listing here, no reading, and no globbing, so there is nothing for it to be
// repurposed into a way to browse the disk.
//
// It still canonicalizes rather than trusting the input. A path that arrives as
// `/home/me/link-to-etc` must be authorized as `/etc` or refused, not stored as
// the path that was typed: a symlink swapped afterwards would otherwise turn a
// folder the user approved into a different one.

use serde::Serialize;

/// Refuse anything that is not plainly a folder a person meant to name.
///
/// The list is short because the alternative is a blacklist, and a blacklist of
/// sensitive directories is a losing game: it needs an entry per shell profile,
/// per language tool, per cloud client, and it is wrong the moment any of them
/// creates a new one. Naming a sensitive directory is the model asking for
/// something nobody asks for by accident, so it is treated as a refusal and the
/// user is told why in terms they can act on.
///
/// The check is on the canonical path, so `/home/me/.ssh/..` and a symlink into
/// `~/.ssh` are caught the same as the plain form.
const REFUSED_SEGMENTS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker",
    ".azure",
    ".config/gcloud",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "id_ed25519",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    /// True only when the path is a readable, canonical, non-refused directory.
    pub ok: bool,
    /// Canonical path, present only when `ok`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Model-facing refusal, present only when not `ok`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[tauri::command]
pub fn check_folder(path: String) -> FolderCheck {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return refuse("No folder was named.");
    }

    // Absolute only. A relative path here would be resolved against the app's
    // working directory -- whatever directory the process happened to be started
    // in, which is not something the user chose and not something the model can
    // see. `Code` would then silently become some unrelated `Code` elsewhere, and
    // the user would be prompted to approve a path they never named.
    if !std::path::Path::new(trimmed).is_absolute() {
        return refuse(&format!(
            "`{trimmed}` is a relative path. Give the full path to the folder, \
             starting at `/`."
        ));
    }

    // The path has to exist as given. Falling back to the deepest existing
    // ancestor -- which is what writes do, so a new file can be created -- would
    // be the wrong move here: asking for `/home/me/Code/typo` would authorize
    // `/home/me/Code`, handing back a *larger* scope than the one requested, and
    // reporting success for a folder nobody agreed to. A folder to authorize is
    // a folder that exists; to make a new one, create it inside a folder already
    // in use.
    let Ok(canonical) = std::path::Path::new(trimmed).canonicalize() else {
        return refuse(&format!("`{trimmed}` does not exist."));
    };

    if !canonical.is_dir() {
        return refuse(&format!("`{trimmed}` is a file, not a folder."));
    }

    let text = canonical.to_string_lossy().replace('\\', "/");
    if let Some(hit) = refused_segment(&text) {
        return refuse(&format!(
            "`{hit}` is a credentials or system folder. Requesting it is refused; \
             copy what you need into a folder you are already using instead."
        ));
    }

    FolderCheck {
        ok: true,
        path: Some(text),
        reason: None,
    }
}

fn refuse(reason: &str) -> FolderCheck {
    FolderCheck {
        ok: false,
        path: None,
        reason: Some(reason.to_string()),
    }
}

/// The first refused segment present in a canonical path, if any.
fn refused_segment(path: &str) -> Option<String> {
    for segment in REFUSED_SEGMENTS {
        let hit = if segment.contains('/') {
            // A multi-component entry is matched as the whole run of components,
            // so the split below would never produce it as a single component.
            path.contains(segment)
        } else {
            // Compared against whole path components. A substring test would
            // refuse `/home/me/.ssh-notes`, which is a folder someone might
            // plausibly keep their own work in, and refusing it teaches the user
            // the check is noise.
            path.split('/')
                .any(|component| !component.is_empty() && component == *segment)
        };
        if hit {
            return Some((*segment).to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("atomic-folder-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn accepts_a_real_folder_and_canonicalizes_it() {
        let dir = temp_dir("ok");
        let check = check_folder(dir.to_str().unwrap().to_string());
        assert!(check.ok, "{check:?}");
        assert_eq!(check.path.as_deref(), Some(dir.to_str().unwrap()));
    }

    #[test]
    fn accepts_a_path_with_a_trailing_separator() {
        // What a user pastes, and what a model emits after reading a directory
        // listing, both end in a separator. It must not become a different entry
        // in the list from the same folder without one.
        let dir = temp_dir("trailing");
        let with_sep = format!("{}/", dir.to_str().unwrap());
        let check = check_folder(with_sep);
        assert!(check.ok, "{check:?}");
        assert_eq!(check.path.as_deref(), Some(dir.to_str().unwrap()));
    }

    #[test]
    fn refuses_a_relative_path_instead_of_resolving_it() {
        // A relative path would be resolved against the process working
        // directory, which nobody chose. The failure this guards is quiet: the
        // check would pass, on a folder the user never named, and the prompt
        // would show a path they do not recognize.
        let check = check_folder("relative/path".to_string());
        assert!(!check.ok);
        assert!(
            check.reason.unwrap().contains("relative"),
            "the reason should say what is wrong with the path"
        );
    }

    #[test]
    fn refuses_a_bare_dot() {
        let check = check_folder(".".to_string());
        assert!(!check.ok);
    }

    #[test]
    fn refuses_a_file() {
        let dir = temp_dir("file");
        let file = dir.join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let check = check_folder(file.to_str().unwrap().to_string());
        assert!(!check.ok);
        assert!(
            check.reason.clone().unwrap().contains("not a folder"),
            "{check:?}"
        );
    }

    #[test]
    fn refuses_a_path_that_does_not_exist() {
        let dir = temp_dir("missing");
        let gone = dir.join("nope");
        let check = check_folder(gone.to_str().unwrap().to_string());
        assert!(!check.ok);
        assert!(
            check.reason.clone().unwrap().contains("does not exist"),
            "{check:?}"
        );
    }

    #[test]
    fn refuses_an_empty_path() {
        let check = check_folder("   ".to_string());
        assert!(!check.ok);
    }

    #[test]
    fn refuses_a_symlink_that_points_at_a_credentials_folder() {
        // The case the canonicalization is for. A plain textual check sees
        // `/tmp/.../innocent` and allows it; what gets authorized is `/home/me/.ssh`.
        let real = std::path::PathBuf::from("/home/testuser/.ssh");
        if !real.is_dir() {
            // No such directory to point at; the segment test below covers the
            // rule itself, and this only adds the symlink hop when the fixture
            // happens to exist.
            return;
        }
        let dir = temp_dir("symlink");
        let link = dir.join("innocent");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let check = check_folder(link.to_str().unwrap().to_string());
        assert!(!check.ok, "{check:?}");
    }

    #[test]
    fn a_segment_only_matches_a_whole_component() {
        assert_eq!(refused_segment("/home/me/.ssh"), Some(".ssh".into()));
        assert_eq!(refused_segment("/home/me/.ssh/keys"), Some(".ssh".into()));
        assert_eq!(
            refused_segment("/home/me/.config/gcloud/x"),
            Some(".config/gcloud".into())
        );
        // Someone's own work, in a folder that merely resembles a secret store.
        assert_eq!(refused_segment("/home/me/.ssh-notes"), None);
        assert_eq!(refused_segment("/home/me/projects/ssh"), None);
    }

    #[test]
    fn a_parent_climb_is_judged_on_the_path_it_lands_on() {
        // The climb has to be resolved before the segment list is consulted, or
        // `ok/../.ssh` is a path that does not yet mention `.ssh` and the climb
        // becomes a way around the whole rule.
        let dir = temp_dir("climb");
        let hidden = dir.join(".ssh");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::create_dir_all(dir.join("ok")).unwrap();

        let climb = dir.join("ok").join("..").join(".ssh");
        let check = check_folder(climb.to_str().unwrap().to_string());
        assert!(!check.ok, "{check:?}");

        // And a climb that lands somewhere harmless is still allowed, so the
        // check is about where the path ends up rather than a ban on `..`.
        let plain = dir.join("ok");
        assert!(check_folder(plain.to_str().unwrap().to_string()).ok);
    }
}
