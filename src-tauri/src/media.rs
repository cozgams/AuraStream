//! Media layer: Cover image decryption + HLS streaming proxy.
//!
//! Covers are encrypted with AES-128-CBC. Internal m3u8 segments/keys are routed
//! through the local custom protocol to bypass webview CORS restrictions.

use crate::net::fetch_bytes;
use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex, Weak};
use tauri::http::{Response, StatusCode};

/// Platform-specific base URI for local custom protocol.
///
/// Tauri custom protocol URI format per platform. Segments and keys are rewritten to match.
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux uses loopback HTTP because WebKitGTK GStreamer player requires HTTP schemes.
#[cfg(target_os = "linux")]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

struct CacheEntry<V> {
    val: V,
    bytes: usize,
    seq: u64,
}

struct BoundedCache<V> {
    map: HashMap<String, CacheEntry<V>>,
    total_bytes: usize,
    next_seq: u64,
}

impl<V: Clone> BoundedCache<V> {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            total_bytes: 0,
            next_seq: 1,
        }
    }

    fn get(&mut self, key: &str) -> Option<V> {
        let next = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        let entry = self.map.get_mut(key)?;
        entry.seq = next;
        Some(entry.val.clone())
    }

    fn put(&mut self, key: String, val: V, bytes: usize, max_count: usize, max_total_bytes: usize) {
        if let Some(prev) = self.map.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(prev.bytes);
        }
        while !self.map.is_empty()
            && (self.map.len() >= max_count
                || (max_total_bytes > 0 && self.total_bytes.saturating_add(bytes) > max_total_bytes))
        {
            let oldest_key = self
                .map
                .iter()
                .min_by_key(|(_, entry)| entry.seq)
                .map(|(k, _)| k.clone());
            match oldest_key {
                Some(k) => {
                    if let Some(old) = self.map.remove(&k) {
                        self.total_bytes = self.total_bytes.saturating_sub(old.bytes);
                    }
                }
                None => break,
            }
        }
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.map.insert(key, CacheEntry { val, bytes, seq });
    }

    fn clear(&mut self) {
        self.map.clear();
        self.total_bytes = 0;
    }
}

static IMG_CACHE: Lazy<Mutex<BoundedCache<Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(BoundedCache::new()));
type ImageResult = Result<(String, Arc<Vec<u8>>), String>;
type ImageLoad = tokio::sync::OnceCell<ImageResult>;
type CachedMediaPayload = (String, Arc<Vec<u8>>);
type ImageLoadingMap = HashMap<(u64, String), Weak<ImageLoad>>;

// Deduplicate concurrent image requests; share download and decryption.
static IMG_LOADING: Lazy<Mutex<ImageLoadingMap>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static IMG_GENERATION: AtomicU64 = AtomicU64::new(0);
static PL_CACHE: Lazy<Mutex<BoundedCache<Arc<String>>>> =
    Lazy::new(|| Mutex::new(BoundedCache::new()));
/// In-memory cache for AES Keys and segments to avoid duplicate downloads during seeking.
static KEY_CACHE: Lazy<Mutex<BoundedCache<CachedMediaPayload>>> =
    Lazy::new(|| Mutex::new(BoundedCache::new()));
static SEG_CACHE: Lazy<Mutex<BoundedCache<CachedMediaPayload>>> =
    Lazy::new(|| Mutex::new(BoundedCache::new()));

const IMG_CACHE_MAX: usize = 360;
const PL_CACHE_MAX: usize = 120;
const KEY_CACHE_MAX: usize = 200;
const SEG_CACHE_MAX: usize = 64;
const SEG_CACHE_MAX_BYTES: usize = 6 * 1024 * 1024;
#[cfg(any(target_os = "android", target_os = "ios"))]
const IMG_CACHE_TOTAL_MAX_BYTES: usize = 24 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const IMG_CACHE_TOTAL_MAX_BYTES: usize = 64 * 1024 * 1024;
#[cfg(any(target_os = "android", target_os = "ios"))]
const SEG_CACHE_TOTAL_MAX_BYTES: usize = 36 * 1024 * 1024;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SEG_CACHE_TOTAL_MAX_BYTES: usize = 96 * 1024 * 1024;
const PL_CACHE_TOTAL_MAX_BYTES: usize = 8 * 1024 * 1024;
const KEY_CACHE_TOTAL_MAX_BYTES: usize = 2 * 1024 * 1024;

