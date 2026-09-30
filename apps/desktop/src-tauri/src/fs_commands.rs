// Filesystem and search commands for the Code-mode tools.
//
// Two rules shape everything here:
//
//   1. Every path goes through `workspace::Workspace`. A caller cannot opt out,
//      and there is no "trust me" path parameter -- each authorized root is
//      resolved from disk on every call, so a root that was itself replaced by a
//      symlink after the app started is still caught. More than one root may be
//      passed, but the user names every one of them; nothing here can widen the
//      list.
//
//   2. Results are bounded. A model that asks to read a 4 GB file or grep a
//      monorepo should get a truncated result and a reason, not an OOM. Every
//      limit is explicit and reported back in the payload so the model can
//      narrow its request rather than guess.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::workspace::{self, ScopeError, Workspace};

/// Characters refused in a glob pattern.
///
/// Refusing `[` and `]` outright is a simplification: character classes are
/// genuinely useful. But a model that emits an unbalanced bracket gets a glob
/// that silently matches nothing, and the far more expensive failure is a
/// pattern that scans far more than intended. A clear refusal is cheaper than
/// either.
const MAX_RESULTS: usize = 1_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GREP_MATCHES: usize = 400;
const MAX_DEPTH: usize = 24;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Workspace-relative, forward slashes. What the model sends back.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    /// Bytes omitted, so the model knows to use grep or read a range instead of
    /// re-reading the whole file.
    pub omitted_bytes: u64,
    /// 1-based, and `0` when the whole file was returned.
    pub start_line: u32,
    pub end_line: u32,
    pub total_lines: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    /// Set when results were cut off, with the reason.
    pub truncated: bool,
    /// Files examined, so the model can tell "no matches" from "never looked".
    pub files_searched: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

/// The folders a conversation may touch: its workspace, plus anything the user
/// added under Settings.
///
/// Resolution tries them in order and stops at the first that contains the path,
/// so a path inside both the workspace and an added subfolder is reported
/// relative to the workspace. Roots that no longer exist are skipped rather than
/// fatal -- a folder on a drive that is not mounted right now should not take the
/// whole conversation's file access down with it -- but if *none* of them can be
/// used, that is reported, because silently having no roots is how a tool call
/// starts failing for a reason nobody can see.
fn scoped(workspace_roots: &[String]) -> Result<Vec<Workspace>, String> {
    let mut roots = Vec::new();
    let mut problems = Vec::new();
    for root in workspace_roots {
        match Workspace::new(Path::new(root)) {
            Ok(workspace) => roots.push(workspace),
            Err(error) => problems.push(format!("{root}: {}", error.message())),
        }
    }
    if roots.is_empty() {
        return Err(if problems.is_empty() {
            "This conversation has no folder open, and no folders have been allowed.".to_string()
        } else {
            format!(
                "None of the folders this conversation may use are available: {}",
                problems.join("; ")
            )
        });
    }
    Ok(roots)
}

/// Resolve `path` against the first root that contains it.
///
/// The roots are already canonicalized by `Workspace::new`, so containment here is
/// a real comparison rather than a textual one, and a path that lands outside
/// every root is refused with the list of folders that were open. Naming them
/// matters: the alternative is a model reporting "outside the workspace" with no
/// idea what would be inside it, and a user who cannot tell which folder to add.
fn resolve_in(roots: &[Workspace], path: &str) -> Result<(usize, PathBuf), String> {
    for (index, root) in roots.iter().enumerate() {
        match root.resolve_input(path, false) {
            Ok(resolved) => return Ok((index, resolved)),
            // A `..` escape is the one error that must not be retried against the
            // next root: `../x` means the same thing whatever the base, and
            // trying elsewhere would only change which root it slips past.
            Err(ScopeError::ParentEscape) | Err(ScopeError::Rooted) => {
                return Err(path_error(path, roots))
            }
            Err(_) => continue,
        }
    }
    Err(path_error(path, roots))
}

/// The refusal for a path no root contains.
fn path_error(path: &str, roots: &[Workspace]) -> String {
    let open = roots
        .iter()
        .map(|root| format!("\"{}\"", root.canonical_root().display()))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "\"{path}\" is outside every folder this conversation may use ({open}). \
         To use another folder, add it under Settings > Files."
    )
}

