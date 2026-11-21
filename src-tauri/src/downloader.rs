//! Native background download engine running on Tauri's Tokio runtime.
//! Persists offline media playlists/segments/MP4 directly to app_data_dir so downloads
//! survive Android WebView throttling/freezing when backgrounded and resume cleanly.

use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, Semaphore};

const MAX_CONCURRENT_WIFI: usize = 2;
const MAX_CONCURRENT_CELLULAR: usize = 1;
const HLS_SEG_WORKERS_WIFI: usize = 6;
const HLS_SEG_WORKERS_CELLULAR: usize = 3;

static APP_HANDLE: Lazy<Mutex<Option<AppHandle>>> = Lazy::new(|| Mutex::new(None));
static DATA_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static CACHE_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));
static STATE: Lazy<Mutex<DownloadEngineState>> = Lazy::new(|| Mutex::new(DownloadEngineState::default()));
static ENGINE_NOTIFY: Lazy<Arc<Notify>> = Lazy::new(|| Arc::new(Notify::new()));
static ENGINE_STARTED: AtomicBool = AtomicBool::new(false);
static CELLULAR_MODE: AtomicBool = AtomicBool::new(false);
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

static CANCEL_TOKENS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedOfflineEpisode {
    pub id: String,
    pub video_id: i64,
    pub episode: i64,
    pub title: String,
    #[serde(default)]
    pub cover: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub duration: Option<f64>,
    pub downloaded_at: u64,
    #[serde(default)]
    pub cues: Vec<Value>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub is_hevc: bool,
    #[serde(default)]
    pub is_hls: bool,
    #[serde(default)]
    pub has_local_cover: bool,
    #[serde(default = "default_storage_native")]
    pub storage: String,
}

fn default_quality() -> String {
    "auto".to_string()
}

fn default_storage_native() -> String {
    "native".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDownloadItem {
    pub id: String,
    pub video_id: i64,
    pub episode: i64,
    pub title: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub progress: u8,
    #[serde(default)]
    pub downloaded_bytes: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub speed_bytes_per_sec: f64,
    #[serde(default = "default_connecting")]
    pub speed_formatted: String,
    #[serde(default)]
    pub eta_seconds: u64,
    #[serde(default = "default_dash")]
    pub eta_formatted: String,
    pub status: String, // "queued" | "downloading" | "paused" | "completed" | "error"
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stream_url: Option<String>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub is_hevc: bool,
    #[serde(default = "default_true")]
    pub auto_resume: bool,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub cues: Vec<Value>,
    #[serde(skip, default)]
    pub run_token: u64,
}

fn default_connecting() -> String {
    "Queued".to_string()
}

fn default_dash() -> String {
    "--".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentCompletedItem {
    id: String,
    video_id: i64,
    episode: i64,
    title: String,
    subtitle: String,
    size: String,
    completed_at: u64,
}

#[derive(Default)]
struct DownloadEngineState {
    completed: Vec<CompletedOfflineEpisode>,
    queue: Vec<QueueDownloadItem>,
    recent_completed: Vec<RecentCompletedItem>,
    last_emit_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueRequestItem {
    pub video_id: i64,
    pub episode: i64,
    pub title: String,
    #[serde(default)]
    pub cover: String,
    pub stream_url: Option<String>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub is_hevc: bool,
    #[serde(default)]
    pub cues: Vec<Value>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn offline_root() -> Option<PathBuf> {
    DATA_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|d| d.join("offline_downloads"))
}

fn exports_root() -> Option<PathBuf> {
    CACHE_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|c| c.join("exports"))
}

pub fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.contains("..")
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
}

pub fn offline_file_path(id: &str, file_name: &str) -> Option<PathBuf> {
    if !is_safe_segment(id) || !is_safe_segment(file_name) {
        return None;
    }
    offline_root().map(|r| r.join(id).join(file_name))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed creating dir: {e}"))?;
    }
    let tmp = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("dat"),
        now_ms()
    ));
    {
        let mut f = File::create(&tmp).map_err(|e| format!("Failed creating temp file: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("Failed writing temp file: {e}"))?;
        let _ = f.sync_all();
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed renaming temp file: {e}")
    })
}

fn persist_all_locked(st: &DownloadEngineState) {
    let Some(root) = offline_root() else { return };
    if let Ok(json_completed) = serde_json::to_vec_pretty(&st.completed) {
        let _ = atomic_write_bytes(&root.join("index.json"), &json_completed);
    }
    if let Ok(json_queue) = serde_json::to_vec_pretty(&st.queue) {
        let _ = atomic_write_bytes(&root.join("queue.json"), &json_queue);
    }
    write_active_status_locked(st, &root);
}

fn write_active_status_locked(st: &DownloadEngineState, root: &Path) {
    let downloading_count = st.queue.iter().filter(|q| q.status == "downloading").count();
    let queued_count = st.queue.iter().filter(|q| q.status == "queued").count();
    let active_items: Vec<Value> = st
        .queue
        .iter()
        .filter(|q| q.status == "downloading" || q.status == "queued")
        .map(|q| {
            let size_text = if q.total_bytes > 0 {
                format!("{} / {}", format_bytes(q.downloaded_bytes), format_bytes(q.total_bytes))
            } else if q.downloaded_bytes > 0 {
                format_bytes(q.downloaded_bytes)
            } else {
                String::new()
            };
            json!({
                "id": q.id,
                "videoId": q.video_id,
                "episode": q.episode,
                "title": q.title,
                "subtitle": format!("Episode {}", q.episode),
                "progress": q.progress,
                "speed": if q.status == "queued" { "Queued" } else { &q.speed_formatted },
                "size": size_text,
                "status": q.status,
            })
        })
        .collect();

    let status_doc = json!({
        "activeCount": downloading_count + queued_count,
        "downloadingCount": downloading_count,
        "queuedCount": queued_count,
        "updatedAt": now_ms(),
        "items": active_items,
        "recentCompleted": st.recent_completed,
    });
    if let Ok(bytes) = serde_json::to_vec(&status_doc) {
        let _ = atomic_write_bytes(&root.join("active_status.json"), &bytes);
    }
}

