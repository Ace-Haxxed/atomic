// Checkpoints: the file contents as they were before the agent changed them.
//
// Why this lives natively rather than in the database: a checkpoint is a file
// restore mechanism, and a restore is only as good as the guarantee that it
// cannot be tricked into writing outside the workspace. That guarantee already
// exists, is already tested against symlinks and `..`, and lives in
// `workspace::Workspace`. Re-implementing path resolution to make a JSON blob
// easier to store would mean two places where an escape could hide.
//
// A snapshot is one JSON file per touched path, named by a counter, holding the
// path, whether the file existed at all, and its previous bytes. `existed` is
// the field that makes restore of a *new* file correct: without it, undoing a
// file the agent created would have to delete it, and there is no way to tell
// "the agent created this" from "this was already here" without it.
//
// Storing the contents rather than just the names means an undo works even
// after the user has edited the file themselves, and even with no git in the
// project at all.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::workspace::Workspace;

/// Upper bound on a single snapshot. Matches the read limit: a file too big for
/// the model to read is not one whose contents are worth snapshotting, and an
/// unbounded copy is a way to fill the user's disk.
const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024;

/// Refuse identifiers that could escape the backups directory. These come from
/// the app, not the model, but they are still used to build a path.
const MAX_ID_LEN: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    /// Workspace-relative, forward slashes.
    pub path: String,
    /// False when the file did not exist, so restore removes it again.
    pub existed: bool,
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRun {
    pub run_id: String,
    pub created_at: u64,
    pub files: Vec<CheckpointFile>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    path: String,
    existed: bool,
    /// The previous bytes. Empty when `existed` is false.
    before: String,
    created_at: u64,
    bytes: u64,
}

static SNAPSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reject anything that is not a plain identifier. Slashes and dots are the
/// only characters that matter: without this, an id could name a directory
/// outside the backups tree.
fn check_id(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_LEN {
        return Err(format!("invalid {kind}"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid {kind}"));
    }
    Ok(())
}

fn run_dir(backups_dir: &Path, conversation_id: &str, run_id: &str) -> Result<PathBuf, String> {
    check_id("conversation id", conversation_id)?;
    check_id("run id", run_id)?;
    Ok(backups_dir.join(conversation_id).join(run_id))
}

/// Store the contents of `path` as they were before this run changed it.
///
/// `before` is passed in rather than read here on purpose: the caller has
/// already read the file to build the edit, and re-reading would be a second
/// race against the same window where the file could change.
#[tauri::command]
pub fn checkpoint_save(
    backups_dir: String,
    conversation_id: String,
    run_id: String,
    path: String,
    existed: bool,
    before: String,
) -> Result<(), String> {
    let dir = run_dir(Path::new(&backups_dir), &conversation_id, &run_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // One snapshot per path per run. A second write to the same file in the same
    // run must not overwrite the first: undo means "before this run", and if a
    // later write replaced the original, the earlier state would be lost.
    let existing = read_run(&dir)?;
    if existing.iter().any(|s| s.path == path) {
        return Ok(());
    }

    let bytes = before.len() as u64;
    if bytes > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "file is {bytes} bytes, over the {MAX_SNAPSHOT_BYTES} byte checkpoint limit; it was changed but not checkpointed"
        ));
    }

    let sequence = SNAPSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let snapshot = Snapshot {
        path: path.clone(),
        existed,
        before,
        created_at: now_millis(),
        bytes,
    };
    let encoded = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{sequence:016x}.json")), encoded).map_err(|e| e.to_string())
}

fn read_run(dir: &Path) -> Result<Vec<Snapshot>, String> {
    let mut snapshots: Vec<(u64, Snapshot)> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // A run with no snapshots is not an error; it is a run that changed
        // nothing the user would want back.
        Err(_) => return Ok(Vec::new()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // The sequence number in the filename is the write order. `created_at`
        // is milliseconds and two saves in the same tick would tie, leaving
        // `read_dir` order to decide -- and that order is arbitrary.
        let Some(sequence) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| u64::from_str_radix(s, 16).ok())
        else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if let Ok(snapshot) = serde_json::from_slice::<Snapshot>(&bytes) {
            snapshots.push((sequence, snapshot));
        }
    }
    snapshots.sort_by_key(|(sequence, _)| *sequence);
    Ok(snapshots
        .into_iter()
        .map(|(_, snapshot)| snapshot)
        .collect())
}

