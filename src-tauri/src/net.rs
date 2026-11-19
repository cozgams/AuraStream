//! Network layer: Communication with upstream API service.
//!
//! All requests route through the edge request envelope.
//!
//! Proxy and transport configuration:
//! * Uses reqwest with system-proxy features on desktop platforms.
//! * Honors HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY environment variables.
//! * Provides integrated diagnostics for DNS, direct TCP socket connectivity, and HTTP responses.
//! * Automatic connection pool healing upon network or proxy handshake drops.

use crate::network_policy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// Default upstream line (Fixed Line 1).
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// Current upstream base URL without trailing slash.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LineConfig {
    base: String,
    custom: bool,
}

impl Default for LineConfig {
    fn default() -> Self {
        Self { base: DEFAULT_BASE.to_string(), custom: false }
    }
}

static BASE: Lazy<RwLock<LineConfig>> = Lazy::new(|| RwLock::new(LineConfig::default()));
/// Line config file path (app_data_dir/line.json).
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// Current upstream base URL.
pub fn base() -> String {
    BASE.read()
        .map(|b| b.base.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

pub fn is_custom_line() -> bool {
    BASE.read().is_ok_and(|line| line.custom)
}

/// Line must be a pure HTTPS origin without paths, credentials, or queries.
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target_with_mode(raw.trim(), true).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// Returns true if the origin is trusted for authentication credential forwarding.
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
        || crate::lines::is_trusted_mirror(origin)
        || BASE.read().is_ok_and(|line| line.custom && line.base == origin)
}

fn persisted_base(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    normalize_base(value.get("base")?.as_str()?)
}

fn persisted_line(text: &str) -> Option<LineConfig> {
    let base = persisted_base(text)?;
    let value: Value = serde_json::from_str(text).ok()?;
    // Accept the fork's v2 format as well as legacy {base}. Only explicit v2
    // custom selections carry custom-origin consent across restarts.
    let custom = value.get("v").and_then(Value::as_u64) == Some(2)
        && value.get("custom").and_then(Value::as_bool).unwrap_or(false)
        && base != DEFAULT_BASE;
    Some(LineConfig { base, custom })
}

/// Restore line on startup.
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    crate::proxy::bind(dir);
    let path = dir.join("line.json");
    let restored = std::fs::read_to_string(&path).ok()
        .and_then(|text| persisted_line(&text)).unwrap_or_default();
    if let Ok(mut current) = BASE.write() {
        *current = restored;
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
}

/// Switch line and persist to disk.
pub fn set_base(url: &str) -> Result<String, String> {
    apply_base(url, false)
}

/// An explicit custom selection, separate from published/automatic candidates.
pub fn set_custom_base(url: &str) -> Result<String, String> {
    apply_base(url, true)
}

fn save_line(current: &mut LineConfig, next: LineConfig, path: Option<&std::path::Path>) -> Result<(), String> {
    if let Some(path) = path {
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json!({ "v": 2, "base": next.base, "custom": next.custom }).to_string())
            .and_then(|_| std::fs::rename(&temp, path))
            .map_err(|_| "Failed to save line; existing line retained. Please check app data directory")?;
    }
    *current = next;
    Ok(())
}

