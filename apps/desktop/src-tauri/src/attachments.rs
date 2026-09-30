// Attachments handed to the agent as context.
//
// Files are read here and returned as base64, because the agent runtime is
// host-agnostic and has no filesystem of its own. Size is capped so pasting a
// 2 GB video cannot exhaust memory.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub data: String,
    pub size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// 20 MB. Large enough for a screenshot or a source file, small enough to be safe.
const MAX_BYTES: usize = 20 * 1024 * 1024;

pub fn from_path(path: &std::path::Path) -> Result<Attachment, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if metadata.len() as usize > MAX_BYTES {
        return Err(format!(
            "{} is larger than the {} MB attachment limit",
            path.display(),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".to_string());
    Ok(Attachment {
        id: new_id(&name),
        name: name.clone(),
        mime_type: mime_for(&name),
        size: bytes.len(),
        data: base64_encode(&bytes),
        path: Some(path.to_string_lossy().to_string()),
    })
}

pub fn from_bytes(name: &str, bytes: &[u8]) -> Result<Attachment, String> {
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "{name} is larger than the {} MB attachment limit",
            MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(Attachment {
        id: new_id(name),
        name: name.to_string(),
        mime_type: mime_for(name),
        size: bytes.len(),
        data: base64_encode(bytes),
        path: None,
    })
}

/// A stable key for the same file name, so a re-read of the same attachment does
/// not remount the preview in the composer.
fn new_id(name: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("att_{hash:016x}")
}

fn mime_for(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "log" | "txt" => "text/plain",
        // Source files go to the model as text; a real MIME type would only make
        // an upstream API reject an attachment it could have read fine.
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "py" | "go" | "java" | "kt"
        | "kts" | "rb" | "php" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "swift" | "sh"
        | "bash" | "zsh" | "sql" | "toml" | "yaml" | "yml" | "css" | "scss" | "html" => {
            "text/plain"
        }
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Minimal standard-alphabet base64. Avoids pulling in a base64 crate for one use.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Inverse of `base64_encode`. The webview sends pasted images this way, because
/// a `Uint8Array` does not survive the JSON IPC hop intact.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut bits = 0u32;
    let mut accumulated = 0u32;
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for (index, byte) in input.bytes().enumerate() {
        if byte == b'=' {
            break;
        }
        if byte.is_ascii_whitespace() {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("bad base64 at position {index}")),
        };
        accumulated = (accumulated << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulated >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Paste path: the webview already has the image bytes, we only wrap them.
pub fn from_base64(name: &str, data: &str) -> Result<Attachment, String> {
    let bytes = base64_decode(data)?;
    from_bytes(name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for length in 0..64usize {
            let bytes: Vec<u8> = (0..length).map(|i| (i * 7 % 256) as u8).collect();
            let encoded = base64_encode(&bytes);
            let decoded = base64_decode(&encoded).expect("decodes");
            assert_eq!(decoded, bytes, "round trip failed at length {length}");
        }
    }

    #[test]
    fn base64_matches_known_vector() {
        // "atomic" -> "YXRvbWlj"; checks padding and alphabet, not just symmetry.
        assert_eq!(base64_encode(b"atomic"), "YXRvbWlj");
        assert_eq!(base64_decode("YXRvbWlj").unwrap(), b"atomic");
    }

    #[test]
    fn base64_rejects_invalid_characters() {
        assert!(base64_decode("!!!!").is_err());
    }

    #[test]
    fn base64_decode_stops_at_padding() {
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert_eq!(base64_decode("YWI=").unwrap(), b"ab");
    }

    #[test]
    fn mime_types_cover_the_common_pastes() {
        assert_eq!(mime_for("Screenshot.PNG"), "image/png");
        assert_eq!(mime_for("notes.md"), "text/plain");
        assert_eq!(mime_for("main.rs"), "text/plain");
        assert_eq!(mime_for("archive.tar.gz"), "application/octet-stream");
        assert_eq!(mime_for("LICENSE"), "application/octet-stream");
    }

    #[test]
    fn from_bytes_respects_the_size_cap() {
        let too_big = vec![0u8; MAX_BYTES + 1];
        let error = from_bytes("big.bin", &too_big).unwrap_err();
        assert!(error.contains("20 MB"), "unexpected error: {error}");
    }

    #[test]
    fn attachment_id_is_stable_for_the_same_name() {
        let one = from_bytes("a.png", b"one").unwrap();
        let two = from_bytes("a.png", b"two").unwrap();
        assert_eq!(one.id, two.id, "id must be derived from the name only");
    }
}