/// Resolve a path that must already exist, whether it is a file or a directory.
///
/// Used by listing, which needs a directory. Distinct from `resolve_in_file`
/// below and from `resolve_in`: the three differ only in what they demand of the
/// path, and getting them mixed up produces a refusal that names the wrong
/// problem -- "expected a file" when the caller wanted a folder, or a read that
/// lands on a directory.
fn resolve_in_present(roots: &[Workspace], path: &str) -> Result<(usize, PathBuf), String> {
    resolve_where(roots, path, |root, path| root.resolve_input(path, true))
}

/// Resolve a path that must exist and be a file.
fn resolve_in_file(roots: &[Workspace], path: &str) -> Result<(usize, PathBuf), String> {
    resolve_where(roots, path, |root, path| root.resolve_file(path))
}

/// Try each root with a caller-supplied resolution rule.
fn resolve_where(
    roots: &[Workspace],
    path: &str,
    rule: impl Fn(&Workspace, &str) -> Result<PathBuf, ScopeError>,
) -> Result<(usize, PathBuf), String> {
    // Two facts about the path have to be kept apart, because they lead the model
    // to opposite requests. "Outside every folder" means ask the user to add
    // one; "no such file" means try a different name. Conflating them is worse
    // than saying nothing: told a file it was told to read is outside, a model
    // asks for a folder that is already open and the request never resolves.
    //
    // So: `contained` is set by the errors that can only be produced *after* a
    // root has accepted the path as its own (missing, or the wrong shape), and
    // `outside_every_root` is set by the ones that mean the root disowned it. A
    // path inside a second folder that does not exist trips both -- the first
    // root disowns it, the second contains it -- and the containment has to be
    // the one that wins.
    let mut contained = false;
    let mut outside_every_root = false;
    for (index, root) in roots.iter().enumerate() {
        match rule(root, path) {
            Ok(resolved) => return Ok((index, resolved)),
            // A `..` escape or a Windows-shaped path means the same thing against
            // every root, so there is nothing to gain by trying the next one.
            Err(ScopeError::ParentEscape) | Err(ScopeError::Rooted) => {
                return Err(path_error(path, roots))
            }
            // The path is real but sits outside this root -- or reached out of it
            // through a symlink, which is the same refusal with a motive.
            // Another root may well contain it, so keep looking.
            Err(ScopeError::OutsideWorkspace(_)) | Err(ScopeError::SymlinkEscape) => {
                outside_every_root = true;
                continue;
            }
            // Missing, or the wrong shape, in a root that had already accepted the
            // path. Another root may hold what was asked for, which is the normal
            // case once more than one folder is open.
            Err(ScopeError::Unresolvable(_)) | Err(ScopeError::NotAFile) => {
                contained = true;
                continue;
            }
        }
    }
    if outside_every_root && !contained {
        return Err(path_error(path, roots));
    }
    Err(format!(
        "no such file in the folders this conversation may use: {path}"
    ))
}

/// The root a resolved path belongs to, for reporting paths relative to it.
fn owner(roots: &[Workspace], index: usize) -> &Workspace {
    &roots[index]
}