fn cache_put<V: Clone>(
    cache: &Mutex<BoundedCache<V>>,
    key: String,
    val: V,
    bytes: usize,
    max: usize,
    max_total_bytes: usize,
) {
    if let Ok(mut c) = cache.lock() {
        c.put(key, val, bytes, max, max_total_bytes);
    }
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad
        && buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Fetch cover image: Return cached if present; share in-flight download and decryption.
pub async fn load_image(url: &str) -> ImageResult {
    let generation = {
        if let Ok(mut cache) = IMG_CACHE.lock() {
            if let Some(hit) = cache.get(url) {
                let kind = image_kind(&hit).unwrap_or("image/jpeg");
                return Ok((kind.to_string(), hit));
            }
        }
        IMG_GENERATION.load(Ordering::Acquire)
    };
    let loading = {
        let mut requests = match IMG_LOADING.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        requests.retain(|_, request| request.strong_count() > 0);
        let key = (generation, url.to_string());
        if let Some(request) = requests.get(&key).and_then(Weak::upgrade) {
            request
        } else {
            let request = Arc::new(ImageLoad::new());
            requests.insert(key, Arc::downgrade(&request));
            request
        }
    };
    loading.get_or_init(|| download_image(url, generation)).await.clone()
}

async fn download_image(url: &str, generation: u64) -> ImageResult {
    // Check if another request finished between cache check and task acquisition
    if let Ok(mut cache) = IMG_CACHE.lock() {
        if let Some(hit) = cache.get(url) {
            let kind = image_kind(&hit).unwrap_or("image/jpeg");
            return Ok((kind.to_string(), hit));
        }
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "Failed to decrypt cover image".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let img_bytes = plain.len();
    let arc = Arc::new(plain);
    if let Ok(mut cache) = IMG_CACHE.lock() {
        // After clearing cache, in-flight downloads will not pollute the new cache generation
        if IMG_GENERATION.load(Ordering::Acquire) == generation {
            cache.put(
                url.to_string(),
                arc.clone(),
                img_bytes,
                IMG_CACHE_MAX,
                IMG_CACHE_TOTAL_MAX_BYTES,
            );
        }
    }
    Ok((kind, arc))
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// Quoted strings in attribute lists may contain commas; cannot simply split on comma.
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim().eq_ignore_ascii_case("URI") {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    map_uri_attributes(line, |uri| format!("{prefix}/seg?u={}", enc(uri)))
}

/// Fetch m3u8 and rewrite key and segment URLs to local protocol.
pub async fn load_playlist(url: &str, prefix: &str) -> Result<Arc<String>, String> {
    // Cache key includes prefix as rewritten URLs vary by scheme
    let cache_key = format!("{prefix}|{url}");
    if let Ok(mut cache) = PL_CACHE.lock() {
        if let Some(hit) = cache.get(&cache_key) {
            return Ok(hit);
        }
    }
    let (_, bytes) = fetch_bytes(url).await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Playlist is not valid UTF-8 text")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("Response is not a valid HLS playlist".into());
    }
    let rewritten = rewrite_playlist(url, text, prefix);
    let len = rewritten.len();
    let arc = Arc::new(rewritten);
    cache_put(&PL_CACHE, cache_key, arc.clone(), len, PL_CACHE_MAX, PL_CACHE_TOTAL_MAX_BYTES);
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // Content steering disabled; retain DATERANGE for timeline and metadata.
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // All URIs (KEY, MAP, MEDIA, SESSION-KEY, PART, PRELOAD-HINT) must pass target checks.
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr(&absolute, prefix));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format!("{prefix}/seg?u={}", enc(&absolute)));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// In-memory caching for segments and AES keys during playback and seeking.
pub async fn load_segment(url: &str) -> Result<(Option<String>, Arc<Vec<u8>>), String> {
    if let Ok(mut cache) = KEY_CACHE.lock() {
        if let Some((ctype, hit)) = cache.get(url) {
            return Ok((Some(ctype), hit));
        }
    }
    if let Ok(mut cache) = SEG_CACHE.lock() {
        if let Some((ctype, hit)) = cache.get(url) {
            return Ok((Some(ctype), hit));
        }
    }
    let (ctype, bytes) = fetch_bytes(url).await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if len <= 65536 {
        cache_put(&KEY_CACHE, url.to_string(), (mime.clone(), arc.clone()), len, KEY_CACHE_MAX, KEY_CACHE_TOTAL_MAX_BYTES);
    } else if len <= SEG_CACHE_MAX_BYTES {
        cache_put(&SEG_CACHE, url.to_string(), (mime.clone(), arc.clone()), len, SEG_CACHE_MAX, SEG_CACHE_TOTAL_MAX_BYTES);
    }
    Ok((Some(mime), arc))
}

/// Clear in-memory caches for covers, playlists, keys, and segments.
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() {
        IMG_GENERATION.fetch_add(1, Ordering::AcqRel);
        g.clear();
    }
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = KEY_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_CACHE.lock() {
        g.clear();
    }
}