fn emit_frontend_snapshot(st: &DownloadEngineState) {
    let app = { APP_HANDLE.lock().unwrap_or_else(|e| e.into_inner()).clone() };
    let Some(app) = app else { return };
    // Never serialize auth_token over frontend event
    let clean_queue: Vec<Value> = st
        .queue
        .iter()
        .map(|q| {
            json!({
                "id": q.id,
                "videoId": q.video_id,
                "episode": q.episode,
                "title": q.title,
                "cover": q.cover,
                "progress": q.progress,
                "downloadedBytes": q.downloaded_bytes,
                "totalBytes": q.total_bytes,
                "speedBytesPerSec": q.speed_bytes_per_sec,
                "speedFormatted": q.speed_formatted,
                "etaSeconds": q.eta_seconds,
                "etaFormatted": q.eta_formatted,
                "status": q.status,
                "error": q.error,
                "quality": q.quality,
                "isHevc": q.is_hevc,
                "autoResume": q.auto_resume,
            })
        })
        .collect();
    let payload = json!({
        "queue": clean_queue,
        "completed": st.completed,
    });
    let _ = app.emit("aurastream:native-download-progress", payload);
}

fn maybe_emit_and_write_status(force: bool) {
    let snapshot_and_write = {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        if !force && now.saturating_sub(st.last_emit_ms) < 350 {
            return;
        }
        st.last_emit_ms = now;
        if let Some(root) = offline_root() {
            write_active_status_locked(&st, &root);
        }
        emit_frontend_snapshot(&st);
    };
    let _ = snapshot_and_write;
}

pub fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let b = bytes as f64;
    let units = ["B", "KB", "MB", "GB", "TB"];
    let idx = (b.log(1024.0).floor() as usize).min(units.len() - 1);
    let val = b / 1024f64.powi(idx as i32);
    if idx == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", val, units[idx])
    }
}

pub fn format_speed(bps: f64) -> String {
    if !bps.is_finite() || bps <= 0.0 {
        return "-- KB/s".to_string();
    }
    if bps >= 1024.0 * 1024.0 {
        format!("{:.1} MB/s", bps / (1024.0 * 1024.0))
    } else {
        format!("{} KB/s", (bps / 1024.0).round() as u64)
    }
}

pub fn format_eta(seconds: u64) -> String {
    if seconds == 0 {
        return "--".to_string();
    }
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let m = seconds / 60;
    let s = seconds % 60;
    format!("{m}m {s}s")
}