fn apply_base(url: &str, custom: bool) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "Invalid line address (requires pure HTTPS URL, private network forbidden)".to_string())?;
    if !custom && !crate::lines::is_fixed(&next) && !crate::lines::is_trusted_mirror(&next) {
        return Err("Line not found in fixed lines or trusted publisher list".into());
    }
    let mut current = BASE.write().map_err(|_| "Failed to acquire line settings lock")?;
    let previous = current.base.clone();
    let file = BASE_FILE.read().map_err(|_| "Failed to acquire line config lock")?;
    save_line(&mut current, LineConfig { base: next.clone(), custom: custom && next != DEFAULT_BASE }, file.as_deref())?;
    drop(current);
    if previous != next {
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Manual proxy override via AURASTREAM_PROXY or legacy HGHUBX_PROXY.
fn proxy_override() -> Option<String> {
    crate::env::var("PROXY")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Check if proxy environment variables are set.
fn env_proxy_set() -> bool {
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
        .iter()
        .any(|key| std::env::var(key).ok().is_some_and(|v| !v.trim().is_empty()))
}

/// Explicit proxy configuration resolution.
fn system_explicit_proxy() -> Option<String> {
    if let Some(p) = proxy_override() {
        return Some(p);
    }
    if env_proxy_set() {
        return None;
    }
    gnome_proxy()
}

#[cfg(target_os = "linux")]
fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Read GNOME system proxy settings via gsettings.
#[cfg(target_os = "linux")]
fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(unquote(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(target_os = "linux")]
fn format_proxy_url(scheme: &str, host: &str, port: &str) -> String {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!("{scheme}://{host}:{port}")
}

/// Linux desktop GNOME manual proxy configuration.
#[cfg(target_os = "linux")]
fn gnome_proxy() -> Option<String> {
    if gsettings_get("org.gnome.system.proxy", "mode").as_deref() != Some("manual") {
        return None;
    }
    let http_host = gsettings_get("org.gnome.system.proxy.http", "host").unwrap_or_default();
    let http_port = gsettings_get("org.gnome.system.proxy.http", "port").unwrap_or_default();
    if !http_host.is_empty() && !http_port.is_empty() {
        return Some(format_proxy_url("http", &http_host, &http_port));
    }
    let socks_host = gsettings_get("org.gnome.system.proxy.socks", "host").unwrap_or_default();
    let socks_port = gsettings_get("org.gnome.system.proxy.socks", "port").unwrap_or_default();
    if !socks_host.is_empty() && !socks_port.is_empty() {
        return Some(format_proxy_url("socks5", &socks_host, &socks_port));
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn gnome_proxy() -> Option<String> {
    None
}

/// Windows system proxy check via registry.
#[cfg(target_os = "windows")]
fn windows_proxy_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return false;
    };
    let enabled: u32 = match key.get_value("ProxyEnable") {
        Ok(v) => v,
        Err(_) => return false,
    };
    if enabled != 1 {
        return false;
    }
    key.get_value::<String, _>("ProxyServer")
        .is_ok_and(|server| !server.trim().is_empty())
}

#[cfg(not(target_os = "windows"))]
fn windows_proxy_enabled() -> bool {
    false
}

/// macOS system proxy check via scutil.
#[cfg(target_os = "macos")]
fn macos_proxy_enabled() -> bool {
    let Ok(out) = std::process::Command::new("scutil").arg("--proxy").output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    ["HTTPEnable", "HTTPSEnable", "SOCKSEnable"]
        .iter()
        .any(|key| {
            text.lines().any(|line| {
                let mut parts = line.splitn(2, ':');
                parts.next().map(str::trim) == Some(*key)
                    && parts.next().map(|value| value.trim() == "1").unwrap_or(false)
            })
        })
}

#[cfg(not(target_os = "macos"))]
fn macos_proxy_enabled() -> bool {
    false
}

/// Check whether OS system proxy is enabled.
fn system_proxy_enabled() -> bool {
    windows_proxy_enabled() || macos_proxy_enabled() || gnome_proxy().is_some()
}

/// Build client with current system proxy settings.
///
// Rebuild client on proxy changes to avoid stale underlying connections.
fn build_client(host: &str, addrs: &[SocketAddr], route: &ProxyRoute) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if route.mode == crate::proxy::Mode::Off {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &route.explicit {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| "Invalid proxy address")?;
        builder = builder.no_proxy().proxy(proxy);
    }
    builder.build().map_err(|_| " HTTP ".to_string())
}

/// One immutable selection is used for DNS, cache identity and client creation.
/// An in-flight request may finish on its old route; it cannot populate the new
/// configuration's cache entry after the user saves a different proxy.
struct ProxyRoute {
    mode: crate::proxy::Mode,
    explicit: Option<String>,
    active: bool,
    generation: u64,
}

impl ProxyRoute {
    fn for_config(config: &crate::proxy::Config, target: &url::Url) -> Self {
        use crate::proxy::Mode;
        let explicit = match config.mode {
            Mode::Off => None,
            Mode::Custom => Some(config.url.clone()),
            Mode::System => system_explicit_proxy(),
        };
        let active = match config.mode {
            Mode::Off => false,
            Mode::Custom => true,
            Mode::System => explicit.is_some() || system_proxy_routes_target(target),
        };
        Self { mode: config.mode, explicit, active, generation: CLIENT_GENERATION.load(Ordering::Acquire) }
    }

    fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.mode.hash(&mut hash);
        self.explicit.hash(&mut hash);
        hash.finish()
    }

    fn label(&self) -> String {
        if self.mode == crate::proxy::Mode::Off {
            "direct".into()
        } else if let Some(proxy) = &self.explicit {
            redact_proxy(proxy)
        } else if self.active {
            "system".into()
        } else {
            "direct".into()
        }
    }
}

static CLIENT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));
static MEDIA_DNS_ROUTES: Lazy<Mutex<crate::media_dns::Routes>> =
    Lazy::new(|| Mutex::new(crate::media_dns::Routes::default()));

fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// Return cached or newly constructed HTTP client for target URL.
async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    client_for_dns(raw, false).await
}

/// Keep Apple's existing per-target NO_PROXY/per-scheme/system matching.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn system_proxy_routes_target(target: &url::Url) -> bool {
    crate::apple_proxy::routes_target(
        &hyper_util::client::proxy::matcher::Matcher::from_system(),
        target.as_str(),
    )
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn system_proxy_routes_target(_target: &url::Url) -> bool {
    env_proxy_set() || windows_proxy_enabled()
}

fn proxy_active(target: &url::Url) -> bool {
    ProxyRoute::for_config(&crate::proxy::snapshot(), target).active
}

fn client_key(strict: bool, host: &str, port: u16, public_dns: bool, route: &ProxyRoute) -> String {
    format!("{strict}:{host}:{port}:{public_dns}:{}:{:x}:{}", route.active, route.fingerprint(), route.generation)
}

async fn client_for_dns(raw: &str, public_dns: bool) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("Target missing hostname")?;
    let port = target.port_or_known_default().ok_or("")?;
    let route = ProxyRoute::for_config(&crate::proxy::snapshot(), &target);
    let proxy = route.active;
    let key = client_key(strict, host, port, public_dns, &route);
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP ")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let (addrs, ttl) = if proxy {
        // Proxy route: remote proxy resolves host addresses directly.
        (Vec::new(), CLIENT_TTL)
    } else if public_dns {
        let resolver = build_client(crate::media_dns::HOST, &crate::media_dns::BOOTSTRAP, &route)?;
        let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
        network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
        (resolution.addresses, CLIENT_TTL.min(resolution.ttl))
    } else if strict {
        (network_policy::resolve_target(&target, strict).await?, CLIENT_TTL)
    } else {
        (Vec::new(), CLIENT_TTL)
    };
    let http = Arc::new(build_client(host, &addrs, &route)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP ")?;
    // Preserve already cached client if another worker inserted it concurrently.
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + ttl, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    // Builders still resolving DNS must not repopulate the new generation.
    CLIENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
    if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
        *routes = crate::media_dns::Routes::default();
    }
}

/// Execute HTTP GET request with DNS validation and proxy routing.
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_with_dns(raw, timeout, accept, referer, false).await
}

async fn get_with_dns(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("Too many redirects".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("Redirect missing valid Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("Too many redirects".into())
    })
    .await
    .map_err(|_| "Request timed out".to_string())?
}

/// Redact proxy URL to hide credentials.
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[configured, raw value hidden]".into(),
    }
}