/* ------------------------- Protocol Response ------------------------- */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        // Byte range handling applied after manifest rewrite/decryption.
        .header("Content-Length", len)
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Provide single byte range for native players; fall back to 200 for invalid ranges.
fn apply_byte_range(mut response: Response<Vec<u8>>, range: Option<&str>) -> Response<Vec<u8>> {
    use tauri::http::HeaderValue;

    if response.status() != StatusCode::OK {
        return response;
    }
    response.headers_mut().insert("Accept-Ranges", HeaderValue::from_static("bytes"));
    let Some((first, last)) = range
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
    else {
        return response;
    };
    let number = |s: &str| -> Option<usize> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    let len = response.body().len();
    let bounds = if first.is_empty() {
        let Some(suffix) = number(last) else { return response };
        (suffix > 0 && len > 0).then(|| (len.saturating_sub(suffix), len - 1))
    } else {
        let Some(start) = number(first) else { return response };
        let end = if last.is_empty() {
            len.saturating_sub(1)
        } else {
            let Some(end) = number(last) else { return response };
            if end < start { return response; }
            end
        };
        (start < len).then(|| (start, end.min(len - 1)))
    };

    let content_range = if let Some((start, end)) = bounds {
        // Slice in-place without duplicating full segment bytes.
        let body = response.body_mut();
        body.truncate(end + 1);
        if start > 0 {
            body.drain(..start);
        }
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        format!("bytes {start}-{end}/{len}")
    } else {
        response.body_mut().clear();
        *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
        response.headers_mut().insert("Cache-Control", HeaderValue::from_static("no-store"));
        format!("bytes */{len}")
    };
    let length = response.body().len().to_string();
    if let Ok(val) = HeaderValue::from_str(&length) {
        response.headers_mut().insert("Content-Length", val);
    }
    if let Ok(val) = HeaderValue::from_str(&content_range) {
        response.headers_mut().insert("Content-Range", val);
    }
    response
}

/// Sub-playlists from master manifests returned via /seg must also be rewritten.
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                rewrite_playlist(target, text, origin).into_bytes(),
                // Rewriting nested URIs does not require disabling the upstream cache policy.
                "public, max-age=3600",
            ),
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
    )
}