/// Bind app handle and data dir on startup and restore persisted downloads & paused queue.
pub fn bind(app: AppHandle, dir: PathBuf) {
    *APP_HANDLE.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
    *DATA_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.clone());

    let root = dir.join("offline_downloads");
    let _ = fs::create_dir_all(&root);

    let mut completed: Vec<CompletedOfflineEpisode> = fs::read_to_string(root.join("index.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Retain only completed records whose directory actually exists on disk
    completed.retain(|c| root.join(&c.id).is_dir());

    let mut queue: Vec<QueueDownloadItem> = fs::read_to_string(root.join("queue.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let completed_ids: HashSet<String> = completed.iter().map(|c| c.id.clone()).collect();
    queue.retain(|q| !completed_ids.contains(&q.id) && q.status != "completed");
    for item in &mut queue {
        if item.status == "downloading" || item.status == "queued" {
            item.auto_resume = true;
            item.status = "paused".to_string();
            item.speed_bytes_per_sec = 0.0;
            item.speed_formatted = "Paused".to_string();
            item.eta_formatted = "--".to_string();
        }
    }

    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        st.completed = completed;
        st.queue = queue;
        persist_all_locked(&st);
    }

    if !ENGINE_STARTED.swap(true, Ordering::AcqRel) {
        tauri::async_runtime::spawn(coordinator_loop());
    }
}

pub fn bind_cache(cache_dir: PathBuf) {
    let _ = fs::create_dir_all(&cache_dir);
    *CACHE_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(cache_dir);
}

fn new_cancel_flag(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    let mut map = CANCEL_TOKENS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = map.insert(id.to_string(), flag.clone()) {
        prev.store(true, Ordering::Release);
    }
    flag
}

fn trigger_cancel_flag(id: &str) {
    let mut map = CANCEL_TOKENS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = map.remove(id) {
        prev.store(true, Ordering::Release);
    }
}

fn clear_cancel_flag(id: &str) {
    CANCEL_TOKENS.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

fn poll_external_control_file() {
    let Some(root) = offline_root() else { return };
    let ctrl_path = root.join("control.json");
    if !ctrl_path.is_file() {
        return;
    }
    let text = fs::read_to_string(&ctrl_path).ok();
    let _ = fs::remove_file(&ctrl_path);
    let Some(text) = text else { return };
    let Ok(val) = serde_json::from_str::<Value>(&text) else { return };
    match val.get("action").and_then(Value::as_str) {
        Some("pause_all") => pause_all_internal(),
        Some("cancel_all") => cancel_all_internal(),
        _ => {}
    }
}

async fn coordinator_loop() {
    let mut active_tasks: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut tick = tokio::time::interval(Duration::from_millis(350));

    loop {
        tokio::select! {
            _ = ENGINE_NOTIFY.notified() => {},
            _ = tick.tick() => {},
        }

        poll_external_control_file();
        active_tasks.retain(|_, handle| !handle.is_finished());

        let max_workers = if CELLULAR_MODE.load(Ordering::Acquire) {
            MAX_CONCURRENT_CELLULAR
        } else {
            MAX_CONCURRENT_WIFI
        };

        let to_spawn: Vec<QueueDownloadItem> = {
            let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
            let currently_running = st
                .queue
                .iter()
                .filter(|q| q.status == "downloading" && active_tasks.contains_key(&q.id))
                .count();
            if currently_running >= max_workers {
                Vec::new()
            } else {
                let slots = max_workers - currently_running;
                let mut picked = Vec::new();
                for item in &mut st.queue {
                    if picked.len() >= slots {
                        break;
                    }
                    if item.status == "queued" && !active_tasks.contains_key(&item.id) {
                        item.status = "downloading".to_string();
                        item.error = None;
                        item.speed_formatted = "Connecting...".to_string();
                        item.run_token = NEXT_TOKEN.fetch_add(1, Ordering::AcqRel);
                        picked.push(item.clone());
                    }
                }
                if !picked.is_empty() {
                    persist_all_locked(&st);
                    emit_frontend_snapshot(&st);
                }
                picked
            }
        };

        for item in to_spawn {
            let id = item.id.clone();
            let cancel = new_cancel_flag(&id);
            let handle = tokio::spawn(async move {
                run_episode_download(item, cancel).await;
                ENGINE_NOTIFY.notify_one();
            });
            active_tasks.insert(id, handle);
        }
    }
}

struct SpeedTracker {
    samples: Vec<(Instant, u64)>,
    ema_bps: f64,
}

impl SpeedTracker {
    fn new() -> Self {
        Self {
            samples: Vec::with_capacity(32),
            ema_bps: 0.0,
        }
    }

    fn sample(&mut self, bytes_now: u64, total_bytes: u64) -> (f64, String, u64, String) {
        let now = Instant::now();
        self.samples.push((now, bytes_now));
        let cutoff = now.checked_sub(Duration::from_secs(5)).unwrap_or(now);
        while self.samples.len() > 2 && self.samples[0].0 < cutoff {
            self.samples.remove(0);
        }
        if let Some((first_t, first_b)) = self.samples.first().copied() {
            let dt = now.duration_since(first_t).as_secs_f64();
            if dt >= 0.35 && bytes_now >= first_b {
                let win_bps = ((bytes_now - first_b) as f64) / dt;
                self.ema_bps = if self.ema_bps > 0.0 {
                    self.ema_bps * 0.6 + win_bps * 0.4
                } else {
                    win_bps
                };
            }
        }
        let remaining = total_bytes.saturating_sub(bytes_now);
        let eta_sec = if self.ema_bps > 100.0 && remaining > 0 {
            ((remaining as f64) / self.ema_bps).round() as u64
        } else {
            0
        };
        (
            self.ema_bps,
            format_speed(self.ema_bps),
            eta_sec,
            format_eta(eta_sec),
        )
    }
}

fn is_owner_active(id: &str, token: u64, cancel: &AtomicBool) -> bool {
    if cancel.load(Ordering::Acquire) {
        return false;
    }
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.queue
        .iter()
        .any(|q| q.id == id && q.run_token == token && q.status == "downloading")
}

fn update_item_progress(
    id: &str,
    token: u64,
    pct: u8,
    downloaded: u64,
    total: u64,
    speed_bps: f64,
    speed_fmt: String,
    eta_sec: u64,
    eta_fmt: String,
    force_emit: bool,
) {
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let Some(item) = st.queue.iter_mut().find(|q| q.id == id && q.run_token == token) else {
            return;
        };
        if item.status != "downloading" {
            return;
        }
        item.progress = pct.min(99);
        item.downloaded_bytes = downloaded;
        item.total_bytes = total;
        item.speed_bytes_per_sec = speed_bps;
        item.speed_formatted = speed_fmt;
        item.eta_seconds = eta_sec;
        item.eta_formatted = eta_fmt;
    }
    maybe_emit_and_write_status(force_emit);
}

fn pick_stream_url_from_play_info(info: &Value, quality: &str) -> Option<(String, String, bool)> {
    let streams = info.get("streams");
    let hevc = streams
        .and_then(|s| s.get("hevc"))
        .and_then(Value::as_str)
        .or_else(|| info.get("video_url_hevc").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let main = streams
        .and_then(|s| s.get("main"))
        .and_then(Value::as_str)
        .or_else(|| info.get("video_url").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let preview = streams
        .and_then(|s| s.get("preview"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    match quality {
        "standard" => main
            .map(|u| (u, "standard".to_string(), false))
            .or_else(|| hevc.map(|u| (u, "hevc".to_string(), true)))
            .or_else(|| preview.map(|u| (u, "standard".to_string(), false))),
        _ => hevc
            .map(|u| (u, "hevc".to_string(), true))
            .or_else(|| main.map(|u| (u, "standard".to_string(), false)))
            .or_else(|| preview.map(|u| (u, "standard".to_string(), false))),
    }
}

fn split_hls_attrs(attr_list: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in attr_list.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        } else if ch == ',' && !quoted {
            parts.push(attr_list[start..i].trim());
            start = i + 1;
        }
    }
    let tail = attr_list[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts
}

fn parse_hls_attrs(line: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some((_, rest)) = line.split_once(':') else {
        return out;
    };
    for attr in split_hls_attrs(rest) {
        if let Some((k, v)) = attr.split_once('=') {
            let key = k.trim().to_ascii_uppercase();
            let mut val = v.trim().to_string();
            if val.starts_with('"') && val.ends_with('"') && val.len() >= 2 {
                val = val[1..val.len() - 1].to_string();
            }
            out.insert(key, val);
        }
    }
    out
}

pub fn resolve_hls_url(base_url: &str, rel_or_abs: &str) -> String {
    if rel_or_abs.starts_with("http://") || rel_or_abs.starts_with("https://") {
        return rel_or_abs.to_string();
    }
    if let Ok(b) = url::Url::parse(base_url) {
        if let Ok(j) = b.join(rel_or_abs) {
            return j.to_string();
        }
    }
    rel_or_abs.to_string()
}

pub fn select_best_variant_url(master_text: &str, master_url: &str) -> Option<String> {
    let lines: Vec<&str> = master_text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut best_url: Option<String> = None;
    let mut best_bw: i64 = -1;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.starts_with("#EXT-X-STREAM-INF:") {
            let attrs = parse_hls_attrs(line);
            let bw = attrs
                .get("BANDWIDTH")
                .or_else(|| attrs.get("AVERAGE-BANDWIDTH"))
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            for j in (i + 1)..lines.len() {
                if !lines[j].starts_with('#') {
                    if bw > best_bw || best_url.is_none() {
                        best_bw = bw;
                        best_url = Some(resolve_hls_url(master_url, lines[j]));
                    }
                    i = j;
                    break;
                }
            }
        }
        i += 1;
    }
    best_url.or_else(|| {
        lines
            .into_iter()
            .find(|l| !l.starts_with('#'))
            .map(|u| resolve_hls_url(master_url, u))
    })
}

async fn run_episode_download(mut item: QueueDownloadItem, cancel: Arc<AtomicBool>) {
    let id = item.id.clone();
    let token = item.run_token;
    let Some(root) = offline_root() else {
        mark_item_error(&id, token, "Offline storage not initialized".into());
        return;
    };

    let result: Result<(u64, bool, Option<String>), String> = async {
        // Resolve stream URL natively if queued without a concrete URL (batch episodes)
        let (stream_url, final_quality, final_hevc) = if let Some(u) = item
            .stream_url
            .clone()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            (u, item.quality.clone(), item.is_hevc)
        } else {
            let origin = crate::net::base();
            let play = crate::api::resolve_episode_play(
                &origin,
                item.auth_token.as_deref(),
                item.video_id,
                item.episode.max(1) as u32,
            )
            .await?;
            let (url, q, hevc) = pick_stream_url_from_play_info(&play, &item.quality)
                .ok_or_else(|| format!("No stream URL available for Episode {}", item.episode))?;
            {
                let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(q_item) = st.queue.iter_mut().find(|x| x.id == id && x.run_token == token) {
                    q_item.stream_url = Some(url.clone());
                    q_item.quality = q.clone();
                    q_item.is_hevc = hevc;
                }
            }
            (url, q, hevc)
        };
        item.quality = final_quality;
        item.is_hevc = final_hevc;

        if !is_owner_active(&id, token, &cancel) {
            return Err("__cancelled__".to_string());
        }

        let part_dir = root.join(format!("{id}.part"));
        fs::create_dir_all(&part_dir).map_err(|e| format!("Failed creating download folder: {e}"))?;

        let is_hls = stream_url.to_ascii_lowercase().contains(".m3u8") || stream_url.contains("/hls?u=");
        if is_hls {
            let total_bytes = download_hls_to_dir(
                &item,
                &stream_url,
                &part_dir,
                token,
                &cancel,
            )
            .await?;
            Ok((total_bytes, true, Some(stream_url)))
        } else {
            let total_bytes = download_direct_to_dir(
                &item,
                &stream_url,
                &part_dir,
                token,
                &cancel,
            )
            .await?;
            Ok((total_bytes, false, Some(stream_url)))
        }
    }
    .await;

    clear_cancel_flag(&id);

    match result {
        Ok((total_bytes, is_hls, _resolved_url)) => {
            if !is_owner_active(&id, token, &cancel) {
                return;
            }
            let part_dir = root.join(format!("{id}.part"));
            let mut has_local_cover = part_dir.join("cover.img").is_file();
            if !has_local_cover && !item.cover.trim().is_empty() {
                if let Ok((_, cover_bytes)) = crate::media::load_image(&item.cover).await {
                    if !cover_bytes.is_empty() && atomic_write_bytes(&part_dir.join("cover.img"), &cover_bytes).is_ok() {
                        has_local_cover = true;
                    }
                }
            }
            let final_dir = root.join(&id);
            if final_dir.exists() {
                let _ = fs::remove_dir_all(&final_dir);
            }
            if let Err(e) = fs::rename(&part_dir, &final_dir) {
                mark_item_error(&id, token, format!("Failed finalizing download folder: {e}"));
                return;
            }

            let finished_at = now_ms();
            let completed_ep = CompletedOfflineEpisode {
                id: id.clone(),
                video_id: item.video_id,
                episode: item.episode,
                title: item.title.clone(),
                cover: item.cover.clone(),
                size_bytes: total_bytes,
                duration: None,
                downloaded_at: finished_at,
                cues: item.cues.clone(),
                quality: item.quality.clone(),
                is_hevc: item.is_hevc,
                is_hls,
                has_local_cover,
                storage: "native".to_string(),
            };

            {
                let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
                st.completed.retain(|c| c.id != id);
                st.completed.insert(0, completed_ep);
                if let Some(q) = st.queue.iter_mut().find(|q| q.id == id) {
                    q.status = "completed".to_string();
                    q.progress = 100;
                    q.downloaded_bytes = total_bytes;
                    q.total_bytes = total_bytes;
                    q.speed_bytes_per_sec = 0.0;
                    q.speed_formatted = "Finished".to_string();
                    q.eta_seconds = 0;
                    q.eta_formatted = "Done".to_string();
                    q.auto_resume = false;
                }
                st.recent_completed.retain(|r| r.id != id);
                st.recent_completed.insert(
                    0,
                    RecentCompletedItem {
                        id: id.clone(),
                        video_id: item.video_id,
                        episode: item.episode,
                        title: item.title.clone(),
                        subtitle: format!("Episode {}", item.episode),
                        size: format_bytes(total_bytes),
                        completed_at: finished_at,
                    },
                );
                if st.recent_completed.len() > 20 {
                    st.recent_completed.truncate(20);
                }
                persist_all_locked(&st);
                emit_frontend_snapshot(&st);
            }

            // Retain completed entry briefly for UI 100% transition, then clear from active queue
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
            st.queue.retain(|q| !(q.id == id && q.status == "completed"));
            persist_all_locked(&st);
            emit_frontend_snapshot(&st);
        }
        Err(err) => {
            if err == "__cancelled__" || cancel.load(Ordering::Acquire) {
                return;
            }
            mark_item_error(&id, token, err);
        }
    }
}

fn mark_item_error(id: &str, token: u64, err: String) {
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let Some(q) = st.queue.iter_mut().find(|x| x.id == id && x.run_token == token) else {
            return;
        };
        if q.status == "paused" {
            return;
        }
        q.status = "error".to_string();
        q.error = Some(err);
        q.auto_resume = false;
        q.speed_bytes_per_sec = 0.0;
        q.speed_formatted = "--".to_string();
        q.eta_seconds = 0;
        q.eta_formatted = "--".to_string();
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }
}

async fn download_hls_to_dir(
    item: &QueueDownloadItem,
    stream_url: &str,
    part_dir: &Path,
    token: u64,
    cancel: &Arc<AtomicBool>,
) -> Result<u64, String> {
    let (_, raw_pl) = crate::net::fetch_bytes(stream_url).await?;
    let mut playlist_text = String::from_utf8(raw_pl)
        .map_err(|_| "Playlist is not valid UTF-8 text".to_string())?;
    let mut playlist_url = stream_url.to_string();

    if playlist_text.contains("#EXT-X-STREAM-INF") {
        let best_url = select_best_variant_url(&playlist_text, &playlist_url)
            .ok_or_else(|| "Master playlist contains no playable variants".to_string())?;
        let (_, variant_bytes) = crate::net::fetch_bytes(&best_url).await?;
        playlist_text = String::from_utf8(variant_bytes)
            .map_err(|_| "Variant playlist is not valid UTF-8 text".to_string())?;
        playlist_url = best_url;
    }

    if !is_owner_active(&item.id, token, cancel.as_ref()) {
        return Err("__cancelled__".to_string());
    }

    let lines: Vec<String> = playlist_text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|l| l.trim().to_string())
        .collect();

    let mut key_map: HashMap<String, String> = HashMap::new();
    let mut map_map: HashMap<String, String> = HashMap::new();
    let mut seg_tasks: Vec<(usize, String, String)> = Vec::new();
    let mut rewritten_lines: Vec<String> = Vec::with_capacity(lines.len());
    let mut received_bytes: u64 = 0;
    let mut seg_idx: usize = 0;

    // First download keys and init maps, and enumerate segments
    for line in &lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-KEY:") {
            let attrs = parse_hls_attrs(line);
            let method = attrs.get("METHOD").map(|s| s.to_ascii_uppercase()).unwrap_or_default();
            if !method.is_empty() && method != "NONE" {
                let raw_uri = attrs
                    .get("URI")
                    .ok_or_else(|| format!("HLS {method} key tag missing URI"))?;
                let abs_uri = resolve_hls_url(&playlist_url, raw_uri);
                let local_name = if let Some(existing) = key_map.get(&abs_uri) {
                    existing.clone()
                } else {
                    let local_name = format!("key_{}.key", key_map.len());
                    let key_path = part_dir.join(&local_name);
                    if !(key_path.is_file() && key_path.metadata().map(|m| m.len() > 0).unwrap_or(false)) {
                        let (_, key_bytes) = crate::net::fetch_bytes(&abs_uri).await?;
                        if key_bytes.is_empty() {
                            return Err("Empty HLS decryption key received".into());
                        }
                        atomic_write_bytes(&key_path, &key_bytes)?;
                    }
                    key_map.insert(abs_uri.clone(), local_name.clone());
                    local_name
                };
                let rewritten = replace_uri_attr(line, &local_name);
                rewritten_lines.push(rewritten);
            } else {
                rewritten_lines.push(line.clone());
            }
        } else if line.starts_with("#EXT-X-MAP:") {
            let attrs = parse_hls_attrs(line);
            if let Some(raw_uri) = attrs.get("URI") {
                let abs_uri = resolve_hls_url(&playlist_url, raw_uri);
                let local_name = if let Some(existing) = map_map.get(&abs_uri) {
                    existing.clone()
                } else {
                    let local_name = format!("init_{}.mp4", map_map.len());
                    let init_path = part_dir.join(&local_name);
                    if init_path.is_file() && init_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                        received_bytes += init_path.metadata().map(|m| m.len()).unwrap_or(0);
                    } else {
                        let (_, init_bytes) = crate::net::fetch_bytes(&abs_uri).await?;
                        if init_bytes.is_empty() {
                            return Err("Empty HLS init segment received".into());
                        }
                        received_bytes += init_bytes.len() as u64;
                        atomic_write_bytes(&init_path, &init_bytes)?;
                    }
                    map_map.insert(abs_uri.clone(), local_name.clone());
                    local_name
                };
                rewritten_lines.push(replace_uri_attr(line, &local_name));
            } else {
                rewritten_lines.push(line.clone());
            }
        } else if line.starts_with("#EXT-X-CONTENT-STEERING:") {
            continue;
        } else if !line.starts_with('#') {
            let abs_uri = resolve_hls_url(&playlist_url, line);
            let local_name = format!("seg_{seg_idx:05}.ts");
            seg_tasks.push((seg_idx, abs_uri, local_name.clone()));
            rewritten_lines.push(local_name);
            seg_idx += 1;
        } else {
            // Strip any unrecognized HLS tags with external URI/URL references so offline playback never hits the network
            let lower = line.to_ascii_lowercase();
            if lower.contains("uri=\"")
                || lower.contains("x-asset-list")
                || lower.contains("http://")
                || lower.contains("https://")
            {
                continue;
            }
            rewritten_lines.push(line.clone());
        }
    }

    if seg_tasks.is_empty() {
        return Err("No media segments found in HLS playlist".into());
    }

    let rewritten_playlist = format!("{}\n", rewritten_lines.join("\n"));
    atomic_write_bytes(&part_dir.join("index.m3u8"), rewritten_playlist.as_bytes())?;

    let total_segments = seg_tasks.len();
    let initial_est_bytes = (total_segments as u64) * 1_600_000;
    update_item_progress(
        &item.id,
        token,
        1,
        received_bytes,
        initial_est_bytes,
        0.0,
        "Connecting...".to_string(),
        0,
        "--".to_string(),
        true,
    );

    let concurrency = if CELLULAR_MODE.load(Ordering::Acquire) {
        HLS_SEG_WORKERS_CELLULAR
    } else {
        HLS_SEG_WORKERS_WIFI
    };
    let sem = Arc::new(Semaphore::new(concurrency));
    let completed_count = Arc::new(AtomicU64::new(0));
    let bytes_counter = Arc::new(AtomicU64::new(received_bytes));
    let tracker = Arc::new(Mutex::new(SpeedTracker::new()));

    let mut handles = Vec::with_capacity(total_segments);
    for (_idx, seg_url, local_name) in seg_tasks {
        let permit = sem.clone().acquire_owned().await.map_err(|_| "Semaphore closed".to_string())?;
        if !is_owner_active(&item.id, token, cancel.as_ref()) {
            drop(permit);
            return Err("__cancelled__".to_string());
        }
        let seg_path = part_dir.join(&local_name);
        let id = item.id.clone();
        let cancel_cl = cancel.clone();
        let completed_cl = completed_count.clone();
        let bytes_cl = bytes_counter.clone();
        let tracker_cl = tracker.clone();

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if !is_owner_active(&id, token, cancel_cl.as_ref()) {
                return Err("__cancelled__".to_string());
            }
            let seg_len = if let Ok(meta) = fs::metadata(&seg_path) {
                if meta.is_file() && meta.len() > 0 {
                    Some(meta.len())
                } else {
                    None
                }
            } else {
                None
            };

            let len = match seg_len {
                Some(existing_len) => existing_len,
                None => {
                    let mut last_err = String::from("Segment download failed");
                    let mut got: Option<Vec<u8>> = None;
                    for attempt in 0..4 {
                        if !is_owner_active(&id, token, cancel_cl.as_ref()) {
                            return Err("__cancelled__".to_string());
                        }
                        match crate::net::fetch_bytes(&seg_url).await {
                            Ok((_, b)) if !b.is_empty() => {
                                got = Some(b);
                                break;
                            }
                            Ok(_) => last_err = "Empty segment received (0 bytes)".to_string(),
                            Err(e) => last_err = e,
                        }
                        if attempt < 3 {
                            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1) as u64)).await;
                        }
                    }
                    let data = got.ok_or(last_err)?;
                    let l = data.len() as u64;
                    atomic_write_bytes(&seg_path, &data)?;
                    l
                }
            };

            let new_bytes = bytes_cl.fetch_add(len, Ordering::AcqRel) + len;
            let done = completed_cl.fetch_add(1, Ordering::AcqRel) + 1;
            let avg_seg = (new_bytes as f64) / (done as f64).max(1.0);
            let est_total = new_bytes.max((avg_seg * (total_segments as f64)).round() as u64);
            let pct = (((done as f64 / total_segments as f64) * 100.0).round() as u8).clamp(1, 99);
            let (speed_bps, speed_fmt, eta_sec, eta_fmt) = {
                let mut tr = tracker_cl.lock().unwrap_or_else(|e| e.into_inner());
                tr.sample(new_bytes, est_total)
            };
            update_item_progress(
                &id,
                token,
                pct,
                new_bytes,
                est_total,
                speed_bps,
                speed_fmt,
                eta_sec,
                eta_fmt,
                false,
            );
            Ok(())
        }));
    }

    for h in handles {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("Download task panicked: {e}")),
        }
    }

    Ok(bytes_counter.load(Ordering::Acquire))
}