/// Check if error is related to proxy or tunneling failure.
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// Heal connection pool on network or tunnel errors, debounced to once every 3 seconds.
pub fn heal_client(reason: &str) {
    let connectish = reason.contains("Connect")
        || reason.contains("timed out")
        || reason.contains("refused")
        || reason.contains("dns");
    if !is_proxy_error(reason) && !connectish {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

/// Format reqwest error chain including nested error sources.
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    redact_error_proxy_auth(&out)
}

/// Transport source chains are not guaranteed to redact proxy userinfo. Remove
/// userinfo from embedded URLs while keeping hosts and useful failure details.
fn redact_error_proxy_auth(message: &str) -> String {
    let mut output = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(separator) = rest.find("://") {
        let authority_start = separator + 3;
        output.push_str(&rest[..authority_start]);
        rest = &rest[authority_start..];
        let authority_end = rest.find(|ch: char| ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '\'' | '"' | '<' | '>'))
            .unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if let Some(at) = authority.rfind('@') {
            output.push_str("[redacted]@");
            output.push_str(&authority[at + 1..]);
        } else {
            output.push_str(authority);
        }
        rest = &rest[authority_end..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// Classify IPv4 address kind (loopback, private, fake_ip, or public).
fn ipv4_kind(o: [u8; 4]) -> &'static str {
    let v4 = std::net::Ipv4Addr::from(o);
    if v4.is_loopback() {
        "loopback"
    } else if o == [0, 0, 0, 0] {
        "unspecified"
    } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        // Clash / Surge TUN fake-ip: synthesized 198.18.0.0/15 address pool.
        "fake_ip"
    } else if v4.is_private() {
        "private"
    } else if v4.is_link_local() {
        "link_local"
    } else if v4.is_broadcast() {
        "broadcast"
    } else {
        "public"
    }
}

fn ip_kind(ip: std::net::IpAddr) -> &'static str {
    match ip {
        std::net::IpAddr::V4(v4) => ipv4_kind(v4.octets()),
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback() {
                "loopback"
            } else if v6.is_unspecified() {
                "unspecified"
            } else if let Some(v4) = v6.to_ipv4_mapped() {
                ipv4_kind(v4.octets())
            } else {
                "public"
            }
        }
    }
}

/// Generate DNS report classifying address kinds and detecting fake-ip pools.
fn dns_report(addrs: &[SocketAddr], ms: u128) -> Value {
    let mut ips: Vec<std::net::IpAddr> = addrs.iter().map(|a| a.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let mut kinds: Vec<&str> = ips.iter().map(|ip| ip_kind(*ip)).collect();
    kinds.sort_unstable();
    kinds.dedup();
    let suspicious: Vec<String> = ips
        .iter()
        .filter(|ip| ip_kind(**ip) != "public")
        .map(|ip| ip.to_string())
        .collect();
    json!({
        "ms": ms as u64,
        "count": ips.len(),
        "has_fake_ip": kinds.contains(&"fake_ip"),
        "kinds": kinds,
        "suspicious": suspicious,
    })
}

/// Direct TCP socket probe bypassing proxy routing.
async fn tcp_probe(addr: Option<SocketAddr>, timeout: Duration) -> Value {
    let Some(addr) = addr else {
        return json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "skipped": true,
            "reason": "",
        });
    };
    let started = Instant::now();
    let family = if addr.is_ipv4() { "IPv4" } else { "IPv6" };
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(_)) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": true,
            "ms": started.elapsed().as_millis() as u64,
        }),
        Ok(Err(e)) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": false,
            "ms": started.elapsed().as_millis() as u64,
            "error": e.to_string(),
        }),
        Err(_) => json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": family,
            "addr": addr.to_string(),
            "ok": false,
            "timeout": true,
            "ms": timeout.as_millis() as u64,
            "error": "Connection timed out (SYN no response)",
        }),
    }
}

