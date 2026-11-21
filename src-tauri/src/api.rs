//! API commands: Auth, feeds, details, playback, interactions. Created by AAA.

use crate::net::{base, edge};
use crate::session::{Session, SessionStore};
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

pub struct Api {
    pub session: SessionStore,
}

impl Api {
    pub fn new() -> Self {
        Self {
            session: SessionStore::new(),
        }
    }

    /// POST envelope required by playback endpoint.
    async fn post(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "POST", path, body, token.as_deref()).await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let origin = base();
        let token = self.session.token(&origin).filter(|_| {
            !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
        });
        edge(&origin, "GET", path, None, token.as_deref()).await
    }

    async fn authed(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let origin = base();
        let token = self
            .session
            .token(&origin)
            .ok_or_else(|| "Please sign in first".to_string())?;
        edge(&origin, method, path, body, Some(&token)).await
    }

    fn account_session(&self, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Session, String> {
        let origin = base();
        let session = self.session.snapshot(&origin).ok_or_else(|| "Please sign in first".to_string())?;
        if expected_origin.is_some_and(|value| value != origin)
            || expected_user_id.is_some_and(|value| session.user.get("id").and_then(Value::as_i64) != Some(value)) {
            return Err("Account or line changed; please retry".into());
        }
        Ok(session)
    }

    async fn account_request(&self, method: &str, path: &str, body: Option<Value>, expected_user_id: Option<i64>, expected_origin: Option<&str>) -> Result<Value, String> {
        let session = self.account_session(expected_user_id, expected_origin)?;
        let result = edge(&session.origin, method, path, body, Some(&session.token)).await?;
        if base() != session.origin || !self.session.is_current(&session) {
            return Err("Account or line changed; please retry".into());
        }
        Ok(result)
    }
}

/// Older mirrors wrap `user`; current account/me returns the User directly.
fn normalize_account(value: Value, origin: &str) -> Result<Value, String> {
    let source = value.get("user").filter(|v| v.is_object()).unwrap_or(&value);
    let mut user = json!({});
    // Only profile fields cross IPC; a legacy direct login response can also contain a token.
    for key in ["id", "username", "nickname", "avatar", "avatar_color", "sign", "desc", "user_type", "counts", "interactions"] {
        if let Some(field) = source.get(key) { user[key] = field.clone(); }
    }
    if !user.get("id").and_then(Value::as_i64).is_some_and(|id| id > 0) {
        return Err("Invalid profile response; please sign in again".into());
    }
    let interactions = value.get("interactions").or_else(|| user.get("interactions")).cloned();
    if let Some(ref interactions) = interactions { user["interactions"] = interactions.clone(); }
    let mut result = json!({"user": user, "origin": origin});
    if let Some(interactions) = interactions { result["interactions"] = interactions; }
    Ok(result)
}

fn normalize_account_history(value: Value) -> Result<Value, String> {
    let items = value.get("items").and_then(Value::as_array).ok_or("Invalid watch history response")?;
    let pagination = value.get("pagination").filter(|v| v.is_object()).ok_or("Invalid watch history pagination")?;
    let items: Vec<Value> = items.iter().filter_map(|item| {
        if item.get("target_type").and_then(Value::as_str) != Some("video") { return None; }
        let id = item.get("id")?.as_i64()?;
        let video_id = item.get("video_id")?.as_i64()?;
        if id <= 0 || video_id <= 0 { return None; }
        Some(json!({"id": id, "video_id": video_id, "target_type": "video",
            "last_ep": item.get("last_ep").and_then(Value::as_u64).unwrap_or(1).max(1),
            "updated_at": item.get("updated_at").and_then(Value::as_str).unwrap_or("")}))
    }).collect();
    for field in ["page", "pages", "size", "total"] {
        if pagination.get(field).and_then(Value::as_u64).is_none() { return Err("Invalid watch history pagination".into()); }
    }
    Ok(json!({"items": items, "pagination": pagination}))
}

/// Runtime errors logged to debug.log with UTC timestamps and PID.
#[tauri::command]
pub async fn debug_log(app: tauri::AppHandle, msg: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::logging::append_debug(&dir, &msg)
}

/// Network diagnostics: proxy, DNS, connectivity snapshot.
#[tauri::command]
pub async fn net_diag() -> Result<Value, String> {
    Ok(crate::net::diagnose().await)
}

/* ------------------------- Line / Data Source ------------------------- */
// Network probes run without holding this lock. Manual selection/cancellation
// invalidates older probes; applying a result is serialized with manual writes.
static LINE_SELECTION: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

fn begin_line_selection() -> Result<u64, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    *generation = generation.wrapping_add(1);
    Ok(*generation)
}

#[tauri::command]
pub async fn line_cancel() -> Result<(), String> {
    begin_line_selection().map(|_| ())
}