async fn download_direct_to_dir(
    item: &QueueDownloadItem,
    stream_url: &str,
    part_dir: &Path,
    token: u64,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let referer = format!("{}/", crate::net::base());
    let mut resp = crate::net::get(stream_url, Duration::from_secs(120), None, Some(&referer)).await?;
    if !resp.status().is_success() {
        return Err(format!("Failed to download stream: HTTP {}", resp.status()));
    }
    let content_len = resp.content_length().unwrap_or(0);
    let tmp_path = part_dir.join("video.mp4.part");
    let final_path = part_dir.join("video.mp4");
    let mut file = File::create(&tmp_path).map_err(|e| format!("Failed creating MP4 file: {e}"))?;
    let mut received: u64 = 0;
    let mut tracker = SpeedTracker::new();

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| crate::net::err_text(&e))?
    {
        if !is_owner_active(&item.id, token, cancel) {
            return Err("__cancelled__".to_string());
        }
        file.write_all(&chunk)
            .map_err(|e| format!("Failed writing MP4 chunk: {e}"))?;
        received += chunk.len() as u64;
        let est_total = if content_len > 0 {
            content_len.max(received)
        } else {
            (received as f64 * 1.25).round() as u64
        }
        .max(1);
        let pct = (((received as f64 / est_total as f64) * 100.0).round() as u8).clamp(1, 99);
        let (speed_bps, speed_fmt, eta_sec, eta_fmt) = tracker.sample(received, est_total);
        update_item_progress(
            &item.id,
            token,
            pct,
            received,
            est_total,
            speed_bps,
            speed_fmt,
            eta_sec,
            eta_fmt,
            false,
        );
    }
    let _ = file.sync_all();
    drop(file);
    if received == 0 {
        return Err("Empty download received (0 bytes)".into());
    }
    fs::rename(&tmp_path, &final_path).map_err(|e| format!("Failed finalizing MP4: {e}"))?;
    Ok(received)
}

