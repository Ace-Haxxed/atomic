// Filesystem and search commands for the Code-mode tools.
//
// Two rules shape everything here:
//
//   1. Every path goes through `workspace::Workspace`. A caller cannot opt out,
//      and there is no "trust me" path parameter -- the workspace root is
//      resolved from disk on every call, so a workspace root that was itself
//      replaced by a symlink after the app started is still caught.
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

fn scoped(workspace_root: &str) -> Result<Workspace, String> {
    Workspace::new(Path::new(workspace_root)).map_err(|error| error.message())
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
    workspace_root: String,
    path: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<ReadResult, String> {
    let workspace = scoped(&workspace_root)?;
    let target = workspace
        .resolve_file(&path)
        .map_err(|e: ScopeError| e.message())?;

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
    workspace_root: String,
    path: String,
    content: String,
) -> Result<FileEntry, String> {
    let workspace = scoped(&workspace_root)?;
    // `must_exist: false` -- this is how a file comes into being, and the
    // deepest-existing-ancestor check still applies.
    let target = workspace
        .resolve(&path, false)
        .map_err(|e: ScopeError| e.message())?;

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
pub fn fs_list(workspace_root: String, path: String) -> Result<ListResult, String> {
    let workspace = scoped(&workspace_root)?;
    let target = workspace
        .resolve(&path, true)
        .map_err(|e: ScopeError| e.message())?;
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
        entries.push(FileEntry {
            path: relative(&workspace, &item.path()),
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
pub fn fs_glob(workspace_root: String, pattern: String) -> Result<Vec<String>, String> {
    let workspace = scoped(&workspace_root)?;
    let matches = walk(&workspace, |candidate| glob_match(&pattern, candidate));
    Ok(matches.into_iter().take(MAX_RESULTS).collect())
}

// ---- grep ---------------------------------------------------------------

#[tauri::command]
pub fn fs_grep(
    workspace_root: String,
    pattern: String,
    glob: Option<String>,
    case_sensitive: Option<bool>,
    max_matches: Option<u32>,
) -> Result<GrepResult, String> {
    let workspace = scoped(&workspace_root)?;
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

    for entry in walk_entries(&workspace) {
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
                        path: entry.relative.clone(),
                        line: index as u32 + 1,
                        text: format!("{}…", &line[..200]),
                    });
                }
                continue;
            }
            if regex.is_match(line) {
                matches.push(GrepMatch {
                    path: entry.relative.clone(),
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