fn rewrite_offline_playlist(id: &str, text: &str, origin: &str) -> String {
    let mut out = String::with_capacity(text.len() + 256);
    let prefix = format!("{origin}/offline/{id}");
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            if line.to_ascii_lowercase().contains("uri=\"") {
                let mut valid = true;
                let rewritten = map_uri_attributes(line, |uri| {
                    let clean = uri.trim_start_matches("./");
                    if clean.starts_with("http://")
                        || clean.starts_with("https://")
                        || clean.starts_with("//")
                        || !crate::downloader::is_safe_segment(clean)
                    {
                        valid = false;
                        return String::new();
                    }
                    format!("{prefix}/{clean}")
                });
                if valid {
                    let stripped = rewritten.replace(&prefix, "");
                    let lower_stripped = stripped.to_ascii_lowercase();
                    let has_external = lower_stripped.contains("http://")
                        || lower_stripped.contains("https://")
                        || lower_stripped.contains("://")
                        || lower_stripped.contains("\"//")
                        || lower_stripped.contains("x-asset-list");
                    if !has_external {
                        out.push_str(&rewritten);
                        out.push('\n');
                    }
                }
                continue;
            }
            let lower_line = line.to_ascii_lowercase();
            if lower_line.contains("http://")
                || lower_line.contains("https://")
                || lower_line.contains("://")
                || lower_line.contains("x-asset-list")
            {
                continue;
            }
            out.push_str(line);
        } else {
            let clean = line.trim_start_matches("./");
            if clean.starts_with("http://")
                || clean.starts_with("https://")
                || clean.starts_with("//")
                || !crate::downloader::is_safe_segment(clean)
            {
                continue;
            }
            out.push_str(&format!("{prefix}/{clean}"));
        }
        out.push('\n');
    }
    out
}

enum ParsedRange {
    None,
    Unsatisfiable,
    Bounds(u64, u64),
}

fn parse_range_header(range: Option<&str>, len: u64) -> ParsedRange {
    let Some((first, last)) = range
        .and_then(|v| v.trim().strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
    else {
        return ParsedRange::None;
    };
    let number = |s: &str| -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    if first.is_empty() {
        let Some(suffix) = number(last) else {
            return ParsedRange::None;
        };
        if suffix > 0 && len > 0 {
            ParsedRange::Bounds(len.saturating_sub(suffix), len - 1)
        } else {
            ParsedRange::Unsatisfiable
        }
    } else {
        let Some(start) = number(first) else {
            return ParsedRange::None;
        };
        let end = if last.is_empty() {
            len.saturating_sub(1)
        } else {
            let Some(end) = number(last) else {
                return ParsedRange::None;
            };
            if end < start {
                return ParsedRange::None;
            }
            end
        };
        if start < len {
            ParsedRange::Bounds(start, end.min(len - 1))
        } else {
            ParsedRange::Unsatisfiable
        }
    }
}

fn serve_offline_binary_file(
    file_path: &std::path::Path,
    ctype: &str,
    range: Option<&str>,
    head_only: bool,
) -> Response<Vec<u8>> {
    const OFFLINE_CHUNK_CAP: u64 = 4 * 1024 * 1024;
    const UNRANGED_FULL_CAP: u64 = 64 * 1024 * 1024;

    let Ok(mut file) = std::fs::File::open(file_path) else {
        return respond(404, "text/plain", b"offline file not found".to_vec(), "no-store");
    };
    let Ok(meta) = file.metadata() else {
        return respond(404, "text/plain", b"offline file not found".to_vec(), "no-store");
    };
    if !meta.is_file() {
        return respond(404, "text/plain", b"offline file not found".to_vec(), "no-store");
    }
    let len = meta.len();

    if head_only {
        return Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", ctype)
            .header("Content-Length", len.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    match parse_range_header(range, len) {
        ParsedRange::Unsatisfiable => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header("Content-Type", ctype)
            .header("Content-Length", "0")
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes */{len}"))
            .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new())),
        ParsedRange::Bounds(start, end) => {
            let capped_end = end.min(start.saturating_add(OFFLINE_CHUNK_CAP - 1));
            let to_read = capped_end - start + 1;
            if file.seek(SeekFrom::Start(start)).is_err() {
                return respond(500, "text/plain", b"failed seeking offline file".to_vec(), "no-store");
            }
            let mut buf = Vec::with_capacity(to_read as usize);
            if file.take(to_read).read_to_end(&mut buf).is_err() {
                return respond(500, "text/plain", b"failed reading offline file".to_vec(), "no-store");
            }
            if buf.is_empty() {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("Content-Type", ctype)
                    .header("Content-Length", "0")
                    .header("Accept-Ranges", "bytes")
                    .header("Content-Range", format!("bytes */{len}"))
                    .header("Cache-Control", "no-store")
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new()));
            }
            let actual_end = start + (buf.len() as u64) - 1;
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Type", ctype)
                .header("Content-Length", buf.len().to_string())
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes {start}-{actual_end}/{len}"))
                .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .body(buf)
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
        ParsedRange::None => {
            if len <= UNRANGED_FULL_CAP {
                if let Ok(full_bytes) = std::fs::read(file_path) {
                    let mut resp = respond(200, ctype, full_bytes, "public, max-age=31536000, immutable");
                    resp.headers_mut()
                        .insert("Accept-Ranges", tauri::http::HeaderValue::from_static("bytes"));
                    return resp;
                }
            }
            let to_read = OFFLINE_CHUNK_CAP.min(len);
            let mut buf = Vec::with_capacity(to_read as usize);
            if file.take(to_read).read_to_end(&mut buf).is_err() || buf.is_empty() {
                return respond(500, "text/plain", b"failed reading offline file".to_vec(), "no-store");
            }
            let actual_end = (buf.len() as u64) - 1;
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header("Content-Type", ctype)
                .header("Content-Length", buf.len().to_string())
                .header("Accept-Ranges", "bytes")
                .header("Content-Range", format!("bytes 0-{actual_end}/{len}"))
                .header("Access-Control-Expose-Headers", "Content-Length, Content-Type, Accept-Ranges, Content-Range")
                .header("X-Content-Type-Options", "nosniff")
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .body(buf)
                .unwrap_or_else(|_| Response::new(Vec::new()))
        }
    }
}