pub fn replace_uri_attr(line: &str, new_uri: &str) -> String {
    let Some((tag, rest)) = line.split_once(':') else {
        return line.to_string();
    };
    let mapped: Vec<String> = split_hls_attrs(rest)
        .into_iter()
        .map(|attr| {
            if let Some((k, v)) = attr.split_once('=') {
                if k.trim().eq_ignore_ascii_case("URI") && v.trim().starts_with('"') {
                    return format!("{}=\"{new_uri}\"", k.trim());
                }
            }
            attr.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn parse_hls_iv(iv_str: &str) -> Result<[u8; 16], String> {
    let hex = iv_str
        .trim()
        .strip_prefix("0x")
        .or_else(|| iv_str.trim().strip_prefix("0X"))
        .unwrap_or(iv_str.trim());
    if hex.is_empty() || hex.len() > 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("Invalid HLS AES-128 IV: {iv_str}"));
    }
    let padded = format!("{hex:0>32}");
    let mut iv = [0u8; 16];
    for (i, slot) in iv.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("Invalid HLS AES-128 IV: {iv_str}"))?;
    }
    Ok(iv)
}

fn sequence_to_iv(seq: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..16].copy_from_slice(&seq.to_be_bytes());
    iv
}

fn decrypt_aes128_cbc(key: &[u8], iv: &[u8; 16], data: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != 16 {
        return Err(format!("Invalid AES-128 key length ({} bytes)", key.len()));
    }
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return Err("Invalid AES-128 encrypted segment size".into());
    }
    let cipher = Aes128::new_from_slice(key).map_err(|_| "Invalid AES-128 key".to_string())?;
    let mut prev = *iv;
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    let pad = *out.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && out.len() >= pad && out[out.len() - pad..].iter().all(|b| *b as usize == pad) {
        out.truncate(out.len() - pad);
    }
    Ok(out)
}