/// Current line + fixed lines list.
#[tauri::command]
pub async fn line_state() -> Result<Value, String> {
    Ok(json!({
        "base": base(),
        "default": crate::net::DEFAULT_BASE,
        "custom": crate::net::is_custom_line(),
        "fixed": crate::lines::fixed(),
    }))
}

/// Switch line manually: fixed lines or verified publisher mirrors.
#[tauri::command]
pub async fn line_set(state: State<'_, Api>, url: String) -> Result<String, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_base(&url)?;
    crate::net::refresh_client();
    if previous != applied {
        state.session.clear();
    }
    Ok(applied)
}

#[tauri::command]
pub async fn line_custom_set(state: State<'_, Api>, url: String) -> Result<Value, String> {
    let mut generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    *generation = generation.wrapping_add(1);
    let previous = base();
    let applied = crate::net::set_custom_base(&url)?;
    crate::net::refresh_client();
    if previous != applied { state.session.clear(); }
    Ok(json!({ "base": applied, "custom": crate::net::is_custom_line() }))
}

#[tauri::command]
pub async fn line_reset(state: State<'_, Api>) -> Result<Value, String> {
    let base = line_set(state, crate::net::DEFAULT_BASE.to_string()).await?;
    Ok(json!({ "base": base, "custom": false }))
}

#[tauri::command]
pub async fn proxy_state() -> Result<Value, String> {
    Ok(crate::net::proxy_state())
}

#[tauri::command]
pub async fn proxy_set(mode: String, url: String) -> Result<Value, String> {
    // Serialize with line application: probes using the previous proxy must
    // never switch the line after the new proxy has been saved.
    let mut generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    crate::proxy::set(&mode, &url)?;
    *generation = generation.wrapping_add(1);
    crate::net::refresh_client();
    let state = crate::net::proxy_state();
    crate::playback_log::record("proxy.changed", json!({
        "mode": state.get("mode"), "proxy": state.get("effective"),
    }));
    Ok(state)
}

#[tauri::command]
pub async fn proxy_test(mode: String, url: String) -> Result<Value, String> {
    Ok(crate::net::test_proxy(&mode, &url).await)
}

/// Fetch mirror lines from publisher page.
#[tauri::command]
pub async fn line_mirrors() -> Result<Value, String> {
    // Refresh system proxy settings on user demand
    crate::net::refresh_client();
    crate::lines::mirrors().await
}

/// Connectivity probe: report latency and status without auto-switching.
#[tauri::command]
pub async fn line_probe(urls: Vec<String>) -> Result<Value, String> {
    crate::net::refresh_client();
    Ok(crate::lines::probe(urls).await)
}

/// Auto line selection: probe primary site and verified publisher mirrors.
///
/// Auto line selection: probe primary site and verified publisher mirrors.
#[tauri::command]
pub async fn line_auto() -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let pick = crate::lines::auto_pick().await;
    let chosen = pick
        .get("base")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    let previous = base();
    if *generation == selection
        && pick.get("reason").and_then(Value::as_str) != Some("all-down")
        && !chosen.is_empty() && chosen != previous {
        let next = crate::net::set_base(&chosen)?;
        switched = next != previous;
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "cancelled": *generation != selection,
        "pick": pick,
    }))
}

/// Probe primary site and restore if healthy.
#[tauri::command]
pub async fn line_try_main() -> Result<Value, String> {
    let selection = begin_line_selection()?;
    crate::net::refresh_client();
    let probe = crate::lines::try_main().await;
    let mut switched = false;
    let generation = LINE_SELECTION.lock().map_err(|_| "Failed to acquire line selection lock")?;
    let previous = base();
    if *generation == selection && probe.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let chosen = probe.get("base").and_then(Value::as_str).unwrap_or_default();
        if !chosen.is_empty() && chosen != previous {
            let next = crate::net::set_base(chosen)?;
            switched = next != previous;
        }
    }
    Ok(json!({
        "previous": previous,
        "base": crate::net::base(),
        "switched": switched,
        "probe": probe,
        "cancelled": *generation != selection,
    }))
}

/* ------------------------- Update Check ------------------------- */

const REPO: &str = "cozgams/AuraStream";

fn ver_parts(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['.', '-', '+'])
        .map(|s| s.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// Compare semantic version numbers numerically.
fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (ver_parts(latest), ver_parts(current));
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Extract `x.y.z` from tag or release name.
///
/// Extract semver digits before comparing versions.
fn version_in(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        let mut j = i;
        while j < chars.len() && (chars[j].is_ascii_digit() || (chars[j] == '.' && dots < 2)) {
            if chars[j] == '.' {
                dots += 1;
            }
            j += 1;
        }
        if dots == 2 {
            return chars[start..j].iter().collect();
        }
        i = j.max(i + 1);
    }
    String::new()
}