async fn handle_offline_asset(path: &str, origin: &str, range: Option<&str>, head_only: bool) -> Response<Vec<u8>> {
    let Some(rest) = path.strip_prefix("/offline/") else {
        return respond(404, "text/plain", b"not found".to_vec(), "no-store");
    };
    let Some((id, file_name)) = rest.split_once('/') else {
        return respond(400, "text/plain", b"invalid offline asset path".to_vec(), "no-store");
    };
    let Some(file_path) = crate::downloader::offline_file_path(id, file_name) else {
        return respond(403, "text/plain", b"forbidden".to_vec(), "no-store");
    };
    let id = id.to_string();
    let file_name = file_name.to_string();
    let origin = origin.to_string();
    let range = range.map(str::to_string);

    tokio::task::spawn_blocking(move || {
        let lower = file_name.to_ascii_lowercase();
        let is_playlist = lower.ends_with(".m3u8");
        let is_image = lower == "cover.img"
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp");

        if is_playlist || is_image {
            let actual_path = if is_playlist && !file_path.exists() {
                // If index.m3u8 is requested but download was saved as video.mp4
                let mp4_fallback = file_path.with_file_name("video.mp4");
                if mp4_fallback.exists() {
                    return serve_offline_binary_file(&mp4_fallback, "video/mp4", range.as_deref(), head_only);
                }
                file_path
            } else {
                file_path
            };

            let Ok(bytes) = std::fs::read(&actual_path) else {
                return respond(404, "text/plain", b"offline file not found".to_vec(), "no-store");
            };
            let resp = if is_playlist {
                match std::str::from_utf8(&bytes) {
                    Ok(text) => respond(
                        200,
                        "application/vnd.apple.mpegurl",
                        rewrite_offline_playlist(&id, text, &origin).into_bytes(),
                        "no-store",
                    ),
                    Err(_) => respond(500, "text/plain", b"invalid offline playlist".to_vec(), "no-store"),
                }
            } else {
                let kind = image_kind(&bytes).unwrap_or("image/jpeg");
                respond(200, kind, bytes, "private, max-age=86400")
            };
            let mut ranged = apply_byte_range(resp, range.as_deref());
            if head_only {
                ranged.body_mut().clear();
            }
            return ranged;
        }

        let actual_path = if (lower.ends_with(".mp4") || lower.ends_with(".m4s")) && !file_path.exists() {
            // If video.mp4 was requested but download is structured HLS
            let m3u8_fallback = file_path.with_file_name("index.m3u8");
            if m3u8_fallback.exists() {
                if let Ok(bytes) = std::fs::read(&m3u8_fallback) {
                    let text = std::str::from_utf8(&bytes).unwrap_or("");
                    let resp = respond(
                        200,
                        "application/vnd.apple.mpegurl",
                        rewrite_offline_playlist(&id, text, &origin).into_bytes(),
                        "no-store",
                    );
                    let mut ranged = apply_byte_range(resp, range.as_deref());
                    if head_only {
                        ranged.body_mut().clear();
                    }
                    return ranged;
                }
            }
            file_path
        } else {
            file_path
        };

        let ctype = if lower.ends_with(".ts") {
            "video/mp2t"
        } else if lower.ends_with(".mp4") || lower.ends_with(".m4s") {
            "video/mp4"
        } else {
            "application/octet-stream"
        };
        serve_offline_binary_file(&actual_path, ctype, range.as_deref(), head_only)
    })
    .await
    .unwrap_or_else(|_| respond(500, "text/plain", b"offline worker failed".to_vec(), "no-store"))
}