fn assemble_export_from_dir(ep_dir: &Path, is_hls: bool, dest_path: &Path) -> Result<(), String> {
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed creating export dir: {e}"))?;
    }
    if !is_hls {
        let src = ep_dir.join("video.mp4");
        if !src.is_file() {
            return Err("Offline video file missing".into());
        }
        fs::copy(&src, dest_path).map_err(|e| format!("Failed copying offline video: {e}"))?;
        return Ok(());
    }

    let m3u8_text = fs::read_to_string(ep_dir.join("index.m3u8"))
        .map_err(|e| format!("Offline playlist missing: {e}"))?;
    let mut out_file = File::create(dest_path).map_err(|e| format!("Failed creating export file: {e}"))?;

    let mut media_seq: u64 = 0;
    let mut current_method = String::new();
    let mut current_iv: Option<String> = None;
    let mut current_key_file: Option<String> = None;
    let mut seg_seq_offset: u64 = 0;

    for raw in m3u8_text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(seq) = rest.trim().parse::<u64>() {
                media_seq = seq;
            }
        } else if line.starts_with("#EXT-X-KEY:") {
            let attrs = parse_hls_attrs(line);
            current_method = attrs.get("METHOD").map(|s| s.to_ascii_uppercase()).unwrap_or_default();
            current_iv = attrs.get("IV").cloned();
            current_key_file = attrs.get("URI").cloned();
        } else if line.starts_with("#EXT-X-MAP:") {
            let attrs = parse_hls_attrs(line);
            if let Some(uri) = attrs.get("URI") {
                if is_safe_segment(uri) {
                    let init_bytes = fs::read(ep_dir.join(uri))
                        .map_err(|e| format!("Missing init segment {uri}: {e}"))?;
                    out_file.write_all(&init_bytes).map_err(|e| format!("Write failed: {e}"))?;
                }
            }
        } else if !line.starts_with('#') {
            if !is_safe_segment(line) {
                return Err("Invalid offline segment path".into());
            }
            let seg_bytes = fs::read(ep_dir.join(line))
                .map_err(|e| format!("Missing segment {line}: {e}"))?;
            if current_method == "AES-128" {
                let key_name = current_key_file
                    .as_deref()
                    .filter(|u| is_safe_segment(u))
                    .ok_or_else(|| "Missing AES-128 key reference".to_string())?;
                let key = fs::read(ep_dir.join(key_name))
                    .map_err(|e| format!("Missing AES-128 key file: {e}"))?;
                let iv = match current_iv.as_deref() {
                    Some(iv_str) => parse_hls_iv(iv_str)?,
                    None => sequence_to_iv(media_seq + seg_seq_offset),
                };
                let plain = decrypt_aes128_cbc(&key, &iv, &seg_bytes)?;
                out_file.write_all(&plain).map_err(|e| format!("Write failed: {e}"))?;
            } else {
                out_file.write_all(&seg_bytes).map_err(|e| format!("Write failed: {e}"))?;
            }
            seg_seq_offset += 1;
        }
    }
    let _ = out_file.sync_all();
    Ok(())
}