/// Probe line health: test `/api/videos`.
#[tauri::command]
pub async fn line_health() -> Result<Value, String> {
    Ok(crate::lines::health().await)
}
/// Compare GitHub Release tag with current version.
#[tauri::command]
pub async fn check_update() -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let ua = format!("AuraStream/{current}");
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let timeout = std::time::Duration::from_secs(12);

    if let Ok(resp) = crate::net::get_with_ua(
        &url,
        timeout,
        Some("application/vnd.github+json"),
        Some(&ua),
    )
    .await
    {
        let status = resp.status();
        if status.as_u16() == 404 {
            return Ok(json!({
                "current": current, "latest": "", "has_update": false,
                "url": format!("https://github.com/{REPO}/releases"),
            }));
        }
        if status.is_success() {
            if let Ok(v) = resp.json::<Value>().await {
                let tag = v
                    .get("tag_name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let html = v
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
                let notes = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
                let latest = {
                    let found = version_in(&tag);
                    if found.is_empty() {
                        tag.trim_start_matches(['v', 'V']).to_string()
                    } else {
                        found
                    }
                };
                let assets = v.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
                let asset = assets
                    .iter()
                    .filter_map(|a| {
                        let name = a.get("name").and_then(Value::as_str)?;
                        let url = a.get("browser_download_url").and_then(Value::as_str)?;
                        let size = a.get("size").and_then(Value::as_u64);
                        Some((name.to_string(), url.to_string(), size))
                    })
                    .filter(|(n, _, _)| asset_rank(n) > 0)
                    .max_by_key(|(n, _, _)| asset_rank(n));
                let resolved_asset = asset
                    .map(|(name, url, size)| json!({ "name": name, "url": url, "size": size }))
                    .or_else(|| fallback_android_asset(&latest, &tag));
                return Ok(json!({
                    "current": current,
                    "latest": latest,
                    "tag": tag,
                    "arch": std::env::consts::ARCH,
                    "has_update": !latest.is_empty() && is_newer(&latest, &current),
                    "asset": resolved_asset,
                    "url": html,
                    "name": v.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                    "published_at": v.get("published_at").and_then(|x| x.as_str()).unwrap_or(""),
                    "notes": notes.chars().take(800).collect::<String>(),
                }));
            }
        }
    }

    // Fallback: single-hop redirect probe on GitHub web release URL (survives API rate limits)
    let web_url = format!("https://github.com/{REPO}/releases/latest");
    let (status, base_target, location) =
        crate::net::get_redirect_location(&web_url, timeout, Some(&ua)).await?;
    if status.as_u16() == 404 {
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }
    if let Some(loc) = location {
        let resolved = crate::network_policy::redirect_target(&base_target, &loc)?;
        let path = resolved.path();
        if let Some(raw_tag) = path.split("/releases/tag/").nth(1) {
            let tag = raw_tag.split(['?', '#', '/']).next().unwrap_or("").trim().to_string();
            if !tag.is_empty() {
                let latest = {
                    let found = version_in(&tag);
                    if found.is_empty() {
                        tag.trim_start_matches(['v', 'V']).to_string()
                    } else {
                        found
                    }
                };
                return Ok(json!({
                    "current": current,
                    "latest": latest,
                    "tag": tag,
                    "arch": std::env::consts::ARCH,
                    "has_update": !latest.is_empty() && is_newer(&latest, &current),
                    "asset": fallback_android_asset(&latest, &tag),
                    "url": resolved.to_string(),
                    "name": "",
                    "published_at": "",
                    "notes": "",
                }));
            }
        }
        return Ok(json!({
            "current": current, "latest": "", "has_update": false,
            "url": format!("https://github.com/{REPO}/releases"),
        }));
    }

    Err(format!("GitHub update check failed (HTTP {status})"))
}

#[cfg(target_os = "android")]
fn fallback_android_asset(latest: &str, tag: &str) -> Option<Value> {
    if latest.is_empty() || tag.is_empty() {
        return None;
    }
    let abi = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        "arm" => "arm",
        _ => "arm64",
    };
    let name = format!("AuraStream_{latest}_{abi}.apk");
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/{name}");
    Some(json!({ "name": name, "url": url, "size": Value::Null }))
}

#[cfg(not(target_os = "android"))]
fn fallback_android_asset(_latest: &str, _tag: &str) -> Option<Value> {
    None
}