/// Synthesize diagnostic verdict comparing DNS, TCP, and HTTP probe results.
fn verdict(dns: &Value, tcp: &Value, http: &Value) -> (&'static str, String, Vec<String>) {
    let dns_err = dns.get("error").and_then(|v| v.as_str());
    let fake = dns.get("has_fake_ip").and_then(|v| v.as_bool()).unwrap_or(false);
    let kinds = dns.get("kinds").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let suspicious = dns.get("suspicious").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let status = http.get("status").and_then(|v| v.as_u64());
    let http_err = http.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let tcp_ok = tcp.get("ok").and_then(|v| v.as_bool());
    let proxy_configured = http
        .get("proxy_configured")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    if let Some(code @ 200..=399) = status {
        let direct_note = if tcp_ok == Some(false) {
            " · direct TCP probe failed"
        } else {
            ""
        };
        if dns_err.is_some() {
            return (
                "dns_false_alarm",
                format!("HTTP request succeeded (HTTP {code}{direct_note})"),
                vec![],
            );
        }
        if fake {
            return (
                "ok_proxy",
                format!("DNS intercepted by VPN/TUN proxy, HTTP succeeded (HTTP {code})"),
                vec![],
            );
        }
        if proxy_configured || tcp_ok == Some(false) {
            return (
                "ok_proxy",
                format!("HTTP request succeeded (HTTP {code}{direct_note})"),
                vec![],
            );
        }
        if kinds.iter().any(|kind| {
            matches!(kind.as_str(), Some("loopback" | "unspecified" | "private"))
        }) {
            return (
                "dns_hijack",
                format!("HTTP request succeeded (HTTP {code}{direct_note})"),
                vec!["Check local DNS, VPN/TUN, and proxy settings".into()],
            );
        }
        return (
            "ok",
            format!("Normal connectivity (HTTP {code}), line operational"),
            vec![],
        );
    }

    // HTTP error status indicates request reached HTTP service
    if let Some(code) = status {
        return (
            "http_status",
            format!("HTTP request received server status code {code}"),
            vec!["Verify account or content permissions; retry later if issue persists".into()],
        );
    }

    // DNS failure without HTTP response
    if let Some(e) = dns_err.filter(|_| http_err.is_empty()) {
        if proxy_configured {
            return (
                "proxy_fail",
                format!("Proxy request failed and local DNS probe also failed: {e}"),
                vec![
                    "Verify local proxy service is running and inspect current proxy node".into(),
                    "Retry with proxy connected or test on alternate network".into(),
                ],
            );
        }
        return (
            "dns_fail",
            format!("Domain resolution failed: {e}"),
            vec![
                "Disable proxy / accelerator / VPN TUN mode and retry".into(),
                "Switch network between Wi-Fi and mobile data to compare".into(),
                "Set Android Private DNS to Automatic, or configure 223.5.5.5 / 1.1.1.1".into(),
            ],
        );
    }
    if fake && http_err.is_empty() {
        return (
            "fake_ip",
            format!(
                "Resolved to fake-ip ({}), DNS traffic routed through proxy/TUN",
                suspicious
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("198.18.x.x")
            ),
            vec![
                "Disable Clash / Surge TUN mode or close proxy application".into(),
                "If proxy is required, ensure node is stable before launching App".into(),
            ],
        );
    }
    if http_err.is_empty()
        && kinds
        .iter()
        .any(|k| matches!(k.as_str(), Some("loopback" | "unspecified" | "private")))
    {
        return (
            "dns_hijack",
            "Resolution points to loopback / private / reserved address, DNS hijacked or poisoned".into(),
            vec![
                "Change DNS (223.5.5.5, 1.1.1.1) and restart App".into(),
                "Disable system network acceleration features".into(),
            ],
        );
    }
    if !http_err.is_empty() {
        let lower = http_err.to_lowercase();
        if proxy_configured {
            let direct_note = if tcp_ok == Some(false) {
                "; direct TCP probe also failed, but it bypassed application HTTP proxy"
            } else {
                ""
            };
            return (
                "proxy_fail",
                format!("HTTP request via configured proxy failed: {http_err}{direct_note}"),
                vec![
                    "Verify local proxy service is running and inspect current proxy node".into(),
                    "Disable proxy HTTPS decryption or switch proxy node".into(),
                ],
            );
        }
        let certificate = lower.contains("certificate");
        let handshake = lower.contains("tls")
            || lower.contains("ssl")
            || lower.contains("handshake");
        return (
            if certificate {
                "tls_intercept"
            } else if handshake {
                "tls_fail"
            } else {
                "http_fail"
            },
            if certificate {
                format!("TLS certificate verification failed: {http_err}")
            } else if handshake {
                format!("HTTP TLS handshake failed: {http_err}")
            } else if tcp_ok == Some(false) {
                format!("HTTP request failed: {http_err}; direct TCP probe also failed")
            } else {
                format!("HTTP request failed: {http_err}")
            },
            if certificate {
                vec![
                    "Check proxy HTTPS decryption settings and system time".into(),
                    "Test with another network or proxy node".into(),
                ]
            } else if handshake {
                vec![
                    "Confirm system proxy or VPN/TUN is operational, or switch proxy node".into(),
                    "Retry on another network to isolate server, proxy, or transit issues".into(),
                ]
            } else if tcp_ok == Some(false) {
                vec![
                    "Check router, VPN/TUN, and firewall settings".into(),
                    "Do not assume ISP blocking solely based on direct TCP timeout".into(),
                ]
            } else {
                vec!["Retry later or inspect current network and proxy settings".into()]
            },
        );
    }
    if tcp_ok == Some(false) {
        let timeout = tcp.get("timeout").and_then(|v| v.as_bool()).unwrap_or(false);
        return (
            if timeout { "tcp_timeout" } else { "tcp_refused" },
            if timeout {
                "DNS operational, but direct TCP socket probe timed out".to_string()
            } else {
                format!(
                    "DNS operational, but direct TCP socket probe failed: {}",
                    tcp.get("error").and_then(|v| v.as_str()).unwrap_or("unknown")
                )
            },
            vec![
                "Check default route, VPN/TUN, and firewall settings".into(),
                "Compare networks; TCP probe bypasses application HTTP proxy".into(),
            ],
        );
    }
    ("unknown", "Insufficient diagnostic data: HTTP and TCP probes inconclusive".into(), vec![])
}

/// Editable URL is returned only to the settings form; effective is always redacted.
pub fn proxy_state() -> Value {
    let config = crate::proxy::snapshot();
    let target = url::Url::parse(&base()).expect("validated base");
    let route = ProxyRoute::for_config(&config, &target);
    let effective = if !route.active {
        None
    } else if let Some(explicit) = &route.explicit {
        Some(redact_proxy(explicit))
    } else {
        ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
            .iter().find_map(|key| std::env::var(key).ok().filter(|value| !value.trim().is_empty()))
            .map(|value| redact_proxy(&value))
            .or_else(|| Some("system".to_owned()))
    };
    json!({
        "mode": config.mode.as_str(), "url": config.url, "effective": effective,
        "system_proxy": system_proxy_enabled(), "env_proxy": env_proxy_set(),
    })
}

fn healthy_proxy_response(status: u16, body: &[u8]) -> bool {
    if status != 200 { return false; }
    serde_json::from_slice::<Value>(body).is_ok_and(|value| {
        value.get("status").and_then(Value::as_i64) == Some(1)
            && value.get("data").is_some_and(crate::lines::healthy_video_data)
    })
}

/// Probe the same anonymous edge envelope as line health, using an unsaved route.
/// A draft never mutates app settings or cached clients. Bound the whole request,
/// including DNS, redirects and body, and do not echo untrusted response text.
pub async fn test_proxy(mode: &str, url: &str) -> Value {
    let config = match crate::proxy::Config::for_test(mode, url) {
        Ok(config) => config,
        Err(error) => return json!({"ok": false, "ms": 0, "error": error}),
    };
    let origin = base();
    let started = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(8),
        probe_proxy_origin(&origin, &config, network_policy::strict_security())).await;
    let mut value = match result {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => json!({"ok": false, "error": error}),
        Err(_) => json!({"ok": false, "error": "Proxy connectivity test timed out (8s)"}),
    };
    value["ms"] = json!(started.elapsed().as_millis() as u64);
    value
}