fn pause_all_internal() {
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        for item in &mut st.queue {
            if item.status == "downloading" || item.status == "queued" {
                trigger_cancel_flag(&item.id);
                item.status = "paused".to_string();
                item.auto_resume = false;
                item.speed_bytes_per_sec = 0.0;
                item.speed_formatted = "Paused".to_string();
                item.eta_seconds = 0;
                item.eta_formatted = "--".to_string();
            }
        }
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }
}

fn cancel_all_internal() {
    let root = offline_root();
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        for item in &st.queue {
            trigger_cancel_flag(&item.id);
            if let Some(ref r) = root {
                let _ = fs::remove_dir_all(r.join(format!("{}.part", item.id)));
            }
        }
        st.queue.clear();
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }
}

/* ───────────────────────── Tauri Commands ───────────────────────── */

#[tauri::command]
pub async fn native_download_enqueue(
    state: tauri::State<'_, crate::api::Api>,
    items: Vec<EnqueueRequestItem>,
    cellular: Option<bool>,
) -> Result<Value, String> {
    if let Some(is_cell) = cellular {
        CELLULAR_MODE.store(is_cell, Ordering::Release);
    }
    let origin = crate::net::base();
    let token = state.session.token(&origin).filter(|_| {
        !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
    });

    let mut added = 0usize;
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        for req in items {
            if req.video_id <= 0 || req.episode <= 0 {
                continue;
            }
            let id = format!("{}_{}", req.video_id, req.episode);
            if st.completed.iter().any(|c| c.id == id) {
                continue;
            }
            if let Some(existing) = st.queue.iter_mut().find(|q| q.id == id) {
                if existing.status == "paused" || existing.status == "error" {
                    existing.status = "queued".to_string();
                    existing.error = None;
                    existing.auto_resume = true;
                    existing.speed_formatted = "Queued".to_string();
                    if req.stream_url.as_ref().is_some_and(|s| !s.is_empty()) {
                        existing.stream_url = req.stream_url;
                    }
                    if token.is_some() {
                        existing.auth_token = token.clone();
                    }
                    added += 1;
                }
                continue;
            }
            st.queue.push(QueueDownloadItem {
                id,
                video_id: req.video_id,
                episode: req.episode,
                title: req.title,
                cover: req.cover,
                progress: 0,
                downloaded_bytes: 0,
                total_bytes: 0,
                speed_bytes_per_sec: 0.0,
                speed_formatted: "Queued".to_string(),
                eta_seconds: 0,
                eta_formatted: "--".to_string(),
                status: "queued".to_string(),
                error: None,
                stream_url: req.stream_url,
                quality: req.quality,
                is_hevc: req.is_hevc,
                auto_resume: true,
                auth_token: token.clone(),
                cues: req.cues,
                run_token: 0,
            });
            added += 1;
        }
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }

    ENGINE_NOTIFY.notify_one();
    Ok(json!({ "queued": added }))
}

#[tauri::command]
pub fn native_download_pause(id: String) -> Result<(), String> {
    if !is_safe_segment(&id) {
        return Err("Invalid download ID".into());
    }
    trigger_cancel_flag(&id);
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(item) = st.queue.iter_mut().find(|q| q.id == id) {
        if item.status == "downloading" || item.status == "queued" {
            item.status = "paused".to_string();
            item.auto_resume = false;
            item.speed_bytes_per_sec = 0.0;
            item.speed_formatted = "Paused".to_string();
            item.eta_seconds = 0;
            item.eta_formatted = "--".to_string();
        }
    }
    persist_all_locked(&st);
    emit_frontend_snapshot(&st);
    Ok(())
}

#[tauri::command]
pub fn native_download_pause_all() -> Result<(), String> {
    pause_all_internal();
    Ok(())
}

#[tauri::command]
pub fn native_download_resume(id: String, cellular: Option<bool>) -> Result<(), String> {
    if !is_safe_segment(&id) {
        return Err("Invalid download ID".into());
    }
    if let Some(is_cell) = cellular {
        CELLULAR_MODE.store(is_cell, Ordering::Release);
    }
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = st.queue.iter_mut().find(|q| q.id == id) {
            if item.status == "paused" || item.status == "error" {
                item.status = "queued".to_string();
                item.error = None;
                item.auto_resume = true;
                item.speed_formatted = "Queued".to_string();
            }
        }
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }
    ENGINE_NOTIFY.notify_one();
    Ok(())
}