/// Open URL with system browser (http/https only).
/// Score package assets to pick optimal architecture for current platform.
fn asset_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if cfg!(target_os = "android") {
        if !n.ends_with(".apk") {
            0
        } else if cfg!(target_arch = "aarch64") {
            if n.contains("arm64") || n.contains("aarch64") {
                3
            } else {
                1
            }
        } else if cfg!(target_arch = "x86_64") {
            if n.contains("x86_64") {
                3
            } else {
                1
            }
        } else if n.contains("x86") || n.contains("arm64") {
            1
        } else {
            2
        }
    } else if cfg!(target_os = "windows") {
        if n.ends_with(".exe") { 3 } else { 0 }
    } else if cfg!(target_os = "macos") {
        if n.ends_with(".dmg") { 3 } else { 0 }
    } else if n.ends_with(".deb") {
        3
    } else if n.ends_with(".appimage") {
        2
    } else {
        0
    }
}

#[tauri::command]
pub async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = crate::network_policy::parse_target(&url)?;
    // Use default system handler
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Set mobile screen orientation (Landscape / Portrait).
#[tauri::command]
pub async fn set_orientation(app: tauri::AppHandle, landscape: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = app.run_on_main_thread(move || {
            request_ios_orientation(landscape);
        });
    }
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let script = if landscape {
            "window.AuraNativeExport?.setOrientation?.(true)"
        } else {
            "window.AuraNativeExport?.setOrientation?.(false)"
        };
        if let Some(window) = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next())
        {
            let _ = window.eval(script);
        }
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (&app, landscape);
    }
    Ok(())
}

/// iOS: toggle WKWebView text selection magnifier on long press.
#[tauri::command]
pub fn set_text_interaction(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            crate::ios_layout::set_text_interaction_on_webview(window.as_ref(), enabled);
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (&app, enabled);
    }
    Ok(())
}

#[cfg(target_os = "ios")]
fn request_ios_orientation(landscape: bool) {
    use std::ffi::{c_char, c_void};
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    unsafe {
        let msg0: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg0_usize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_usize: unsafe extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        let msg2_ptr: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        let msg1_void: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());

        // iOS 16+ UIWindowScene.requestGeometryUpdateWithPreferences:errorHandler:
        // UIInterfaceOrientationMaskPortrait = 1 << 1 = 2
        // UIInterfaceOrientationMaskLandscapeRight = 1 << 3 = 8
        let mask: usize = if landscape { 8 } else { 2 };
        let prefs_cls = objc_getClass(b"UIWindowSceneGeometryPreferencesIOS\0".as_ptr() as *const c_char);
        let app_cls = objc_getClass(b"UIApplication\0".as_ptr() as *const c_char);
        if !prefs_cls.is_null() && !app_cls.is_null() {
            let sel_alloc = sel_registerName(b"alloc\0".as_ptr() as *const c_char);
            let sel_init = sel_registerName(b"initWithInterfaceOrientations:\0".as_ptr() as *const c_char);
            let raw_prefs = msg0(prefs_cls, sel_alloc);
            let prefs = if !raw_prefs.is_null() {
                msg1_usize(raw_prefs, sel_init, mask)
            } else {
                std::ptr::null_mut()
            };

            let sel_shared = sel_registerName(b"sharedApplication\0".as_ptr() as *const c_char);
            let app = msg0(app_cls, sel_shared);
            if !app.is_null() && !prefs.is_null() {
                let sel_scenes = sel_registerName(b"connectedScenes\0".as_ptr() as *const c_char);
                let scenes_set = msg0(app, sel_scenes);
                if !scenes_set.is_null() {
                    let sel_all = sel_registerName(b"allObjects\0".as_ptr() as *const c_char);
                    let arr = msg0(scenes_set, sel_all);
                    if !arr.is_null() {
                        let sel_count = sel_registerName(b"count\0".as_ptr() as *const c_char);
                        let sel_at = sel_registerName(b"objectAtIndex:\0".as_ptr() as *const c_char);
                        let sel_req = sel_registerName(
                            b"requestGeometryUpdateWithPreferences:errorHandler:\0".as_ptr() as *const c_char,
                        );
                        let sel_responds = sel_registerName(b"respondsToSelector:\0".as_ptr() as *const c_char);
                        let msg_responds: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> bool =
                            std::mem::transmute(objc_msgSend as *const ());
                        let count = msg0_usize(arr, sel_count);
                        for i in 0..count {
                            let scene = msg1_usize(arr, sel_at, i);
                            if !scene.is_null() && msg_responds(scene, sel_responds, sel_req) {
                                msg2_ptr(scene, sel_req, prefs, std::ptr::null_mut());
                            }
                        }
                    }
                }
            }
        }

        // Fallback: UIDevice setValue:forKey:@"orientation" + attemptRotationToDeviceOrientation
        let dev_cls = objc_getClass(b"UIDevice\0".as_ptr() as *const c_char);
        let num_cls = objc_getClass(b"NSNumber\0".as_ptr() as *const c_char);
        let str_cls = objc_getClass(b"NSString\0".as_ptr() as *const c_char);
        let vc_cls = objc_getClass(b"UIViewController\0".as_ptr() as *const c_char);
        if !dev_cls.is_null() && !num_cls.is_null() && !str_cls.is_null() {
            let sel_cur = sel_registerName(b"currentDevice\0".as_ptr() as *const c_char);
            let dev = msg0(dev_cls, sel_cur);
            let sel_num = sel_registerName(b"numberWithInteger:\0".as_ptr() as *const c_char);
            let orient_val: usize = if landscape { 3 } else { 1 };
            let num = msg1_usize(num_cls, sel_num, orient_val);
            let sel_str = sel_registerName(b"stringWithUTF8String:\0".as_ptr() as *const c_char);
            let msg_str: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
                std::mem::transmute(objc_msgSend as *const ());
            let key = msg_str(str_cls, sel_str, b"orientation\0".as_ptr() as *const c_char);
            if !dev.is_null() && !num.is_null() && !key.is_null() {
                let sel_set_val = sel_registerName(b"setValue:forKey:\0".as_ptr() as *const c_char);
                msg2_ptr(dev, sel_set_val, num, key);
            }
            if !vc_cls.is_null() {
                let sel_attempt = sel_registerName(b"attemptRotationToDeviceOrientation\0".as_ptr() as *const c_char);
                msg1_void(vc_cls, sel_attempt);
            }
        }
    }
}

