//! Optional, bounded playback diagnostics. Never write media URLs, credentials or response bodies.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_FILE: u64 = 2 * 1024 * 1024;
static ENABLED: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(0);
static LOG: Lazy<Mutex<Journal>> = Lazy::new(|| Mutex::new(Journal::default()));

#[derive(Default)]
struct Journal {
    dir: Option<PathBuf>,
    enabled: bool,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct Entry {
    event: String,
    data: Value,
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn resource_id(raw: &str) -> String {
    let hash = raw
        .as_bytes()
        .iter()
        .fold(2166136261u32, |h, b| (h ^ *b as u32).wrapping_mul(16777619));
    format!("r{hash:08x}")
}

pub fn error_kind(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if error.starts_with("HTTP ") {
        "http_error"
    } else if lower.contains("forbidden") || lower.contains("denied") || lower.contains("policy") || lower.contains("not allowed") || lower.contains("control character") {
        if lower.contains("downgrade") {
            "https_downgrade_denied"
        } else if lower.contains("private") || lower.contains("reserved") {
            "private_address_denied"
        } else {
            "target_policy_denied"
        }
    } else if lower.contains("dns") {
        "dns_error"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("redirect") {
        "redirect_error"
    } else {
        "transport_error"
    }
}

// Defense in depth for frontend entries: no arbitrary URL/message/header fields reach disk.
fn scrub(value: &Value, depth: usize) -> Value {
    if depth > 5 {
        return Value::Null;
    }
    match value {
        Value::String(s) => {
            if s.contains("://") || s.to_ascii_lowercase().contains("%3a") {
                json!("[redacted]")
            } else {
                json!(s.chars().take(160).collect::<String>())
            }
        }
        Value::Array(items) => {
            Value::Array(items.iter().take(24).map(|v| scrub(v, depth + 1)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .take(64)
                .filter_map(|(key, v)| {
                    let k = key.to_ascii_lowercase();
                    if [
                        "url",
                        "src",
                        "token",
                        "password",
                        "cookie",
                        "authorization",
                        "body",
                        "message",
                        "reason",
                    ]
                    .iter()
                    .any(|s| k.contains(s))
                    {
                        None
                    } else {
                        Some((key.chars().take(64).collect(), scrub(v, depth + 1)))
                    }
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

impl Journal {
    fn status(&self) -> Status {
        Status {
            enabled: self.enabled,
            path: self
                .dir
                .as_ref()
                .map(|d| d.join("playback.log").display().to_string()),
            error: self.error.clone(),
        }
    }

    fn append(&mut self, event: &str, data: Value, limit: u64) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("Log directory not initialized")?;
        let path = dir.join("playback.log");
        let ts = crate::logging::utc_timestamp()?;
        let line = json!({ "ts": ts, "pid": std::process::id(), "seq": SEQ.fetch_add(1, Ordering::Relaxed), "event": event, "strict": crate::network_policy::strict_security(), "data": scrub(&data, 0) }).to_string() + "\n";
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > limit {
            let previous = dir.join("playback.previous.log");
            if previous.exists() {
                fs::remove_file(&previous).map_err(|_| "Failed to rotate diagnostic log")?;
            }
            if path.exists() {
                fs::rename(&path, previous).map_err(|_| "Failed to rotate diagnostic log")?;
            }
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .map_err(|_| "Failed to write diagnostic log".to_string())
    }

    fn set(&mut self, on: bool) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("Log directory not initialized")?;
        if on {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("playback.log"))
                .map_err(|_| "Failed to create diagnostic log")?;
        }
        let temp = dir.join("playback-diagnostics.json.tmp");
        fs::write(&temp, json!({"enabled": on}).to_string())
            .and_then(|_| fs::rename(&temp, dir.join("playback-diagnostics.json")))
            .map_err(|_| "Failed to persist log toggle")?;
        self.enabled = on;
        self.error = None;
        if let Err(e) = self.append("diagnostics.toggle", json!({"enabled": on, "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS}), MAX_FILE) { self.error = Some(e); }
        Ok(())
    }
}

pub fn bind(dir: &Path) {
    if let Ok(mut log) = LOG.lock() {
        log.dir = Some(dir.to_path_buf());
        log.enabled = fs::read_to_string(dir.join("playback-diagnostics.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["enabled"].as_bool())
            .unwrap_or(false);
        ENABLED.store(log.enabled, Ordering::Relaxed);
        if log.enabled {
            if let Err(e) = log.append(
                "process.start",
                json!({"version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS}),
                MAX_FILE,
            ) {
                log.error = Some(e);
            }
        }
    }
}

pub fn record(event: &str, data: Value) {
    if !enabled() {
        return;
    }
    if let Ok(mut log) = LOG.lock() {
        if log.enabled {
            if let Err(e) = log.append(event, data, MAX_FILE) {
                log.error = Some(e);
            }
        }
    }
}

#[tauri::command]
pub fn playback_log_status() -> Result<Status, String> {
    Ok(LOG.lock().map_err(|_| "Log lock poisoned")?.status())
}

#[tauri::command]
pub fn playback_log_set(enabled: bool) -> Result<Status, String> {
    let mut log = LOG.lock().map_err(|_| "Log lock poisoned")?;
    let result = log.set(enabled);
    ENABLED.store(log.enabled, Ordering::Relaxed);
    result?;
    Ok(log.status())
}

#[tauri::command]
pub fn playback_log_write(entries: Vec<Entry>) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    if entries.len() > 128 {
        return Err("Log batch too large".into());
    }
    let mut log = LOG.lock().map_err(|_| "Log lock poisoned")?;
    if !log.enabled {
        return Ok(());
    }
    for entry in entries {
        if entry.event.len() > 80
            || !entry
                .event
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || entry.data.to_string().len() > 8192
        {
            return Err("Invalid log entry".into());
        }
        log.append(&format!("web.{}", entry.event), entry.data, MAX_FILE)?;
    }
    Ok(())
}

#[tauri::command]
pub fn playback_log_read() -> Result<String, String> {
    let log = LOG.lock().map_err(|_| "Log lock poisoned")?;
    let dir = log.dir.as_ref().ok_or("Log directory not initialized")?;
    let base = crate::net::base();
    let host = base.split("://").nth(1).unwrap_or(&base);
    let host = host.split('/').next().unwrap_or(host);
    let mut text = env_line(host)?;
    for name in ["playback.previous.log", "playback.log"] {
        let path = dir.join(name);
        if path.exists() {
            if fs::metadata(&path).map_err(|_| "Failed to read log")?.len() > MAX_FILE + 16384 {
                return Err("Log file exceeds size limit".into());
            }
            let body = fs::read_to_string(path).map_err(|_| "Failed to read log")?;
            text.push_str(body.trim_end_matches('\n'));
            text.push('\n');
        }
    }
    for line in debug_lines(dir)? {
        text.push_str(&line);
        text.push('\n');
    }
    Ok(text)
}

/// Converts the tail of debug.log into structured records (`debug.line`).
/// Ensures diagnostic exports contain useful context even if diagnostics were not toggled in advance.
fn debug_lines(dir: &Path) -> Result<Vec<String>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = dir.join("debug.log");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut file = fs::File::open(&path).map_err(|_| "Failed to read log")?;
    let len = file.metadata().map_err(|_| "Failed to read log")?.len();
    let keep = 64 * 1024u64;
    let start = len.saturating_sub(keep);
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .map_err(|_| "Failed to read log")?;
    }
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "Failed to read log")?;
    let slice = if start > 0 {
        match bytes.iter().position(|&b| b == b'\n') {
            Some(pos) => &bytes[pos + 1..],
            None => &bytes[..],
        }
    } else {
        &bytes[..]
    };
    let tail = String::from_utf8_lossy(slice);
    let pid = std::process::id();
    let stamp = crate::logging::utc_timestamp()?;
    let strict = crate::network_policy::strict_security();
    let mut out = Vec::new();
    for line in tail.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        // Strip the prefix added by append_debug: "[ts] [pid=N] " and place timestamp in its own field.
        let (source_ts, rest) = match line.strip_prefix('[').and_then(|r| r.split_once("] ")) {
            Some((ts, rest)) => (Some(ts), rest),
            None => (None, line),
        };
        let rest = rest.strip_prefix(&format!("[pid={pid}] ")).unwrap_or(rest);
        let scrubbed_text = scrub(&json!(rest.chars().take(2000).collect::<String>()), 0);
        out.push(
            json!({
                "ts": stamp,
                "pid": pid,
                "seq": SEQ.load(Ordering::Relaxed),
                "event": "debug.line",
                "strict": strict,
                "data": { "source_ts": source_ts, "text": scrubbed_text },
            })
            .to_string(),
        );
    }
    Ok(out)
}

/// Environment record with version, platform, host, and strict security mode.
/// Line only retains host, without paths or query strings.
fn env_line(host: &str) -> Result<String, String> {
    let entry = json!({
        "ts": crate::logging::utc_timestamp()?,
        "pid": std::process::id(),
        "seq": SEQ.load(Ordering::Relaxed),
        "event": "diagnostics.env",
        "strict": crate::network_policy::strict_security(),
        "data": {
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "line": host,
        },
    });
    Ok(entry.to_string() + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_timeout_and_policy_errors_keep_their_categories() {
        assert_eq!(error_kind("client error (Connect) ← operation timed out"), "timeout");
        assert_eq!(error_kind("request timeout"), "timeout");
        assert_eq!(error_kind("DNS resolution timeout"), "dns_error");
        assert_eq!(error_kind("private network access denied"), "private_address_denied");
        assert_eq!(error_kind("HTTP 403 Forbidden"), "http_error");
    }

    #[test]
    fn commands_stop_writes_when_disabled_and_read_retained_logs() {
        let dir = std::env::temp_dir().join(format!(
            "aurastream-playback-commands-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        bind(&dir);
        assert!(!playback_log_status().unwrap().enabled);
        record("test.off", json!({"n": 1}));
        assert!(!dir.join("playback.log").exists());
        playback_log_set(true).unwrap();
        playback_log_write(vec![Entry {
            event: "seek.request".into(),
            data: json!({"player": "p1", "seek": 1, "target": 30}),
        }])
        .unwrap();
        playback_log_set(false).unwrap();
        let size = fs::metadata(dir.join("playback.log")).unwrap().len();
        playback_log_write(vec![Entry {
            event: "seek.request".into(),
            data: json!({"seek": 2}),
        }])
        .unwrap();
        record("test.off", json!({"n": 2}));
        assert_eq!(fs::metadata(dir.join("playback.log")).unwrap().len(), size);
        let text = playback_log_read().unwrap();
        assert!(text.contains("web.seek.request"));
        assert!(!text.contains("test.off"));
        // The export is standard JSONL: environment record + event lines, one JSON object per line.
        assert!(text.contains("\"diagnostics.env\""));
        for line in text.lines() {
            assert!(line.starts_with('{') && line.ends_with('}'), "Not a JSONL line: {line}");
            serde_json::from_str::<Value>(line).expect("Exported line must be valid JSON");
        }
        bind(&dir);
        assert!(!enabled());
        let mut log = LOG.lock().unwrap();
        *log = Journal::default();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_redacts_urls_credentials_and_limits_depth() {
        let value = scrub(&json!({"resource": "r123", "url": "https://a/?token=secret", "token": "secret", "nested": {"message": "secret", "detail": "hg://localhost/seg?u=secret"}}), 0).to_string();
        assert!(!value.contains("secret"));
        assert!(value.contains("r123"));
        assert_eq!(resource_id("hello"), "r4f9f2cab");
    }

    #[test]
    fn logging_rotates_and_persists_without_changing_mode_on_save_failure() {
        let dir = std::env::temp_dir().join(format!(
            "aurastream-playback-log-{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut log = Journal {
            dir: Some(dir.clone()),
            ..Default::default()
        };
        log.set(true).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(dir.join("playback-diagnostics.json")).unwrap()
            )
            .unwrap()["enabled"],
            true
        );
        for _ in 0..5 {
            log.append("test", json!({"count": 1}), 400).unwrap();
        }
        assert!(dir.join("playback.previous.log").exists());
        for name in ["playback.log", "playback.previous.log"] {
            let text = fs::read_to_string(dir.join(name)).unwrap();
            assert!(text.len() <= 400);
            for line in text.lines() {
                assert!(serde_json::from_str::<Value>(line).unwrap()["ts"]
                    .as_str()
                    .unwrap()
                    .ends_with('Z'));
            }
        }
        log.dir = Some(dir.join("missing"));
        assert!(log.set(false).is_err());
        assert!(log.enabled);
        fs::remove_dir_all(dir).unwrap();
    }
}