#[tauri::command]
pub fn native_download_resume_all(only_auto_resumable: Option<bool>, cellular: Option<bool>) -> Result<(), String> {
    if let Some(is_cell) = cellular {
        CELLULAR_MODE.store(is_cell, Ordering::Release);
    }
    let only_auto = only_auto_resumable.unwrap_or(false);
    {
        let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        for item in &mut st.queue {
            if (item.status == "paused" || item.status == "error") && (!only_auto || item.auto_resume) {
                item.status = "queued".to_string();
                item.error = None;
                item.auto_resume = true;
                item.speed_formatted = "Queued".to_string();
            }
        }
        persist_all_locked(&st);
        emit_frontend_snapshot(&st);
    }
    ENGINE_NOTIFY.notify_one();
    Ok(())
}

#[tauri::command]
pub fn native_download_cancel(id: String) -> Result<(), String> {
    if !is_safe_segment(&id) {
        return Err("Invalid download ID".into());
    }
    trigger_cancel_flag(&id);
    if let Some(root) = offline_root() {
        let _ = fs::remove_dir_all(root.join(format!("{id}.part")));
    }
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.queue.retain(|q| q.id != id);
    persist_all_locked(&st);
    emit_frontend_snapshot(&st);
    Ok(())
}

#[tauri::command]
pub fn native_download_cancel_all() -> Result<(), String> {
    cancel_all_internal();
    Ok(())
}

#[tauri::command]
pub fn native_download_status() -> Result<Value, String> {
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let clean_queue: Vec<Value> = st
        .queue
        .iter()
        .map(|q| {
            json!({
                "id": q.id,
                "videoId": q.video_id,
                "episode": q.episode,
                "title": q.title,
                "cover": q.cover,
                "progress": q.progress,
                "downloadedBytes": q.downloaded_bytes,
                "totalBytes": q.total_bytes,
                "speedBytesPerSec": q.speed_bytes_per_sec,
                "speedFormatted": q.speed_formatted,
                "etaSeconds": q.eta_seconds,
                "etaFormatted": q.eta_formatted,
                "status": q.status,
                "error": q.error,
                "quality": q.quality,
                "isHevc": q.is_hevc,
                "autoResume": q.auto_resume,
            })
        })
        .collect();
    Ok(json!({
        "queue": clean_queue,
        "completed": st.completed,
    }))
}

#[tauri::command]
pub fn native_offline_list() -> Result<Vec<CompletedOfflineEpisode>, String> {
    let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    Ok(st.completed.clone())
}

#[tauri::command]
pub fn native_offline_delete(ids: Vec<String>) -> Result<(), String> {
    let root = offline_root();
    let id_set: HashSet<String> = ids.into_iter().filter(|id| is_safe_segment(id)).collect();
    if id_set.is_empty() {
        return Ok(());
    }
    if let Some(ref r) = root {
        for id in &id_set {
            let _ = fs::remove_dir_all(r.join(id));
            let _ = fs::remove_dir_all(r.join(format!("{id}.part")));
        }
    }
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    st.completed.retain(|c| !id_set.contains(&c.id));
    persist_all_locked(&st);
    emit_frontend_snapshot(&st);
    Ok(())
}

#[tauri::command]
pub fn native_offline_clear() -> Result<(), String> {
    let root = offline_root();
    let mut st = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref r) = root {
        for c in &st.completed {
            let _ = fs::remove_dir_all(r.join(&c.id));
        }
    }
    st.completed.clear();
    persist_all_locked(&st);
    emit_frontend_snapshot(&st);
    Ok(())
}

#[tauri::command]
pub async fn native_offline_prepare_export(id: String, file_name: String) -> Result<String, String> {
    if !is_safe_segment(&id) {
        return Err("Invalid episode ID".into());
    }
    let safe_name: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let safe_name = if safe_name.trim_matches('_').is_empty() {
        format!("{id}.mp4")
    } else {
        safe_name
    };

    let (ep_dir, is_hls) = {
        let root = offline_root().ok_or_else(|| "Offline storage unavailable".to_string())?;
        let st = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let meta = st
            .completed
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "Episode not found in native offline storage".to_string())?;
        (root.join(&id), meta.is_hls)
    };

    let dest_dir = exports_root().ok_or_else(|| "Cache directory unavailable".to_string())?;
    let dest_path = dest_dir.join(safe_name);

    tokio::task::spawn_blocking(move || assemble_export_from_dir(&ep_dir, is_hls, &dest_path).map(|()| dest_path.to_string_lossy().to_string()))
        .await
        .map_err(|e| format!("Export worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;

    #[test]
    fn selects_highest_bandwidth_variant_and_absolutizes() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/list.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\nhigh/list.m3u8\n";
        let picked = select_best_variant_url(master, "https://cdn.example/video/master.m3u8").unwrap();
        assert_eq!(picked, "https://cdn.example/video/high/list.m3u8");
    }

    #[test]
    fn rewrites_uri_attribute_cleanly() {
        let line = "#EXT-X-KEY:METHOD=AES-128,URI=\"https://cdn.example/k.key\",IV=0x01";
        let out = replace_uri_attr(line, "key_0.key");
        assert!(out.contains("URI=\"key_0.key\""));
        assert!(out.contains("METHOD=AES-128"));
        assert!(out.contains("IV=0x01"));
    }

    #[test]
    fn decrypts_aes128_cbc_pkcs7_padded_segment() {
        let key = b"1234567890abcdef";
        let iv = parse_hls_iv("0x00000000000000000000000000000001").unwrap();
        let plain = b"hello world!!!!!";
        // PKCS#7 pad 16-byte block with 16 bytes of 0x10
        let mut padded = plain.to_vec();
        padded.extend_from_slice(&[16u8; 16]);
        let cipher = Aes128::new_from_slice(key).unwrap();
        let mut encrypted = Vec::new();
        let mut prev = iv;
        for chunk in padded.chunks_exact(16) {
            let mut block = [0u8; 16];
            for i in 0..16 {
                block[i] = chunk[i] ^ prev[i];
            }
            cipher.encrypt_block((&mut block).into());
            encrypted.extend_from_slice(&block);
            prev = block;
        }
        let decrypted = decrypt_aes128_cbc(key, &iv, &encrypted).unwrap();
        assert_eq!(decrypted, plain);
    }

    #[test]
    fn safe_segment_rejects_traversal() {
        assert!(is_safe_segment("123_1"));
        assert!(is_safe_segment("seg_00001.ts"));
        assert!(!is_safe_segment("../secret"));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a\\b"));
        assert!(!is_safe_segment(""));
    }
}