/* ------------------------- Session ------------------------- */

/// Gracefully exit the application (used by Android double-tap back on Home).
#[tauri::command]
pub fn app_exit(app: tauri::AppHandle, code: Option<i32>) {
    app.exit(code.unwrap_or(0));
}

#[tauri::command]
pub async fn app_boot(state: State<'_, Api>) -> Result<Value, String> {
    let origin = base();
    if crate::network_policy::strict_security()
        && state.session.token(&origin).is_some()
        && !crate::net::trusted_auth_origin(&origin)
    {
        let _ = crate::lines::verify_published_origin(&origin).await;
    }
    let origin = base();
    let credentials_allowed = !crate::network_policy::strict_security()
        || crate::net::trusted_auth_origin(&origin);
    Ok(json!({
        "user": if credentials_allowed { state.session.user(&origin) } else { Value::Null },
        "logged_in": credentials_allowed && state.session.token(&origin).is_some(),
        "base": origin,
        "strict_security": crate::network_policy::strict_security(),
        "cli_relaxed": crate::network_policy::cli_strict_override() == Some(false),
    }))
}

/// Toggle strict security mode.
#[tauri::command]
pub async fn security_set(strict: bool) -> Result<bool, String> {
    crate::network_policy::set_strict_security(strict)?;
    crate::net::refresh_client();
    crate::playback_log::record(
        "security.mode_changed",
        json!({"strict": crate::network_policy::strict_security()}),
    );
    Ok(crate::network_policy::strict_security())
}