fn relative(workspace: &Workspace, path: &Path) -> String {
    path.strip_prefix(workspace.canonical_root())
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn io(message: String) -> String {
    message
}

// ---- read ---------------------------------------------------------------

#[tauri::command]
pub fn fs_read(
    workspace_roots: Vec<String>,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<ReadResult, String> {
    let roots = scoped(&workspace_roots)?;
    // `resolve_file`, not `resolve_input`: reading has to end at a file, and
    // walking off the end of the authorized roots must not turn into a read of
    // whichever root happens to be next in the list.
    let (_, target) = resolve_in_file(&roots, &path)?;

    let metadata = std::fs::metadata(&target).map_err(|error| io(error.to_string()))?;
    let total_bytes = metadata.len();
    if total_bytes > MAX_FILE_BYTES {
        return Err(format!(
            "{path} is {total_bytes} bytes, over the {MAX_FILE_BYTES} byte limit. Use grep to find the relevant lines, then read with offset and limit."
        ));
    }

    let bytes = std::fs::read(&target).map_err(|error| io(error.to_string()))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len() as u32;

    // 1-based offsets, because that is what a model reading a stack trace or
    // an editor status bar will have been given.
    let start = offset.unwrap_or(1).max(1);
    if start > total_lines.max(1) {
        return Err(format!(
            "{path} has {total_lines} lines; offset {start} is past the end."
        ));
    }
    let count = limit.unwrap_or(2_000).clamp(1, 2_000);
    let from = (start - 1) as usize;
    let to = (from + count as usize).min(lines.len());
    let slice = &lines[from..to];
    let end_line = to as u32;
    let truncated = to < lines.len();

    let content = slice.join("\n");
    let omitted = if truncated {
        total_bytes - content.len() as u64
    } else {
        0
    };

    Ok(ReadResult {
        path,
        content,
        truncated,
        omitted_bytes: omitted,
        start_line: start,
        end_line,
        total_lines,
    })
}

// ---- write --------------------------------------------------------------

#[tauri::command]
pub fn fs_write(
    workspace_roots: Vec<String>,
    path: String,
    content: String,
) -> Result<FileEntry, String> {
    let roots = scoped(&workspace_roots)?;
    // `must_exist: false` -- this is how a file comes into being, and the
    // deepest-existing-ancestor check still applies.
    let (_, target) = resolve_in(&roots, &path)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| io(error.to_string()))?;
    }
    std::fs::write(&target, content.as_bytes()).map_err(|error| io(error.to_string()))?;

    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(FileEntry {
        path,
        name: target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        is_dir: false,
        size,
    })
}

// ---- list ---------------------------------------------------------------