async fn probe_proxy_origin(origin: &str, config: &crate::proxy::Config, strict: bool) -> Result<Value, String> {
    let mut next = network_policy::parse_target_with_mode(&format!("{origin}/api/edge/request"), strict)?;
    let envelope = json!({ "method": "GET", "path": "/api/videos?page=1&size=1", "body": "", "content_type": "" });
    for hop in 0..=5 {
        let route = ProxyRoute::for_config(config, &next);
        let addresses = if strict && !route.active { network_policy::resolve_target(&next, strict).await? } else { Vec::new() };
        let client = build_client(next.host_str().ok_or("Target missing hostname")?, &addresses, &route)?;
        let response = client.post(next.clone())
            .header("Accept", "application/json")
            .header("Referer", format!("{origin}/"))
            .json(&envelope).send().await.map_err(proxy_probe_error)?;
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            if hop == 5 { return Err("Too many redirects".into()) }
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).ok_or("Redirect missing valid Location")?;
            next = edge_redirect_target(&next, status, location, true)?;
            continue;
        }
        if status != 200 {
            return Ok(json!({"ok": false, "status": status, "via": route.label(), "error": ""}));
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(proxy_probe_error)? {
            if body.len() + chunk.len() > 1024 * 1024 { return Err("Video API response exceeds test size limit".into()) }
            body.extend_from_slice(&chunk);
        }
        let ok = healthy_proxy_response(status, &body);
        return Ok(if ok {
            json!({"ok": true, "status": status, "via": route.label()})
        } else {
            json!({"ok": false, "status": status, "via": route.label(), "error": "API did not return valid video list data"})
        });
    }
    Err("Too many redirects".into())
}

fn proxy_probe_error(error: reqwest::Error) -> String {
    // reqwest's nested transport errors can contain the configured proxy URL.
    // Report the useful category without copying a credential-bearing address.
    if error.is_timeout() { "Proxy connectivity test timed out" }
    else if error.is_connect() { "Proxy or target connection failed; check address, credentials, and network" }
    else if error.is_body() || error.is_decode() { "Failed to read video API response" }
    else { "Proxy connectivity test request failed" }.into()
}

/// Multi-layer network diagnosis across DNS, direct TCP socket, and HTTP client.
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // DNS probe using tokio lookup_host.
    let dns_started = Instant::now();
    let mut first_addr: Option<SocketAddr> = None;
    let dns = if host.is_empty() {
        json!({ "error": "Current line missing hostname" })
    } else {
        match tokio::time::timeout(
            Duration::from_secs(6),
            tokio::net::lookup_host((host.as_str(), 443u16)),
        )
        .await
        {
            Ok(Ok(iter)) => {
                let addrs: Vec<SocketAddr> = iter.collect();
                let ms = dns_started.elapsed().as_millis();
                first_addr = addrs.first().copied();
                dns_report(&addrs, ms)
            }
            Ok(Err(e)) => json!({
                "error": "DNS resolution failed",
                "detail": e.to_string(),
                "ms": dns_started.elapsed().as_millis() as u64,
            }),
            Err(_) => json!({
                "error": "DNS resolution timed out",
                "timeout": true,
                "ms": 6000,
            }),
        }
    };

    // Direct TCP probe bypasses application HTTP proxy
    let tcp = tcp_probe(first_addr, Duration::from_secs(5)).await;

    let started = Instant::now();
    let proxy_configured = url::Url::parse(&cur)
        .ok()
        .is_some_and(|target| proxy_active(&target));
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "proxy_configured": proxy_configured,
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "kind": crate::playback_log::error_kind(&e),
            "error": e,
            "proxy_configured": proxy_configured,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    let (code, summary, advice) = verdict(&dns, &tcp, &http);

    json!({
        "verdict": code,
        "summary": summary,
        "advice": advice,
        "base": cur,
        "host": host,
        "dns": dns,
        "tcp": tcp,
        "http": http,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[configured, list hidden]"),
            "AURASTREAM_PROXY": proxy_override().map(|p| redact_proxy(&p)),
            "GNOME_PROXY": gnome_proxy().map(|p| redact_proxy(&p)),
            "system_proxy": system_proxy_enabled(),
            "app_proxy_mode": crate::proxy::mode().as_str(),
            "app_proxy": crate::proxy::custom_url().as_deref().map(redact_proxy),
        },
        "runtime": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "ver": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

/// Retry recoverable network errors.
/// Retry recoverable network errors, healing client connections between retries.
async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

// Record operation type without query parameters or credentials
fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && path.ends_with("/play") {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/// Gateway migration for bodyless GET envelopes.
fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301..=303) {
        return Err("API request redirect rejected".into());
    }
    network_policy::redirect_target(current, location)
}