#[tauri::command]
pub async fn api_login(
    state: State<'_, Api>,
    username: String,
    password: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
    let data = edge(
        &origin,
        "POST",
        "/api/account/loginByPassword",
        Some(json!({ "username": username, "password": password })),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Login response missing token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("Line changed during login; please sign in again".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("Account status changed during login; please retry".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_register(
    state: State<'_, Api>,
    username: String,
    password: String,
    email: String,
) -> Result<Value, String> {
    let origin = base();
    let revision = state.session.revision();
    let mut body = json!({
        "username": username,
        "password": password,
        "confirm_password": password,
    });
    if !email.trim().is_empty() {
        body["email"] = json!(email);
    }
    let data = edge(
        &origin,
        "POST",
        "/api/account/registerByPassword",
        Some(body),
        None,
    )
    .await?;
    let token = data
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Registration response missing token".to_string())?
        .to_string();
    let account = normalize_account(data, &origin)?;
    let user = account["user"].clone();
    if base() != origin {
        return Err("Line changed during registration; please sign in again".into());
    }
    if !state.session.set_if_revision(revision, &origin, token, user) {
        return Err("Account status changed during registration; please retry".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_logout(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let _ = edge(
        &session.origin,
        "POST",
        "/api/account/logout",
        None,
        Some(&session.token),
    )
    .await;
    if !state.session.clear_if_current(&session) {
        return Err("Account changed; please retry".into());
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn api_me(state: State<'_, Api>, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let session = state.account_session(expected_user_id, expected_origin.as_deref())?;
    let me = edge(&session.origin, "GET", "/api/account/me", None, Some(&session.token)).await?;
    let account = normalize_account(me, &session.origin)?;
    if base() != session.origin {
        return Err("Line changed while fetching account".into());
    }
    if !state.session.update_user_if_current(&session, account["user"].clone()) {
        return Err("Login status changed while fetching account".into());
    }
    Ok(account)
}

#[tauri::command]
pub async fn api_account_history(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let size = size.clamp(1, 100);
    let value = state.account_request("GET", &format!("/api/users/me/history?page={page}&size={size}"), None,
        Some(expected_user_id), Some(&expected_origin)).await?;
    normalize_account_history(value)
}

#[tauri::command]
pub async fn api_account_history_record(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, video_id: i64, ep: u32) -> Result<Value, String> {
    if video_id <= 0 || ep == 0 { return Err("Invalid watch history parameters".into()); }
    state.account_request("POST", "/api/users/me/history", Some(json!({"video_id": video_id, "ep": ep})),
        Some(expected_user_id), Some(&expected_origin)).await
}

#[tauri::command]
pub async fn api_account_history_delete(state: State<'_, Api>, expected_user_id: i64, expected_origin: String, ids: Vec<i64>) -> Result<Value, String> {
    if ids.is_empty() || ids.len() > 200 || ids.iter().any(|id| *id <= 0) { return Err("Invalid watch history parameters".into()); }
    state.account_request("POST", "/api/users/me/history/delete", Some(json!({"ids": ids})),
        Some(expected_user_id), Some(&expected_origin)).await
}

/* ------------------------- Video Feeds ------------------------- */

#[tauri::command]
pub async fn api_feed(state: State<'_, Api>, page: u32, size: u32) -> Result<Value, String> {
    state
        .get(&format!("/api/videos?page={page}&size={size}"))
        .await
}

/// Original channel video feed.
/// Filter by category route:
/// `/api/videos/category/{cate}?is_original=1`
fn encode_query_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn format_sort_param(sort: Option<&str>) -> String {
    match sort.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!("&sort={}", encode_query_component(s)),
        None => String::new(),
    }
}

#[tauri::command]
pub async fn api_original_videos(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = format_sort_param(sort.as_deref());
    let path = if cate == "all" {
        format!("/api/videos?is_original=1&page={page}&size={size}{sort}")
    } else {
        let encoded_cate = encode_query_component(&cate);
        format!("/api/videos/category/{encoded_cate}?is_original=1&page={page}&size={size}{sort}")
    };
    state.get(&path).await
}

/* ------------------------- Topics / Tags ------------------------- */

/// Topics list: `/api/topics` returns data.items.
#[tauri::command]
pub async fn api_topics(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/topics?size=100").await
}

/// Topic details: `/api/topics/{slug}`.
#[tauri::command]
pub async fn api_topic(state: State<'_, Api>, slug: String) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
    state.get(&format!("/api/topics/{encoded}")).await
}

/// Tags list: `/api/tags` returns categories.
#[tauri::command]
pub async fn api_tags(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/tags").await
}

/// Get videos by tag.
#[tauri::command]
pub async fn api_tag_videos(
    state: State<'_, Api>,
    tag: String,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
    state
        .get(&format!("/api/videos/tag/{encoded}?page={page}&size={size}"))
        .await
}

#[tauri::command]
pub async fn api_category(
    state: State<'_, Api>,
    cate: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = format_sort_param(sort.as_deref());
    let encoded_cate = encode_query_component(&cate);
    state
        .get(&format!(
            "/api/videos/category/{encoded_cate}?page={page}&size={size}{sort}"
        ))
        .await
}

#[tauri::command]
pub async fn api_rank(state: State<'_, Api>, kind: String) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "recommend" | "potential" => kind,
        _ => "hot".to_string(),
    };
    state.get(&format!("/api/ranks/{kind}")).await
}

/// Global search: `/api/search?q=...&type=video|post`.
///
/// Pass `type=post` explicitly when searching posts.
#[tauri::command]
pub async fn api_search(
    state: State<'_, Api>,
    q: String,
    page: u32,
    size: u32,
    kind: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
    let scope = match kind.as_deref() {
        Some("post") => "&type=post",
        Some("video") => "&type=video",
        _ => "",
    };
    state
        .get(&format!("/api/search?q={encoded}&page={page}&size={size}{scope}"))
        .await
}

/// Trending search: parse hot ranking items.
#[tauri::command]
pub async fn api_search_hot(_state: State<'_, Api>) -> Result<Value, String> {
    crate::search_hot::fetch().await
}

#[tauri::command]
pub async fn api_posts(
    state: State<'_, Api>,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let sort = format_sort_param(sort.as_deref());
    state
        .get(&format!("/api/posts?page={page}&size={size}{sort}"))
        .await
}

#[tauri::command]
pub async fn api_post(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/posts/{id}")).await
}

/// Post video playback: fetch playback URL for post videos.
#[tauri::command]
pub async fn api_post_playback(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state
        .post(&format!("/api/posts/{id}/playback"), Some(json!({})))
        .await
}

/* ------------------------- Details / Playback ------------------------- */

#[tauri::command]
pub async fn api_video(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}")).await
}

fn non_empty(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null() && x.as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// Map playback streams to video_url.
fn normalize_play_info(info: &mut Value) {
    let Some(obj) = info.as_object_mut() else { return };
    for (field, key) in [("video_url", "main"), ("video_url_hevc", "hevc")] {
        let url = obj
            .get("streams")
            .and_then(|st| st.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
        if let Some(url) = url {
            if non_empty(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
}

fn has_play_url(info: &Value) -> bool {
    info.get("video_url")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty())
}

pub async fn resolve_episode_play(
    origin: &str,
    token: Option<&str>,
    id: i64,
    ep: u32,
) -> Result<Value, String> {
    let primary = edge(
        origin,
        "POST",
        &format!("/api/videos/{id}/episodes/{ep}/playback"),
        Some(json!({})),
        token,
    )
    .await
    .map(|mut info| {
        normalize_play_info(&mut info);
        info
    });
    if let Ok(info) = &primary {
        if has_play_url(info) {
            return primary;
        }
    }
    match edge(
        origin,
        "GET",
        &format!("/api/videos/{id}/play?ep={ep}&page_texts=0"),
        None,
        token,
    )
    .await
    {
        Ok(mut legacy) => {
            normalize_play_info(&mut legacy);
            if has_play_url(&legacy) || primary.is_err() {
                Ok(legacy)
            } else {
                primary
            }
        }
        Err(_) => primary,
    }
}

#[tauri::command]
pub async fn api_play(state: State<'_, Api>, id: i64, ep: u32) -> Result<Value, String> {
    let origin = base();
    let token = state.session.token(&origin).filter(|_| {
        !crate::network_policy::strict_security() || crate::net::trusted_auth_origin(&origin)
    });
    resolve_episode_play(&origin, token.as_deref(), id, ep).await
}

/* ------------------------- Comments / Interactions ------------------------- */

#[tauri::command]
pub async fn api_comments(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!(
            "/api/videos/{id}/comments?ep={ep}&page={page}&size={size}"
        ))
        .await
}

#[tauri::command]
pub async fn api_comment_send(
    state: State<'_, Api>,
    id: i64,
    ep: u32,
    text: String,
    reply_id: Option<i64>,
) -> Result<Value, String> {
    let mut body = json!({ "text": text });
    let path = match reply_id {
        Some(rid) if rid > 0 => {
            body["reply_id"] = json!(rid);
            format!("/api/videos/{id}/comments")
        }
        _ => format!("/api/videos/{id}/comments?ep={ep}"),
    };
    state.authed("POST", &path, Some(body)).await
}

#[tauri::command]
pub async fn api_like(state: State<'_, Api>, id: i64, ep: u32, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/like?ep={ep}"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/videos/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_follow(state: State<'_, Api>, uid: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/users/{uid}/follow"), None, expected_user_id, expected_origin.as_deref())
        .await
}

/* ------------------------- Local Cache ------------------------- */

#[tauri::command]
pub async fn cache_clear() -> Result<(), String> {
    crate::media::clear_caches();
    Ok(())
}

/* ------------------------- Post Interactions ------------------------- */

#[tauri::command]
pub async fn api_post_like(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/like"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_post_collect(state: State<'_, Api>, id: i64, on: bool, expected_user_id: Option<i64>, expected_origin: Option<String>) -> Result<Value, String> {
    let method = if on { "POST" } else { "DELETE" };
    state
        .account_request(method, &format!("/api/posts/{id}/collect"), None, expected_user_id, expected_origin.as_deref())
        .await
}

#[tauri::command]
pub async fn api_post_comments(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/posts/{id}/comments?page={page}&size={size}"))
        .await
}

/// Post categories: `/api/site/categories/post`.
#[tauri::command]
pub async fn api_post_categories(state: State<'_, Api>) -> Result<Value, String> {
    state.get("/api/site/categories/post").await
}

/// Get posts by category.
#[tauri::command]
pub async fn api_post_category(
    state: State<'_, Api>,
    route: String,
    page: u32,
    size: u32,
    sort: Option<String>,
) -> Result<Value, String> {
    let encoded: String = url::form_urlencoded::byte_serialize(route.as_bytes()).collect();
    let sort = format_sort_param(sort.as_deref());
    state
        .get(&format!(
            "/api/posts/category/{encoded}?page={page}&size={size}{sort}"
        ))
        .await
}

/// Related videos: `/api/videos/{id}/related`.
#[tauri::command]
pub async fn api_related(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/videos/{id}/related")).await
}

/// Following feed: `/api/videos/following` (auth required).
#[tauri::command]
pub async fn api_following(
    state: State<'_, Api>,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .authed("GET", &format!("/api/videos/following?page={page}&size={size}"), None)
        .await
}

/// User profile: `/api/users/{id}`.
#[tauri::command]
pub async fn api_user(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}")).await
}

/// User statistics: `/api/users/{id}/stats`.
#[tauri::command]
pub async fn api_user_stats(state: State<'_, Api>, id: i64) -> Result<Value, String> {
    state.get(&format!("/api/users/{id}/stats")).await
}

/// User videos: `/api/videos/user/{id}`.
#[tauri::command]
pub async fn api_user_videos(
    state: State<'_, Api>,
    id: i64,
    page: u32,
    size: u32,
) -> Result<Value, String> {
    state
        .get(&format!("/api/videos/user/{id}?page={page}&size={size}"))
        .await
}
#[cfg(test)]
mod tests {
    use super::{is_newer, normalize_account, normalize_account_history, version_in};
    use serde_json::{json, Value};

    #[test]
    fn account_snapshot_accepts_direct_and_wrapped_profiles_without_credentials() {
        for value in [json!({"id": 7, "nickname": "fixture", "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}}),
            json!({"user": {"id": 7, "nickname": "fixture"}, "token": "not-for-ipc", "interactions": {"favorite_video_ids": [9]}})] {
            let result = normalize_account(value, "https://example.com").unwrap();
            assert_eq!(result["user"]["id"], 7);
            assert_eq!(result["interactions"]["favorite_video_ids"], json!([9]));
            assert_eq!(result["origin"], "https://example.com");
            assert!(result.get("token").is_none());
            assert!(result["user"].get("token").is_none());
        }
        assert!(normalize_account(json!({"user": {"nickname": "invalid"}}), "https://example.com").is_err());
        assert!(normalize_account(json!({"id": 0}), "https://example.com").is_err());
    }

    #[test]
    fn account_history_preserves_row_identity_and_pagination_without_media_metadata() {
        let result = normalize_account_history(json!({"items": [
            {"id": 18, "video_id": 9, "last_ep": 3, "target_type": "video", "updated_at": "2026-11-15 10:00:00", "title": "fixture", "cover": "unused"},
            {"id": 19, "video_id": 10, "last_ep": 1, "target_type": "post"},
            {"id": 20, "last_ep": 1, "target_type": "video"}
        ], "pagination": {"page": 2, "pages": 3, "size": 2, "total": 5}})).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["id"], 18);
        assert_eq!(result["items"][0]["video_id"], 9);
        assert_eq!(result["items"][0]["last_ep"], 3);
        assert!(result["items"][0].get("cover").is_none());
        assert!(result["items"][0].get("title").is_none());
        assert_eq!(result["pagination"]["pages"], 3);
        assert!(normalize_account_history(json!({"items": []})).is_err());
    }

    #[test]
    fn frontend_cannot_bypass_url_policy_with_opener_commands() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for permission in capability["permissions"].as_array().unwrap() {
            let name = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .unwrap();
            assert!(
                !name.starts_with("opener:"),
                "frontend opener command exposed: {name}"
            );
        }
    }

    #[test]
    fn external_links_are_urls_not_shell_commands() {
        for raw in [
            "https://example.com/|calc.exe",
            "https://example.com/?a=1&b=2",
            "https://example.com/%25PATH%25",
            "https://example.com/%VAR%",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_ok());
        }
        for raw in [
            "file:///etc/passwd",
            "mailto:user@example.com",
            "tel:123",
            "data:text/html,test",
            "javascript:alert(1)",
            "https://example.com/\0cmd",
            "https://user:password@example.com/",
        ] {
            assert!(crate::network_policy::parse_target(raw).is_err());
        }
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v1.0.2", "1.0.1"));
        assert!(is_newer("v1.1", "1.0.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("v1.0.1", "1.0.1"));
        assert!(!is_newer("v0.9.9", "1.0.1"));
        assert!(!is_newer("", "1.0.1"));
    }
    /// Extract semver digits before comparing versions.
    #[test]
    fn reads_version_out_of_tag() {
        assert_eq!(version_in("hgfix-1.2.1-r5"), "1.2.1");
        assert_eq!(version_in("v1.2.0"), "1.2.0");
        assert_eq!(version_in("AuraStream 2.1.0+build.1"), "2.1.0");
        assert_eq!(version_in("release-notes"), "");
        assert!(is_newer(&version_in("hgfix-1.2.2-r6"), "1.2.1+hg.1"));
        assert!(is_newer(&version_in("hgfix-1.10.0-r9"), "1.9.9+hg.1"));
        assert!(!is_newer(&version_in("hgfix-1.2.1-r5"), "1.2.1+hg.1"));
    }
}
