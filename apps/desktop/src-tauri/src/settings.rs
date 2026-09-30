// Settings file on disk.
//
// Written atomically through a temp file and a rename, because a half-written
// settings file would be read back as corrupt and the user would lose their
// preferences. The file is JSON so it can be inspected and repaired by hand.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn settings_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no config directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("cannot create {dir:?}: {error}"))?;
    Ok(dir.join("settings.json"))
}

pub fn read<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let path = settings_path(app)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {:?}: {error}", path)),
    }
}

pub fn write<R: tauri::Runtime>(app: &AppHandle<R>, json: &str) -> Result<(), String> {
    let path = settings_path(app)?;
    let temp = path.with_extension("json.tmp");
    {
        let mut file =
            fs::File::create(&temp).map_err(|error| format!("cannot write {temp:?}: {error}"))?;
        file.write_all(json.as_bytes())
            .map_err(|error| format!("cannot write {temp:?}: {error}"))?;
        // Without this the file can be empty after a crash mid-write.
        file.sync_all()
            .map_err(|error| format!("cannot flush {temp:?}: {error}"))?;
    }
    fs::rename(&temp, &path).map_err(|error| format!("cannot replace {path:?}: {error}"))
}

/// Append one redacted audit line. Never contains a secret: the caller redacts.
pub fn append_audit_line<R: tauri::Runtime>(app: &AppHandle<R>, line: &str) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("no log directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("cannot create {dir:?}: {error}"))?;
    let path = dir.join("audit.jsonl");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("cannot open {path:?}: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("cannot write {path:?}: {error}"))
}
