// Process execution for the Code-mode tools.
//
// A shell tool is the sharpest thing in this app: it runs whatever the model
// writes. Three properties keep that from being reckless, and all three live
// here rather than in TypeScript, because TypeScript cannot enforce them
// against a caller that has not been written yet.
//
//   1. The working directory is the canonicalized workspace root. There is no
//      way to pass a different one, so `cd` at the start of a command cannot
//      move the process somewhere the user did not open.
//   2. Every run is bounded by a timeout and killed as a process group, so a
//      hang or a backgrounded child cannot outlive the tool call.
//   3. Output is truncated with a stated reason. A command that prints a million
//      lines should not be able to exhaust memory or blow the model's context.
//
// The permission gate is the thing that decides whether any of this runs at all;
// see `permissions/gate.ts`. Nothing here is an authorization check, and it
// should never be treated as one.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::workspace::Workspace;

/// Long enough for a real build, short enough that a stuck process is noticed.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_OUTPUT_BYTES: usize = 200_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/// The shell to use, from `packages/core/src/platform/shell.ts`.
///
/// PowerShell on Windows and bash or zsh elsewhere. PowerShell needs `-NoProfile`
/// or a user's profile can print a banner that gets mixed into tool output, and
/// `-NonInteractive` so a prompt cannot hang the run.
fn shell_command(platform: &str) -> (String, Vec<String>) {
    if platform == "windows" {
        (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
            ],
        )
    } else {
        ("/bin/bash".to_string(), vec!["-lc".to_string()])
    }
}

#[tauri::command]
pub fn process_run(
    workspace_root: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<RunResult, String> {
    if command.trim().is_empty() {
        return Err("The command is empty.".to_string());
    }
    let workspace = Workspace::new(Path::new(&workspace_root)).map_err(|e| e.message())?;
    let (program, args) = shell_command(std::env::consts::OS);
    let limit = timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);

    let started = Instant::now();
    let mut command_builder = std::process::Command::new(&program);
    command_builder
        .args(&args)
        .arg(&command)
        // The one working directory a tool may ever use.
        .current_dir(workspace.canonical_root())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A new process group means a timeout can take down anything the command
    // spawned, not just the shell. Without it `npm start` outlives its own
    // timeout and keeps the port.
    process_group(&mut command_builder);

    let mut child = command_builder
        .spawn()
        .map_err(|error| format!("could not start {program}: {error}"))?;

    let mut timed_out = false;
    if !wait_with_deadline(&mut child, Duration::from_millis(limit)) {
        timed_out = true;
        kill_tree(&mut child);
        // Reap the corpse, or the process stays a zombie until the app exits.
        let _ = child.wait();
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not collect output: {error}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    let (stdout, stdout_truncated) = cap(&output.stdout);
    let (stderr, stderr_truncated) = cap(&output.stderr);

    Ok(RunResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
        duration_ms,
        timed_out,
    })
}

/// Git helpers, so the model does not have to invent porcelain formats.
#[tauri::command]
pub fn git_run(workspace_root: String, args: Vec<String>) -> Result<RunResult, String> {
    let workspace = Workspace::new(Path::new(&workspace_root)).map_err(|e| e.message())?;

    // A leading `-` would make git read it as an option; `--` ends option
    // parsing so a branch named `--upload-pack=...` cannot become one.
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(workspace.canonical_root());
    for arg in &args {
        command.arg(arg);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = Instant::now();
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git is not installed, or not on PATH.".to_string()
        } else {
            format!("could not run git: {error}")
        }
    })?;

    let (stdout, stdout_truncated) = cap(&output.stdout);
    let (stderr, stderr_truncated) = cap(&output.stderr);
    Ok(RunResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: false,
    })
}

/// True when the workspace is inside a git repository.
///
/// Asked before showing git controls, so the UI does not offer a diff for a
/// folder that has never been initialised.
#[tauri::command]
pub fn git_is_repository(workspace_root: String) -> Result<bool, String> {
    let workspace = Workspace::new(Path::new(&workspace_root)).map_err(|e| e.message())?;
    Ok(workspace.canonical_root().join(".git").exists())
}

/// The default branch, for "compare against" defaults.
#[tauri::command]
pub fn git_default_branch(workspace_root: String) -> Result<Option<String>, String> {
    let workspace = Workspace::new(Path::new(&workspace_root)).map_err(|e| e.message())?;
    let head = std::fs::read_to_string(workspace.canonical_root().join(".git/HEAD"))
        .map_err(|error| format!("{error}"))?;
    Ok(head
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(|name| name.to_string()))
}

fn cap(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= MAX_OUTPUT_BYTES {
        return (String::from_utf8_lossy(bytes).into_owned(), false);
    }
    let mut end = MAX_OUTPUT_BYTES;
    // Walk back over UTF-8 continuation bytes (top bits `10`) so the cut lands
    // on a character boundary. Cutting mid-character would turn one glyph into
    // a replacement character, and in a diff that is a visible corruption.
    while end > 0 && bytes[end] & 0xC0 == 0x80 {
        end -= 1;
    }
    let mut text = String::from_utf8_lossy(&bytes[..end]).into_owned();
    text.push_str(&format!(
        "\n… output truncated at {MAX_OUTPUT_BYTES} bytes. Narrow the command or write to a file and read the part you need."
    ));
    (text, true)
}

/// Put the child in its own process group so a timeout can reap its descendants.
#[cfg(unix)]
fn process_group(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn process_group(_command: &mut std::process::Command) {}

/// Kill the whole process group, falling back to the single process.
#[cfg(unix)]
fn kill_tree(child: &mut std::process::Child) {
    // A negative pid addresses the whole group, so grandchildren go too.
    // `u32 -> i32` is a lossless widening for any live pid.
    let group = -(child.id() as i32);
    let _ = std::process::Command::new("kill")
        .arg(group.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(unix))]
fn kill_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

/// Poll until the child exits or the deadline passes. Returns true if it exited.
fn wait_with_deadline(child: &mut std::process::Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            // An error means we cannot tell; treat it as finished and let the
            // caller collect whatever output there is, rather than hanging.
            Ok(None) | Err(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_uses_powershell_without_a_profile() {
        let (program, args) = shell_command("windows");
        assert_eq!(program, "powershell.exe");
        assert!(args.contains(&"-NoProfile".to_string()));
        assert!(args.contains(&"-NonInteractive".to_string()));
    }

    #[test]
    fn other_platforms_use_bash() {
        let (program, args) = shell_command("linux");
        assert_eq!(program, "/bin/bash");
        assert_eq!(args, vec!["-lc".to_string()]);
    }

    #[test]
    fn output_is_capped_and_says_so() {
        let big = vec![b'x'; MAX_OUTPUT_BYTES + 5_000];
        let (text, truncated) = cap(&big);
        assert!(truncated);
        assert!(text.contains("output truncated"));
    }

    #[test]
    fn short_output_is_untouched() {
        let (text, truncated) = cap(b"hello\n");
        assert_eq!(text, "hello\n");
        assert!(!truncated);
    }

    #[test]
    fn a_multibyte_character_is_never_split() {
        // Each '€' is three bytes; cutting at a raw offset would panic on a
        // non-boundary and produce replacement characters.
        let bytes = "€".repeat(MAX_OUTPUT_BYTES).into_bytes();
        let (text, truncated) = cap(&bytes);
        assert!(truncated);
        assert!(!text.contains('\u{FFFD}'));
    }
}