/// API request via edge envelope.
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("API requests must use a secure HTTPS line")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
        && (cur != base() || crate::lines::verify_published_origin(&cur).await.is_err()) {
            return Err("Mirror lines are for guest browsing only; please switch to a fixed line or reload publisher page to sign in/register".into());
        }
    let (encoded, ctype) = match &body {
        Some(v) => (
            B64.encode(serde_json::to_vec(v).map_err(|e| e.to_string())?),
            "application/json",
        ),
        None => (String::new(), ""),
    };
    let envelope = json!({
        "method": method,
        "path": path,
        "body": encoded,
        "content_type": ctype,
    });

    let url = format!("{cur}/api/edge/request");
    let referer = format!("{cur}/");
    let token = token.map(|s| s.to_string());

    static NEXT_EDGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_EDGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let line_host = url::Url::parse(&cur)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    let operation = edge_operation(path);
    let mut attempt = 0;
    let guest_get = method.eq_ignore_ascii_case("GET") && body.is_none() && token.is_none();
    let can_retry = method.eq_ignore_ascii_case("GET") && body.is_none();
    let value = with_retry(can_retry, || {
        attempt += 1;
        let attempt = attempt;
        let envelope = envelope.clone();
        let token = token.clone();
        let url = url.clone();
        let referer = referer.clone();
        let line_host = line_host.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("api.begin", json!({"request": request, "attempt": attempt, "operation": operation, "method": method, "line_host": line_host}));
            let mut status_code = None;
            let mut headers_ms = None;
            let mut target_host = line_host.clone();
            let mut response_kind = "unknown";
            let mut gateway = "other";
            let result = async {
                let mut next = network_policy::parse_target(&url)?;
                for hop in 0..=5 {
                    let (target, client) = client_for(next.as_str()).await?;
                    target_host = target.host_str().unwrap_or("").to_string();
                    let mut req = client
                        .post(target.clone())
                        .header("Accept", "application/json")
                        .header("Referer", &referer)
                        .json(&envelope);
                    if let Some(t) = token.as_deref() {
                        if !t.is_empty() {
                            req = req.header("Authorization", format!("Bearer {t}"));
                        }
                    }
                    let resp = req.send().await.map_err(|e| err_text(&e))?;
                    let status = resp.status();
                    status_code = Some(status.as_u16());
                    headers_ms = Some(started.elapsed().as_millis() as u64);
                    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
                    response_kind = if ctype.contains("json") { "json" } else if ctype.contains("html") { "html" } else { "other" };
                    gateway = if resp.headers().contains_key("x-amz-cf-id") { "cloudfront" } else if resp.headers().contains_key("cf-ray") { "cloudflare" } else { "other" };
                    // Rebuild and verify client hop by hop
                    if status.is_redirection() {
                        if hop == 5 {
                            return Err("Too many redirects".into());
                        }
                        let location = resp
                            .headers()
                            .get(reqwest::header::LOCATION)
                            .and_then(|h| h.to_str().ok())
                            .ok_or("Redirect missing valid Location")?;
                        next = edge_redirect_target(&target, status.as_u16(), location, guest_get)?;
                        continue;
                    }
                    let text = resp.text().await.map_err(|e| err_text(&e))?;
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err("401".to_string());
                    }
                    if !status.is_success() {
                        return Err(format!(
                            "HTTP {status}: {}",
                            text.chars().take(160).collect::<String>()
                        ));
                    }
                    if text.trim().is_empty() {
                        return Ok(Value::Null);
                    }
                    return serde_json::from_str::<Value>(&text)
                        .map_err(|e| format!("{e}: {}", text.chars().take(160).collect::<String>()));
                }
                Err("Too many redirects".into())
            }.await;
            crate::playback_log::record("api.end", json!({
                "request": request, "attempt": attempt, "operation": operation, "method": method,
                "line_host": line_host, "target_host": target_host, "status": status_code,
                "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64,
                "response_kind": response_kind, "gateway": gateway,
                "business_status": result.as_ref().ok().and_then(|v: &Value| v.get("status")).and_then(Value::as_i64),
                "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e)),
                "retryable": can_retry && result.as_ref().err().is_some_and(|e| retryable_error(e)),
            }));
            result
        }
    })
    .await?;

    if value.is_null() {
        return Ok(Value::Null);
    }

    if value.get("status").and_then(|v| v.as_i64()) == Some(1) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(value
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("API returned failure")
            .to_string())
    }
}