#[tauri::command]
pub fn fs_list(workspace_roots: Vec<String>, path: String) -> Result<ListResult, String> {
    let roots = scoped(&workspace_roots)?;
    let (index, target) = resolve_in_present(&roots, &path)?;
    if !target.is_dir() {
        return Err(format!("{path} is a file, not a directory. Use fs_read."));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let reader = std::fs::read_dir(&target).map_err(|error| io(error.to_string()))?;
    for item in reader {
        let Ok(item) = item else { continue };
        let Ok(metadata) = item.metadata() else {
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        // Generated and vendored trees are noise in a directory listing, and on
        // a `node_modules` root they are the whole answer.
        if metadata.is_dir() && workspace::should_skip_dir(&name) {
            continue;
        }
        // Listed relative to the folder being listed, so that listing the
        // workspace reads the way it always has. Outside the workspace the path
        // is spelled out, for the same reason glob and grep spell theirs out:
        // the model has to be able to open what it was just shown.
        let relative_path = relative(owner(&roots, index), &item.path());
        entries.push(FileEntry {
            path: display_path(&relative_path, index, owner(&roots, index)),
            name,
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
        });
    }

    // Directories first, then alphabetical. `Ordering::reverse` on `is_dir`
    // puts `true` first, which is the order people expect in a file list.
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    let truncated = entries.len() > MAX_RESULTS;
    entries.truncate(MAX_RESULTS);

    Ok(ListResult { entries, truncated })
}

// ---- glob ---------------------------------------------------------------

#[tauri::command]
pub fn fs_glob(workspace_roots: Vec<String>, pattern: String) -> Result<Vec<String>, String> {
    let roots = scoped(&workspace_roots)?;
    // Every authorized root is searched, because a search that skipped the added
    // folders would report "no such file" for a file the model can plainly read
    // -- which teaches it to distrust glob and makes it fall back to guessing.
    let mut matches: Vec<String> = Vec::new();
    for (index, root) in roots.iter().enumerate() {
        if matches.len() >= MAX_RESULTS {
            break;
        }
        matches.extend(
            walk(root, |candidate| glob_match(&pattern, candidate))
                .into_iter()
                .map(|found| display_path(&found, index, root)),
        );
    }
    Ok(matches.into_iter().take(MAX_RESULTS).collect())
}

/// How a search hit should be written out.
///
/// The workspace is the base every model already reasons from, so its hits stay
/// relative and the output reads the way it always has. Every other root has to
/// be spelled out: two folders routinely hold `src/index.ts`, and two identical
/// lines in one result are not a listing, they are an ambiguity -- the model
/// reads one of them, gets the other, and concludes the search lied.
///
/// Both forms are valid input to the file tools, so whatever comes back can be
/// handed straight back.
fn display_path(found: &str, index: usize, root: &Workspace) -> String {
    if index == 0 {
        return found.to_string();
    }
    root.canonical_root().join(found).display().to_string()
}

// ---- grep ---------------------------------------------------------------

#[tauri::command]
pub fn fs_grep(
    workspace_roots: Vec<String>,
    pattern: String,
    glob: Option<String>,
    case_sensitive: Option<bool>,
    max_matches: Option<u32>,
) -> Result<GrepResult, String> {
    let roots = scoped(&workspace_roots)?;
    let regex = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive.unwrap_or(false))
        // Without this a crafted pattern such as `(a+)+$` can hang the app.
        .size_limit(8 * 1024 * 1024)
        .dfa_size_limit(8 * 1024 * 1024)
        .build()
        .map_err(|error| format!("{pattern:?} is not a valid search pattern: {error}"))?;

    let cap = max_matches.unwrap_or(200).clamp(1, MAX_GREP_MATCHES as u32) as usize;
    let glob_filter = glob.as_deref().map(|g| g.to_string());

    let mut matches: Vec<GrepMatch> = Vec::new();
    let mut files_searched = 0usize;
    let mut truncated = false;

    // Searched across every authorized root, for the same reason as glob: a hit
    // the model cannot reproduce by reading the file it was told about is a hit
    // it will report as a ghost. The root index travels with each entry so a hit
    // outside the workspace can be reported as a path the model can actually open.
    let entries = roots
        .iter()
        .enumerate()
        .flat_map(|(index, root)| {
            walk_entries(root)
                .into_iter()
                .map(move |entry| (index, root, entry))
        })
        .collect::<Vec<_>>();

    for (index, root, entry) in entries {
        let path = display_path(&entry.relative, index, root);
        if matches.len() >= cap {
            truncated = true;
            break;
        }
        if entry.is_dir {
            continue;
        }
        if let Some(filter) = &glob_filter {
            if !glob_match(filter, &entry.relative) {
                continue;
            }
        }

        if entry.size > MAX_FILE_BYTES {
            continue;
        }
        // Binary files produce match noise and can stall on a huge line.
        if !is_probably_text(&entry.absolute) {
            continue;
        }

        files_searched += 1;
        let Ok(bytes) = std::fs::read(&entry.absolute) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if matches.len() >= cap {
                truncated = true;
                break;
            }
            if line.len() > 2_000 {
                // A minified bundle or a data blob. Reporting the first 200
                // characters is more useful than skipping the hit entirely.
                if regex.is_match(&line[..2_000]) {
                    matches.push(GrepMatch {
                        path: path.clone(),
                        line: index as u32 + 1,
                        text: format!("{}…", &line[..200]),
                    });
                }
                continue;
            }
            if regex.is_match(line) {
                matches.push(GrepMatch {
                    path: path.clone(),
                    line: index as u32 + 1,
                    text: line.to_string(),
                });
            }
        }
    }

    Ok(GrepResult {
        matches,
        truncated,
        files_searched,
    })
}

// ---- walking ------------------------------------------------------------

/// A workspace walk that respects `.gitignore` and skips generated trees.
///
/// `ignore::WalkBuilder` is used rather than a hand-rolled recursion because it
/// gets the boring parts right: gitignore precedence, symlink loop detection, and
/// not descending into `.git`. Re-implementing that is how a search tool ends up
/// taking a minute and burning all memory.
/// One walked path, with both spellings. The absolute path is needed to read
/// the file; the relative one is what the model sees and sends back.
struct Walked {
    absolute: PathBuf,
    relative: String,
    is_dir: bool,
    size: u64,
}

fn walk_entries(workspace: &Workspace) -> Vec<Walked> {
    let mut builder = ignore::WalkBuilder::new(workspace.canonical_root());
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .parents(false)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH));

    let mut out = Vec::new();
    for entry in builder.build().flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if is_dir && workspace::should_skip_dir(&name) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(Walked {
            absolute: path.to_path_buf(),
            relative: relative(workspace, path),
            is_dir,
            size,
        });
    }
    out
}

fn walk(workspace: &Workspace, keep: impl Fn(&str) -> bool) -> Vec<String> {
    walk_entries(workspace)
        .into_iter()
        .filter(|entry| keep(&entry.relative))
        .map(|entry| entry.relative)
        .collect()
}