/// Unified protocol handler entry: `<LOCAL_ORIGIN>/img?u=`, `/hls?u=`, `/seg?u=`, `/offline/{id}/{file}`
///
/// `origin` is the base custom protocol URI used to rewrite m3u8 segment and key URLs.
#[cfg(test)]
pub async fn handle(path: &str, query: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    handle_with_method(path, query, origin, range, false).await
}

pub async fn handle_with_method(
    path: &str,
    query: &str,
    origin: &str,
    range: Option<&str>,
    head_only: bool,
) -> Response<Vec<u8>> {
    if path.starts_with("/offline/") {
        return handle_offline_asset(path, origin, range, head_only).await;
    }
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => {
                respond(200, &kind, bytes.as_ref().clone(), "public, max-age=86400")
            }
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    let mut response = apply_byte_range(response, range);
    if head_only {
        response.body_mut().clear();
    }
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "content_type": response.headers().get("Content-Type").and_then(|v| v.to_str().ok()), "content_range": response.headers().get("Content-Range").and_then(|v| v.to_str().ok()), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_range_probe_returns_only_requested_playlist_bytes() {
        let body = b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n";
        for (range, start, end) in [
            ("bytes=0-1", 0, 1),
            ("bytes=0-7", 0, 7),
            ("bytes=8-", 8, body.len() - 1),
            ("bytes=-4", body.len() - 4, body.len() - 1),
            ("bytes=0-999", 0, body.len() - 1),
        ] {
            let response = apply_byte_range(
                respond(200, "application/vnd.apple.mpegurl", body.to_vec(), "no-store"),
                Some(range),
            );
            assert_eq!(response.status(), 206, "{range}");
            assert_eq!(response.body().as_slice(), &body[start..=end]);
            assert_eq!(response.headers()["Content-Type"], "application/vnd.apple.mpegurl");
            assert_eq!(response.headers()["Content-Length"], (end - start + 1).to_string());
            assert_eq!(response.headers()["Content-Range"], format!("bytes {start}-{end}/{}", body.len()));
        }
    }

    #[test]
    fn ranges_preserve_full_responses_and_reject_unsatisfiable_offsets() {
        for range in [None, Some("bytes=0-1,4-5"), Some("bytes=bad"), Some("bytes=3-1"), Some("items=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", b"data".to_vec(), "no-store"), range);
            assert_eq!(response.status(), 200);
            assert_eq!(response.body(), b"data");
            assert!(!response.headers().contains_key("Content-Range"));
        }
        for (body, range) in [(b"data".as_slice(), "bytes=4-"), (b"data".as_slice(), "bytes=-0"), (b"".as_slice(), "bytes=0-1")] {
            let response = apply_byte_range(respond(200, "video/mp2t", body.to_vec(), "no-store"), Some(range));
            assert_eq!(response.status(), 416);
            assert!(response.body().is_empty());
            assert_eq!(response.headers()["Content-Length"], "0");
            assert_eq!(response.headers()["Content-Range"], format!("bytes */{}", body.len()));
        }
        let error = apply_byte_range(respond(502, "text/plain", b"upstream failed".to_vec(), "no-store"), Some("bytes=0-1"));
        assert_eq!(error.status(), 502);
        assert_eq!(error.body(), b"upstream failed");
        assert!(!error.headers().contains_key("Accept-Ranges"));
    }

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        assert!(!body.contains("URI=\"http://127.0.0.1/key\""));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    /// Network test: skipped by default.
    #[tokio::test]
    #[ignore = "Live network test; run with --ignored"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // Fetch single segment for verification
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// Offline regression test.
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // Segments must be resolved to absolute origin URLs retaining query signatures.
        assert!(
            body.contains("https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"),
            "segment not absolutized with query: {body}"
        );
        // Encrypted keys must route through local proxy to bypass CORS.
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    #[test]
    fn offline_playlist_rewrite_is_strictly_local() {
        let text = "#EXTM3U\n\
            #EXT-X-KEY:METHOD=AES-128,URI=\"key_0.key\",IV=0x01\n\
            #EXT-X-MEDIA:TYPE=AUDIO,uri=\"https://evil.invalid/audio.m3u8\"\n\
            #EXT-X-MIXED:URI=\"key_0.key\",SERVER-URI=\"https://evil.invalid/steer\"\n\
            #EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"https://evil.invalid/ad\"\n\
            #EXT-X-PRELOAD-HINT:TYPE=PART,URI=\"https://evil.invalid/part.m4s\"\n\
            #EXTINF:4.0,\n\
            seg_00000.ts\n\
            https://evil.invalid/leak.ts\n";
        let out = rewrite_offline_playlist("101_1", text, LOCAL_ORIGIN);
        assert!(out.contains(&format!("URI=\"{LOCAL_ORIGIN}/offline/101_1/key_0.key\"")));
        assert!(out.contains(&format!("{LOCAL_ORIGIN}/offline/101_1/seg_00000.ts")));
        assert!(!out.contains("evil.invalid"), "external URL leaked into offline playlist: {out}");
    }

    #[test]
    fn offline_binary_range_reads_slice_and_head_returns_empty_body() {
        let dir = std::env::temp_dir().join(format!("aurastream-media-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("video.mp4");
        std::fs::write(&file, b"0123456789abcdef").unwrap();

        let partial = serve_offline_binary_file(&file, "video/mp4", Some("bytes=4-9"), false);
        assert_eq!(partial.status(), 206);
        assert_eq!(partial.body().as_slice(), b"456789");
        assert_eq!(partial.headers()["Content-Range"], "bytes 4-9/16");
        assert_eq!(partial.headers()["Content-Length"], "6");

        let oob = serve_offline_binary_file(&file, "video/mp4", Some("bytes=99-120"), false);
        assert_eq!(oob.status(), 416);
        assert_eq!(oob.headers()["Content-Range"], "bytes */16");

        let head = serve_offline_binary_file(&file, "video/mp4", None, true);
        assert_eq!(head.status(), 200);
        assert!(head.body().is_empty());
        assert_eq!(head.headers()["Content-Length"], "16");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Offline regression test with known plaintext.
    /// Network test: skipped by default.
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    /// Network test: skipped by default.
    /// `AURASTREAM_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "Live network test: requires TEST_COVER_URL"]
    async fn cover_decrypt_works() {
        let url = crate::env::var("TEST_COVER_URL")
            .expect("TEST_COVER_URL must be set to a valid cover URL");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