/// Fetch raw bytes for images, playlists, and segments.
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let target = url::Url::parse(&url).ok();
    let host = target.as_ref().and_then(|target| target.host_str()).unwrap_or("").to_string();
    let public_dns = AtomicBool::new(MEDIA_DNS_ROUTES.lock().ok()
        .is_some_and(|routes| routes.prefers_public(&host, Instant::now())));
    let referer = format!("{}/", base());
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer.clone();
        let host = &host;
        let target = &target;
        let public_dns = &public_dns;
        async move {
            let using_public_dns = public_dns.load(Ordering::Relaxed);
            let started = Instant::now();
            crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let resp = get_with_dns(&url, Duration::from_secs(20), None, Some(&referer), using_public_dns).await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
                Ok((ctype, bytes))
            }.await;
            if using_public_dns {
                if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
                    if result.is_ok() {
                        routes.remember(host, Instant::now());
                    } else {
                        routes.forget(host);
                    }
                }
            }
            if let Err(error) = &result {
                if target.as_ref().is_some_and(|target| crate::media_dns::eligible(target, error)) {
                    public_dns.store(!using_public_dns, Ordering::Relaxed);
                    crate::playback_log::record("network.dns_fallback", json!({"resource": resource, "attempt": attempt, "public_dns": !using_public_dns, "error_kind": crate::playback_log::error_kind(error)}));
                }
            }
            crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "public_dns": using_public_dns, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
            result
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_errors_redact_proxy_auth_without_hiding_failure_category() {
        let raw = "error sending request for url (https://example.com/) ← proxy http://demo:secret@[::1]:7897 refused; socks5h://name:token@proxy.example:1080/path";
        let safe = redact_error_proxy_auth(raw);
        assert!(!safe.contains("demo") && !safe.contains("secret") && !safe.contains("name:token"));
        assert!(safe.contains("https://example.com/") && safe.contains("[::1]:7897 refused"));
        assert!(safe.contains("socks5h://[redacted]@proxy.example:1080/path"));
        assert_eq!(redact_error_proxy_auth("tls handshake eof"), "tls handshake eof");
    }

    #[test]
    fn proxy_probe_checks_feed_envelope_instead_of_http_status_only() {
        let valid = json!({"status": 1, "data": {"items": [{"id": 1, "title": "fixture"}], "pagination": {"page": 1, "size": 1, "pages": 1, "total": 1}}});
        assert!(healthy_proxy_response(200, valid.to_string().as_bytes()));
        assert!(!healthy_proxy_response(403, valid.to_string().as_bytes()));
        for body in [b"<html>homepage</html>".as_slice(), br#"{"status":0,"data":{}}"#, br#"{"status":1,"data":[]}"#, br#"{"status":1,"data":{"items":[],"pagination":{}}}"#] {
            assert!(!healthy_proxy_response(200, body));
        }
    }

    #[test]
    fn proxy_cache_identity_changes_with_mode_and_address_without_exposing_secrets() {
        let target = url::Url::parse("https://example.com/").unwrap();
        let custom = crate::proxy::Config::for_test("custom", "http://name:{{PASSWORD_pp0rajep}}@127.0.0.1:7897").unwrap();
        let route = ProxyRoute::for_config(&custom, &target);
        let first = client_key(true, "example.com", 443, false, &route);
        assert!(!first.contains("{{PASSWORD_pp0rajep}}"));
        assert_eq!(route.label(), "http://127.0.0.1:7897");
        for config in [crate::proxy::Config::for_test("off", "").unwrap(), crate::proxy::Config::for_test("custom", "http://127.0.0.1:7898").unwrap()] {
            let changed = ProxyRoute::for_config(&config, &target);
            assert_ne!(first, client_key(true, "example.com", 443, false, &changed));
        }
        assert!(!ProxyRoute::for_config(&crate::proxy::Config::for_test("off", "").unwrap(), &target).active);
    }

    #[tokio::test]
    async fn proxy_probe_uses_post_envelope_and_does_not_save_draft() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let serving = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new(); reader.read_line(&mut request).unwrap();
            let mut length = 0; let mut auth = false;
            loop {
                let mut line = String::new(); reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() { break; }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().unwrap(); }
                if line.to_ascii_lowercase().starts_with("authorization:") { auth = true; }
            }
            let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
            let data = json!({"status":1,"data":{"items":[],"pagination":{"page":1,"size":1,"pages":0,"total":0}}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap();
            (request, serde_json::from_slice::<Value>(&body).unwrap(), auth)
        });
        let before = crate::proxy::snapshot();
        let config = crate::proxy::Config::for_test("custom", &format!("http://{address}")).unwrap();
        // Host has no DNS record; only the explicitly supplied HTTP proxy can answer.
        let result = probe_proxy_origin("http://unresolved.fixture.invalid", &config, false).await.unwrap();
        assert_eq!(result["ok"], true);
        let (request, body, auth) = serving.join().unwrap();
        assert!(request.starts_with("POST http://unresolved.fixture.invalid/api/edge/request HTTP/1.1"));
        assert_eq!(body, json!({"method":"GET","path":"/api/videos?page=1&size=1","body":"","content_type":""}));
        assert!(!auth);
        assert!(crate::proxy::snapshot() == before);
    }

    #[tokio::test]
    #[ignore = "Live network test; requires TEST_MEDIA_URL"]
    async fn media_recovers_from_failed_system_dns() {
        let raw = crate::env::var("TEST_MEDIA_URL").expect("AURASTREAM_TEST_MEDIA_URL");
        let target = url::Url::parse(&raw).unwrap();
        let host = target.host_str().unwrap();
        let port = target.port_or_known_default().unwrap();
        let failed_client = reqwest::Client::builder()
            .no_proxy()
            .resolve_to_addrs(host, &["127.0.0.1:9".parse().unwrap()])
            .connect_timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        refresh_client();
        CLIENTS.lock().unwrap().insert(
            client_key(network_policy::strict_security(), host, port, false, &ProxyRoute::for_config(&crate::proxy::snapshot(), &target)),
            (Instant::now() + CLIENT_TTL, Arc::new(failed_client)),
        );
        let (_, bytes) = fetch_bytes(&raw).await.expect("Fallback DNS should recover media download");
        assert!(!bytes.is_empty());
        assert!(MEDIA_DNS_ROUTES.lock().unwrap().prefers_public(host, Instant::now()));
        let (_, again) = fetch_bytes(&raw).await.expect("Subsequent requests should reuse recovered route");
        if bytes.starts_with(b"#EXTM3U") {
            assert!(again.starts_with(b"#EXTM3U"));
        } else {
            assert_eq!(bytes, again);
        }
        if let Some(path) = crate::env::var("TEST_MEDIA_OUTPUT") {
            std::fs::write(path, bytes).unwrap();
        }
    }

    #[tokio::test]
    async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for error in [
            "HTTP 404 Not Found: <html>nginx</html>",
            "HTTP 403 Forbidden",
            "401",
            "Private network access denied",
            "Too many redirects",
        ] {
            let calls = AtomicUsize::new(0);
            assert!(with_retry(true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error.to_string())
            })
            .await
            .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
        }
        for error in ["HTTP 503 Service Unavailable", "Request timed out"] {
            let calls = AtomicUsize::new(0);
            let value = with_retry(true, || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(error.to_string())
                    } else {
                        Ok(42)
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn api_operation_labels_exclude_user_input() {
        for (path, expected) in [
            ("/api/videos?page=1&size=10", "feed"),
            ("/api/videos/category/private?x=secret", "category"),
            ("/api/videos/42/play?ep=1", "play"),
            ("/api/search?q=private-search", "search"),
            ("/api/account/loginByPassword", "account"),
            ("/unknown/private", "other"),
        ] {
            assert_eq!(edge_operation(path), expected);
        }
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn diagnostic_http_success_overrides_a_failed_direct_tcp_probe() {
        let dns = json!({
            "count": 2,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": "IPv6",
            "ok": false,
            "timeout": true,
            "error": "Connection timed out (SYN no response)",
        });
        let http = json!({ "status": 200, "proxy_configured": true });

        let (code, summary, advice) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "ok_proxy");
        assert!(summary.contains("HTTP 200"));
        assert!(summary.contains("direct TCP probe failed"));
        assert!(advice.is_empty());
    }

    #[test]
    fn diagnostic_proxy_handshake_failure_does_not_blame_the_direct_route() {
        let dns = json!({
            "count": 2,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({
            "mode": "direct_socket",
            "proxy_bypassed": true,
            "family": "IPv6",
            "ok": false,
            "timeout": true,
            "error": "Connection timed out (SYN no response)",
        });
        let http = json!({
            "proxy_configured": true,
            "kind": "transport_error",
            "error": "error sending request ← tls handshake eof",
        });

        let (code, summary, advice) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "proxy_fail");
        assert!(summary.contains("HTTP request via configured proxy failed"));
        assert!(summary.contains("bypassed application HTTP proxy"));
        assert!(!summary.contains("ISP"));
        assert!(advice.iter().any(|item| item.contains("proxy node")));
    }

    #[test]
    fn direct_tcp_failure_alone_is_not_reported_as_operator_blocking() {
        let dns = json!({
            "count": 1,
            "has_fake_ip": false,
            "kinds": ["public"],
        });
        let tcp = json!({ "ok": false, "timeout": true });
        let http = json!({
            "proxy_configured": false,
            "kind": "transport_error",
            "error": "connection timeout",
        });

        let (code, summary, _) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "http_fail");
        assert!(summary.contains("direct TCP probe also failed"));
        assert!(!summary.contains("ISP"));
    }

    #[test]
    fn diagnostic_http_error_status_is_not_overridden_by_direct_tcp_failure() {
        let dns = json!({ "count": 1, "has_fake_ip": false, "kinds": ["public"] });
        let tcp = json!({ "ok": false, "timeout": true });
        let http = json!({ "status": 503, "proxy_configured": true });

        let (code, summary, _) = verdict(&dns, &tcp, &http);
        assert_eq!(code, "http_status");
        assert!(summary.contains("503"));
    }

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let client = Arc::new(reqwest::Client::new());
        let mut cache = ClientCache::new();
        cache.insert(
            "true:example.com:443".into(),
            (now + CLIENT_TTL, client.clone()),
        );
        assert!(Arc::ptr_eq(
            &cached_client(
                &cache,
                "true:example.com:443",
                now + Duration::from_secs(29)
            )
            .unwrap(),
            &client
        ));
        assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
        assert!(cached_client(&cache, "false:example.com:443", now).is_none());
        assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
    }

    #[test]
    fn edge_redirects_only_replay_anonymous_reads() {
        let current = url::Url::parse("https://huangguoai.ai/api/edge/request").unwrap();
        assert_eq!(
            edge_redirect_target(
                &current,
                301,
                "https://huangguoai.com/api/edge/request",
                true
            )
            .unwrap()
            .host_str(),
            Some("huangguoai.com")
        );
        assert!(edge_redirect_target(&current, 302, "/next", true).is_ok());
        for status in [301, 302, 303, 307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", false).is_err());
        }
        for status in [307, 308] {
            assert!(edge_redirect_target(&current, status, "/next", true).is_err());
        }
        assert!(edge_redirect_target(&current, 301, "http://example.com/", true).is_err());
        assert!(edge_redirect_target(&current, 301, "https://127.0.0.1/", true).is_err());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[configured, raw value hidden]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[test]
    fn saved_line_is_restored_without_granting_credential_trust() {
        assert_eq!(
            persisted_base(r#"{"base":"https://legacy-mirror.invalid/"}"#),
            Some("https://legacy-mirror.invalid".into())
        );
        assert!(!trusted_auth_origin("https://legacy-mirror.invalid"));
        assert_eq!(persisted_base(r#"{"base":"https://huangguoai.com/"}"#), Some(DEFAULT_BASE.into()));
        for raw in [
            "invalid",
            r#"{"base":123}"#,
            r#"{"base":"http://example.com"}"#,
            r#"{"base":"https://localhost"}"#,
            r#"{"base":"https://192.168.1.1"}"#,
            r#"{"base":"https://example.com/path"}"#,
        ] {
            assert_eq!(persisted_base(raw), None, "{raw}");
        }
    }

    #[test]
    fn custom_line_consent_only_survives_explicit_v2_configuration() {
        for raw in [
            r#"{"base":"https://mirror.fixture.invalid","custom":true}"#,
            r#"{"v":1,"base":"https://mirror.fixture.invalid","custom":true}"#,
            r#"{"v":2,"base":"https://mirror.fixture.invalid"}"#,
            r#"{"v":2,"base":"https://mirror.fixture.invalid","custom":false}"#,
        ] {
            let config = persisted_line(raw).unwrap();
            assert_eq!(config.base, "https://mirror.fixture.invalid");
            assert!(!config.custom);
        }
        assert!(persisted_line(r#"{"v":2,"base":"https://mirror.fixture.invalid/","custom":true}"#).unwrap().custom);
        assert!(!persisted_line(r#"{"v":2,"base":"https://huangguoai.com","custom":true}"#).unwrap().custom);
    }

    #[test]
    fn custom_line_round_trip_and_failed_save_preserve_previous_selection() {
        let dir = std::env::temp_dir().join(format!("aurastream-line-save-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("line.json");
        let next = LineConfig { base: "https://mirror.fixture.invalid".into(), custom: true };
        let mut current = LineConfig::default();
        save_line(&mut current, next.clone(), Some(&path)).unwrap();
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next.clone()));
        let failed_path = dir.join("missing").join("line.json");
        assert!(save_line(&mut current, LineConfig::default(), Some(&failed_path)).is_err());
        assert_eq!(current, next);
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(next));
        save_line(&mut current, LineConfig::default(), Some(&path)).unwrap();
        assert_eq!(persisted_line(&std::fs::read_to_string(&path).unwrap()), Some(LineConfig::default()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(err.contains("Mirror lines are for guest browsing only"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("forbidden") || err.contains("denied"));
    }

    /// Diagnostic test: run with cargo test --lib -- --ignored net::tests::diag -- --nocapture
    #[tokio::test]
    #[ignore = "Live network test: network diagnostics"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }
}