/// A small glob subset: `*`, `?`, `**`, and `{a,b}`.
///
/// Deliberately not the full glob grammar. A model needs "all the `.ts` files
/// under `src`", and a hand-written matcher that handles that is auditable in a
/// way that pulling in a full engine is not. It is anchored at the start, so
/// `*.ts` does not match `src/a.ts` -- a mismatch that silently returns nothing
/// is the single worst failure mode for a search tool.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    if !pattern.contains('/') {
        // An unanchored pattern matches the basename, which is what people mean.
        let base = text.rsplit('/').next().unwrap_or(text);
        return glob_segment(pattern, base);
    }
    match_prefix(pattern, text)
}

fn match_prefix(pattern: &str, text: &str) -> bool {
    if pattern.is_empty() {
        return true;
    }
    if let Some(rest) = pattern.strip_prefix("**/") {
        // `**/` matches zero or more directories, so it must be tried at every
        // depth, not just once.
        if match_prefix(rest, text) {
            return true;
        }
        return text
            .find('/')
            .is_some_and(|index| match_prefix(pattern, &text[index + 1..]));
    }
    let (head, tail) = split_first_segment(pattern);
    let (first, remainder) = match text.find('/') {
        Some(index) => (&text[..index], &text[index + 1..]),
        None => (text, ""),
    };
    if !glob_segment(head, first) {
        return false;
    }
    if tail.is_empty() {
        return true;
    }
    match_prefix(tail, remainder)
}

fn split_first_segment(pattern: &str) -> (&str, &str) {
    match pattern.find('/') {
        Some(index) => (&pattern[..index], &pattern[index + 1..]),
        None => (pattern, ""),
    }
}

fn glob_segment(pattern: &str, text: &str) -> bool {
    if pattern == "**" {
        return true;
    }
    // Brace expansion, one level, before any wildcard is interpreted.
    if let Some(open) = pattern.find('{') {
        if let Some(close) = pattern[open..].find('}').map(|i| open + i) {
            let prefix = &pattern[..open];
            let suffix = &pattern[close + 1..];
            return pattern[open + 1..close]
                .split(',')
                .any(|option| glob_segment(&format!("{prefix}{option}{suffix}"), text));
        }
    }
    glob_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_inner(pattern: &[u8], text: &[u8]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }
    match pattern[0] {
        b'*' => {
            for index in 0..=text.len() {
                if glob_inner(&pattern[1..], &text[index..]) {
                    return true;
                }
                // A `*` must not cross a path separator inside a single segment.
                if index < text.len() && text[index] == b'/' {
                    return false;
                }
            }
            false
        }
        b'?' => !text.is_empty() && text[0] != b'/' && glob_inner(&pattern[1..], &text[1..]),
        literal => !text.is_empty() && text[0] == literal && glob_inner(&pattern[1..], &text[1..]),
    }
}