/// List every checkpointed run for a conversation, newest first.
#[tauri::command]
pub fn checkpoint_list(
    backups_dir: String,
    conversation_id: String,
) -> Result<Vec<CheckpointRun>, String> {
    check_id("conversation id", &conversation_id)?;
    let conversation_dir = Path::new(&backups_dir).join(&conversation_id);
    let Ok(entries) = std::fs::read_dir(&conversation_dir) else {
        return Ok(Vec::new());
    };

    let mut runs: Vec<CheckpointRun> = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(run_id) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let snapshots = read_run(&dir)?;
        if snapshots.is_empty() {
            continue;
        }
        runs.push(CheckpointRun {
            run_id: run_id.to_string(),
            created_at: snapshots.first().map(|s| s.created_at).unwrap_or(0),
            files: snapshots
                .iter()
                .map(|s| CheckpointFile {
                    path: s.path.clone(),
                    existed: s.existed,
                    bytes: s.bytes,
                })
                .collect(),
        });
    }
    runs.sort_by_key(|run| std::cmp::Reverse(run.created_at));
    Ok(runs)
}

/// Put the files back.
///
/// Every restored path is resolved through the workspace check, so a tampered
/// or stale snapshot cannot be used to write outside the project. A file that
/// did not exist is removed, because the change being undone is its creation.
#[tauri::command]
pub fn checkpoint_restore(
    workspace_root: String,
    backups_dir: String,
    conversation_id: String,
    run_id: String,
    path: Option<String>,
) -> Result<Vec<String>, String> {
    let workspace = Workspace::new(Path::new(&workspace_root)).map_err(|error| error.message())?;
    let dir = run_dir(Path::new(&backups_dir), &conversation_id, &run_id)?;
    let snapshots = read_run(&dir)?;
    if snapshots.is_empty() {
        return Err("there is nothing to restore for that run".to_string());
    }

    let mut restored = Vec::new();
    for snapshot in snapshots {
        if let Some(only) = path.as_ref() {
            if &snapshot.path != only {
                continue;
            }
        }
        // Resolve with `must_exist` false: a snapshot for a deleted file still
        // has to be able to recreate it.
        let target = workspace.resolve(&snapshot.path, false).map_err(|error| {
            format!("refusing to restore {}: {}", snapshot.path, error.message())
        })?;

        if snapshot.existed {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, snapshot.before.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                // The file the run created is already gone, which is the state
                // being asked for. Not an error.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        restored.push(snapshot.path);
    }

    if restored.is_empty() {
        return Err("that run did not touch this file".to_string());
    }
    Ok(restored)
}

/// Drop a run's snapshots once the user has decided they are not wanted.
#[tauri::command]
pub fn checkpoint_discard(
    backups_dir: String,
    conversation_id: String,
    run_id: String,
) -> Result<(), String> {
    let dir = run_dir(Path::new(&backups_dir), &conversation_id, &run_id)?;
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atomic-checkpoint-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_and_lists_a_run() {
        let backups = temp_dir("list");
        checkpoint_save(
            backups.to_string_lossy().into_owned(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "old".into(),
        )
        .unwrap();
        checkpoint_save(
            backups.to_string_lossy().into_owned(),
            "c1".into(),
            "r1".into(),
            "b.ts".into(),
            false,
            String::new(),
        )
        .unwrap();

        let runs = checkpoint_list(backups.to_string_lossy().into_owned(), "c1".into()).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].files.len(), 2);
        assert_eq!(runs[0].files[0].path, "a.ts");
        assert!(runs[0].files[0].existed);
        assert!(!runs[0].files[1].existed);
    }

    #[test]
    fn keeps_the_first_snapshot_for_a_path_written_twice_in_one_run() {
        // Undo means "before this run". If a second write overwrote the first
        // snapshot, undo would restore an intermediate state instead.
        let backups = temp_dir("twice");
        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "original".into(),
        )
        .unwrap();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "intermediate".into(),
        )
        .unwrap();

        let snapshot = read_run(&backups.join("c1").join("r1")).unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].before, "original");
    }

    #[test]
    fn restore_puts_old_contents_back_and_removes_created_files() {
        let backups = temp_dir("restore");
        let workspace = temp_dir("restore-ws");
        fs::write(workspace.join("a.ts"), "changed").unwrap();
        fs::write(workspace.join("created.ts"), "new file").unwrap();

        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "original".into(),
        )
        .unwrap();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "created.ts".into(),
            false,
            String::new(),
        )
        .unwrap();

        let ws = workspace.to_string_lossy().into_owned();
        let restored =
            checkpoint_restore(ws.clone(), dir.clone(), "c1".into(), "r1".into(), None).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(
            fs::read_to_string(workspace.join("a.ts")).unwrap(),
            "original"
        );
        // The file the run created is gone again, not left holding its contents.
        assert!(!workspace.join("created.ts").exists());
    }

    #[test]
    fn restore_recreates_a_file_the_run_deleted() {
        let backups = temp_dir("deleted");
        let workspace = temp_dir("deleted-ws");
        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "gone.ts".into(),
            true,
            "was here".into(),
        )
        .unwrap();

        checkpoint_restore(
            workspace.to_string_lossy().into_owned(),
            dir,
            "c1".into(),
            "r1".into(),
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join("gone.ts")).unwrap(),
            "was here"
        );
    }

    #[test]
    fn restore_refuses_a_snapshot_pointing_outside_the_workspace() {
        // A snapshot is a file on disk holding a path. If the backups directory
        // were ever tampered with, that path must still not be trusted.
        let backups = temp_dir("escape");
        let workspace = temp_dir("escape-ws");
        let outside = temp_dir("escape-outside");
        fs::write(outside.join("victim.txt"), "untouched").unwrap();

        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "../escape-outside/victim.txt".into(),
            true,
            "overwritten".into(),
        )
        .unwrap();

        let result = checkpoint_restore(
            workspace.to_string_lossy().into_owned(),
            dir,
            "c1".into(),
            "r1".into(),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(outside.join("victim.txt")).unwrap(),
            "untouched"
        );
    }

    #[test]
    fn restore_can_be_limited_to_one_path() {
        let backups = temp_dir("one");
        let workspace = temp_dir("one-ws");
        fs::write(workspace.join("a.ts"), "a-new").unwrap();
        fs::write(workspace.join("b.ts"), "b-new").unwrap();
        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "a-old".into(),
        )
        .unwrap();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "b.ts".into(),
            true,
            "b-old".into(),
        )
        .unwrap();

        checkpoint_restore(
            workspace.to_string_lossy().into_owned(),
            dir,
            "c1".into(),
            "r1".into(),
            Some("a.ts".into()),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(workspace.join("a.ts")).unwrap(), "a-old");
        assert_eq!(fs::read_to_string(workspace.join("b.ts")).unwrap(), "b-new");
    }

    #[test]
    fn refuses_ids_that_could_climb_out_of_the_backups_directory() {
        let backups = temp_dir("ids");
        let dir = backups.to_string_lossy().into_owned();
        assert!(checkpoint_save(
            dir.clone(),
            "../evil".into(),
            "r1".into(),
            "a".into(),
            true,
            String::new()
        )
        .is_err());
        assert!(checkpoint_save(
            dir.clone(),
            "c1".into(),
            "../evil".into(),
            "a".into(),
            true,
            String::new()
        )
        .is_err());
        assert!(checkpoint_list(dir, "c1/../../etc".into()).is_err());
    }

    #[test]
    fn reports_a_run_with_nothing_to_restore() {
        let backups = temp_dir("empty");
        let workspace = temp_dir("empty-ws");
        let result = checkpoint_restore(
            workspace.to_string_lossy().into_owned(),
            backups.to_string_lossy().into_owned(),
            "c1".into(),
            "r1".into(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn discard_removes_the_run() {
        let backups = temp_dir("discard");
        let dir = backups.to_string_lossy().into_owned();
        checkpoint_save(
            dir.clone(),
            "c1".into(),
            "r1".into(),
            "a.ts".into(),
            true,
            "x".into(),
        )
        .unwrap();
        checkpoint_discard(dir.clone(), "c1".into(), "r1".into()).unwrap();
        assert!(checkpoint_list(dir, "c1".into()).unwrap().is_empty());
    }
}