/// Text files only: a NUL byte in the first kilobyte is the classic signal.
fn is_probably_text(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut buffer = [0u8; 1024];
    let Ok(count) = file.read(&mut buffer) else {
        return false;
    };
    !buffer[..count].contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The error half of a result, without needing `Debug` on the success type.
    fn failure<T>(result: Result<T, String>) -> String {
        match result {
            Ok(_) => panic!("expected a refusal, but the call succeeded"),
            Err(error) => error,
        }
    }

    /// A root as the string the IPC layer sends it.
    fn p(path: &Path) -> String {
        path.to_str().unwrap().to_string()
    }

    /// A temporary tree to resolve paths against.
    ///
    /// The name is made unique per *call*, not per test. Rust runs tests in
    /// parallel threads that share one `/tmp`, and a helper deriving its path
    /// only from the test name lets one test's `remove_dir_all` delete a tree
    /// another test is halfway through using. That failure is invisible when the
    /// test is run alone and appears only in a full-suite run, which is the worst
    /// moment to discover a fixture is shared mutable state.
    fn tree(name: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("atomic-fs-{name}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.txt"), "hello").unwrap();
        dir
    }

    /// Two separate trees, standing in for a workspace and a folder the user
    /// added under Settings.
    fn two_trees() -> (PathBuf, PathBuf) {
        (tree("abs-multi-ws"), tree("abs-multi-extra"))
    }

    #[test]
    fn reads_a_file_in_a_second_authorized_folder() {
        // The feature: a user adds a folder once, and a full path into it works
        // from then on, with the workspace still open and unchanged.
        let (workspace, extra) = two_trees();
        let result = fs_read(
            vec![p(&workspace), p(&extra)],
            extra.join("src/a.txt").to_str().unwrap().to_string(),
            None,
            None,
        );
        let read = result.unwrap_or_else(|e| panic!("should reach the added folder: {e}"));
        assert!(read.content.contains("hello"));
    }

    #[test]
    fn lists_a_directory_in_a_second_authorized_folder() {
        let (workspace, extra) = two_trees();
        let result = fs_list(
            vec![p(&workspace), p(&extra)],
            extra.to_str().unwrap().to_string(),
        );
        let listing = result.unwrap_or_else(|e| panic!("should list the added folder: {e}"));
        assert!(listing.entries.iter().any(|e| e.name == "src"));
    }

    #[test]
    fn creates_a_file_in_a_second_authorized_folder() {
        let (workspace, extra) = two_trees();
        let target = extra.join("made.txt");
        fs_write(
            vec![p(&workspace), p(&extra)],
            target.to_str().unwrap().to_string(),
            "written".to_string(),
        )
        .unwrap_or_else(|e| panic!("should write into the added folder: {e}"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "written");
    }

    #[test]
    fn reports_paths_in_a_second_folder_as_paths_that_open_them() {
        // Usable, which is the whole requirement. These entries used to come back
        // relative to the root that held them, and that is not enough: every
        // relative path the model writes is measured from the workspace, so a
        // name from another folder either resolves into the wrong folder or has
        // to be re-joined by hand every time. Spelling the folder out is what
        // makes the listing directly actionable.
        let (workspace, extra) = two_trees();
        let result = fs_list(
            vec![p(&workspace), p(&extra)],
            extra.join("src").to_str().unwrap().to_string(),
        );
        let listing = result.unwrap_or_else(|e| panic!("should list: {e}"));
        let expected = extra.join("src/a.txt");
        assert!(
            listing
                .entries
                .iter()
                .any(|e| e.path == expected.to_str().unwrap()),
            "{:?}",
            listing.entries.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_workspace_wins_when_a_path_is_inside_both_roots() {
        // Ordering is what makes this predictable: the first root that contains
        // the path owns it, so a nested folder does not silently re-root the
        // conversation's own files.
        let workspace = tree("abs-overlap");
        let nested = workspace.join("src");
        let result = fs_list(
            vec![p(&workspace), p(&nested)],
            workspace.join("src").to_str().unwrap().to_string(),
        );
        let listing = result.unwrap_or_else(|e| panic!("should list: {e}"));
        assert!(listing.entries.iter().any(|e| e.path == "src/a.txt"));
    }

    #[test]
    fn still_refuses_a_path_outside_every_authorized_folder() {
        // The one that must not have been loosened by any of the above.
        let (workspace, extra) = two_trees();
        let outside =
            std::env::temp_dir().join(format!("atomic-fs-multi-out-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let error = failure(fs_read(
            vec![p(&workspace), p(&extra)],
            outside.join("secret.txt").to_str().unwrap().to_string(),
            None,
            None,
        ));
        assert!(
            error.contains("outside every folder this conversation may use"),
            "{error}"
        );
    }

    #[test]
    fn names_every_open_folder_so_the_user_can_see_what_to_add() {
        let (workspace, extra) = two_trees();
        let error = failure(fs_list(vec![p(&workspace), p(&extra)], "/etc".to_string()));
        assert!(error.contains(workspace.to_str().unwrap()), "{error}");
        assert!(error.contains(extra.to_str().unwrap()), "{error}");
    }

    #[test]
    fn a_missing_file_is_reported_as_missing_not_as_outside() {
        // The distinction a model acts on: "no such file" means try another name,
        // "outside every folder" means ask the user to open one. A path that is
        // genuinely absent inside an open folder must not read as a permissions
        // problem, or the model will keep re-asking to have folders opened.
        let (workspace, extra) = two_trees();
        let error = failure(fs_read(
            // Both roots, so the assertion is about a file missing from every
            // folder rather than from the first one tried.
            vec![p(&workspace), p(&extra)],
            "not-here.txt".to_string(),
            None,
            None,
        ));
        assert!(error.contains("no such file"), "{error}");
        assert!(!error.contains("outside every folder"), "{error}");
    }

    #[test]
    fn a_listing_of_an_added_folder_hands_back_paths_that_open_it() {
        // Same rule as the searches, for the same reason. `src` on its own is
        // not something the model can read once the workspace happens to hold a
        // `src` too -- and the workspace is the one every relative path is
        // measured from, so an unqualified name resolves there.
        let (workspace, extra) = two_trees();
        let result = fs_list(vec![p(&workspace), p(&extra)], p(&extra)).unwrap();
        let from_extra = extra.join("src").to_str().unwrap().to_string();
        assert!(
            result.entries.iter().any(|e| e.path == from_extra),
            "{:?}",
            result.entries.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_listing_of_the_workspace_stays_relative() {
        // The other half of the contract: the common case must not change shape.
        let (workspace, _extra) = two_trees();
        let result = fs_list(vec![p(&workspace)], ".".to_string()).unwrap();
        assert!(
            result.entries.iter().any(|e| e.path == "src"),
            "{:?}",
            result.entries.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_search_hit_outside_the_workspace_is_reported_as_a_path_that_opens() {
        // Two folders that both hold `src/a.txt` are ordinary, not a contrived
        // case. Reporting both hits as `src/a.txt` gives the model two lines it
        // cannot tell apart, and reading either one lands it in the workspace --
        // so the hit it was just told about cannot be reproduced. The workspace's
        // own hit stays relative, because relative-to-the-open-folder is the
        // form every model already uses; the added folder's is spelled out.
        let (workspace, extra) = two_trees();
        let matches = fs_glob(vec![p(&workspace), p(&extra)], "src/a.txt".to_string()).unwrap();
        assert!(
            matches.contains(&"src/a.txt".to_string()),
            "the workspace hit should stay relative: {matches:?}"
        );
        let from_extra = extra.join("src/a.txt").to_str().unwrap().to_string();
        assert!(
            matches.contains(&from_extra),
            "the added folder's hit should be a path that opens it: {matches:?}"
        );
    }

    #[test]
    fn a_grep_hit_outside_the_workspace_is_reported_as_a_path_that_opens() {
        let (workspace, extra) = two_trees();
        let result = fs_grep(
            vec![p(&workspace), p(&extra)],
            "hello".to_string(),
            None,
            None,
            None,
        )
        .unwrap();
        let from_extra = extra.join("src/a.txt").to_str().unwrap().to_string();
        let paths = result
            .matches
            .iter()
            .map(|m| m.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&from_extra.as_str()), "{paths:?}");
        assert!(paths.contains(&"src/a.txt"), "{paths:?}");
    }

    #[test]
    fn a_missing_absolute_file_in_a_second_folder_reads_as_missing() {
        // The same distinction, reached the other way round. The workspace is
        // listed first and genuinely does not contain this path, so the first
        // root says "outside" -- and that used to be the last word, because the
        // flag it set was also what decided the message. A model told a file it
        // was told to read is "outside every folder" asks the user to open a
        // folder that is already open, and the request never resolves.
        let (workspace, extra) = two_trees();
        let error = failure(fs_read(
            vec![p(&workspace), p(&extra)],
            extra.join("not-here.txt").to_str().unwrap().to_string(),
            None,
            None,
        ));
        assert!(error.contains("no such file"), "{error}");
        assert!(!error.contains("outside every folder"), "{error}");
    }

    #[test]
    fn a_folder_that_disappeared_does_not_take_the_others_down() {
        // A removable drive or an unmounted share should cost the model that
        // folder, not every file operation in the conversation.
        let (workspace, _extra) = two_trees();
        let missing = std::env::temp_dir().join(format!("atomic-fs-gone-{}", std::process::id()));
        let result = fs_read(
            vec![p(&missing), p(&workspace)],
            workspace.join("src/a.txt").to_str().unwrap().to_string(),
            None,
            None,
        );
        assert!(result.is_ok(), "an absent folder must not block the rest");
    }

    #[test]
    fn an_empty_root_list_is_refused_rather_than_reading_anything() {
        let error = failure(fs_list(vec![], ".".to_string()));
        assert!(error.contains("no folder open"), "{error}");
    }

    #[test]
    fn lists_a_directory_named_by_its_full_path() {
        // The case this exists for: the user says "look in /tmp/.../src" and the
        // model writes that in full. Same entries as the relative spelling.
        let root = tree("abs-list");
        let result = fs_list(
            vec![root.to_str().unwrap().to_string()],
            root.join("src").to_str().unwrap().to_string(),
        )
        .unwrap_or_else(|e| panic!("listing the workspace root should work: {e}"));
        assert!(result.entries.iter().any(|e| e.name == "a.txt"));
    }

    #[test]
    fn reads_a_file_named_by_its_full_path() {
        let root = tree("abs-read");
        let read = fs_read(
            vec![root.to_str().unwrap().to_string()],
            root.join("src/a.txt").to_str().unwrap().to_string(),
            None,
            None,
        )
        .unwrap_or_else(|e| panic!("reading a file inside the workspace should work: {e}"));
        assert!(read.content.contains("hello"));
    }

    #[test]
    fn creates_a_file_at_a_full_path_inside_the_workspace() {
        let root = tree("abs-write");
        let target = root.join("src/made-here.txt");
        fs_write(
            vec![root.to_str().unwrap().to_string()],
            target.to_str().unwrap().to_string(),
            "written".to_string(),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "written");
    }

    #[test]
    fn refuses_a_full_path_outside_the_workspace() {
        // And the same input one directory up is still refused. This is the whole
        // point: an absolute path is not a privilege, only a longer spelling.
        let root = tree("abs-escape");
        let outside =
            std::env::temp_dir().join(format!("atomic-fs-sibling-{}", std::process::id()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        let error = failure(fs_read(
            vec![root.to_str().unwrap().to_string()],
            outside.join("secret.txt").to_str().unwrap().to_string(),
            None,
            None,
        ));
        assert!(
            error.contains("outside every folder this conversation may use"),
            "{error}"
        );
    }

    #[test]
    fn names_the_open_folder_when_refusing_so_the_user_can_be_told_which_one() {
        // "Outside the workspace" alone leaves the model nothing to repeat to the
        // user, and the fix -- open this folder -- needs to be nameable.
        let root = tree("abs-message");
        let error = failure(fs_list(
            vec![root.to_str().unwrap().to_string()],
            "/etc".to_string(),
        ));
        assert!(error.contains(root.to_str().unwrap()), "{error}");
    }

    #[test]
    fn a_bare_extension_matches_by_basename() {
        assert!(glob_match("*.ts", "src/app.ts"));
        assert!(!glob_match("*.ts", "src/app.js"));
    }

    #[test]
    fn a_slashed_pattern_is_anchored() {
        assert!(glob_match("src/**/*.ts", "src/lib/a.ts"));
        assert!(!glob_match("src/**/*.ts", "lib/a.ts"));
    }

    #[test]
    fn double_star_spans_zero_directories() {
        assert!(glob_match("src/**/*.ts", "src/a.ts"));
        assert!(glob_match("src/**/*.ts", "src/x/y/z/a.ts"));
    }

    #[test]
    fn single_star_stops_at_a_separator() {
        assert!(glob_match("src/*.ts", "src/a.ts"));
        assert!(!glob_match("src/*.ts", "src/x/a.ts"));
    }

    #[test]
    fn braces_expand() {
        assert!(glob_match("*.{ts,tsx}", "src/app.tsx"));
        assert!(!glob_match("*.{ts,tsx}", "src/app.js"));
    }

    #[test]
    fn question_mark_is_one_character() {
        assert!(glob_match("a?.txt", "ab.txt"));
        assert!(!glob_match("a?.txt", "abc.txt"));
    }

    #[test]
    fn a_binary_file_is_not_treated_as_text() {
        let dir = std::env::temp_dir().join("atomic-is-text");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blob.bin");
        std::fs::write(&path, [0u8, 1, 2, 3, 0]).unwrap();
        assert!(!is_probably_text(&path));
        let text = dir.join("a.txt");
        std::fs::write(&text, "hello").unwrap();
        assert!(is_probably_text(&text));
    }
}
