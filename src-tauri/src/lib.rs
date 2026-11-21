mod api;
#[cfg(any(target_os = "macos", target_os = "ios", test))]
mod apple_proxy;
mod downloader;
mod env;
#[cfg(target_os = "ios")]
mod ios_layout;
mod lines;
#[cfg(target_os = "linux")]
mod linux_http;
#[cfg(target_os = "linux")]
mod linux_webview;
mod logging;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod media;
mod media_dns;
mod net;
mod network_policy;
mod playback_log;
mod proxy;
mod search_hot;
mod session;

use api::Api;
use tauri::Manager;

fn allowed_dev_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }
    if let Some(configured) = option_env!("TAURI_DEV_HOST") {
        if host.eq_ignore_ascii_case(configured.trim()) {
            return true;
        }
    }
    std::env::var("TAURI_DEV_HOST")
        .ok()
        .is_some_and(|v| host.eq_ignore_ascii_case(v.trim()))
}

fn allowed_frontend_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost"
            | "https://localhost"
            | "http://127.0.0.1"
            | "https://127.0.0.1"
    ) || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("http://localhost:")
    {
        return true;
    }
    // Mobile dev may use TAURI_DEV_HOST; strict security only allows local or configured host
    cfg!(debug_assertions)
        && url::Url::parse(origin).is_ok_and(|u| {
            u.scheme() == "http"
                && u.port() == Some(1420)
                && (!network_policy::strict_security()
                    || u.host_str().is_some_and(allowed_dev_host))
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Api::new())
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "ios")]
            {
                let finished = payload.event() == tauri::webview::PageLoadEvent::Finished;
                ios_layout::apply(webview, finished);
                if finished {
                    // Disable WKWebView text loupe by default during video scrubbing
                    ios_layout::set_text_interaction_on_webview(webview, false);
                    let wv = (*webview).clone();
                    tauri::async_runtime::spawn(async move {
                        for delay_ms in [80_u64, 350] {
                            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                            ios_layout::apply(&wv, true);
                        }
                    });
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (webview, payload);
        })
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                // Restore line and diagnostic bindings on startup
                net::bind_base(&dir);
                playback_log::bind(&dir);
                downloader::bind(app.handle().clone(), dir.clone());
                let state: tauri::State<Api> = app.state();
                state.session.bind(dir);
            }
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                downloader::bind_cache(cache_dir);
            }
            // Loopback proxy for Linux media playback via GStreamer
            #[cfg(target_os = "linux")]
            linux_http::start();
            // Centered main window creation on macOS
            #[cfg(target_os = "macos")]
            macos_titlebar::create_main_window(app)?;
            Ok(())
        })
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-guard")
                .on_webview_ready(|webview| {
                    #[cfg(target_os = "linux")]
                    linux_webview::configure(&webview);
                    #[cfg(not(target_os = "linux"))]
                    let _ = webview;
                })
                .on_navigation(|_webview, url| {
                    let host = url.host_str().unwrap_or("");
                    (url.scheme() == "tauri" && host == "localhost")
                        // Allow in-process custom media scheme navigation
                        || (matches!(url.scheme(), "http" | "https") && host.ends_with(".localhost"))
                        || allowed_frontend_origin(&url.origin().ascii_serialization())
                        || (!network_policy::strict_security()
                            && matches!(url.scheme(), "http" | "https"))
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("hg", |_app, request, responder| {
            let request_origin = request
                .headers()
                .get("Origin")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);

            // Handle CORS preflight OPTIONS request
            if request.method() == tauri::http::Method::OPTIONS {
                let mut resp = tauri::http::Response::builder()
                    .status(204)
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*")
                    .header("Access-Control-Max-Age", "86400")
                    .body(Vec::new())
                    .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()));
                if let Some(origin) = request_origin.as_deref().and_then(|s| tauri::http::HeaderValue::from_str(s).ok()) {
                    resp.headers_mut().insert("Access-Control-Allow-Origin", origin);
                    resp.headers_mut().insert("Vary", tauri::http::HeaderValue::from_static("Origin"));
                } else {
                    resp.headers_mut().insert("Access-Control-Allow-Origin", tauri::http::HeaderValue::from_static("*"));
                }
                responder.respond(resp);
                return;
            }

            if playback_log::enabled() {
                let resource = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                    .find(|(key, _)| key == "u")
                    .map(|(_, value)| playback_log::resource_id(&value));
                let route = match request.uri().path() { "/hls" => "playlist", "/seg" => "segment_or_key", "/img" => "image", _ => "unknown" };
                let range = request.headers().get("Range").and_then(|v| v.to_str().ok())
                    .filter(|v| v.len() <= 100 && v.bytes().all(|b| b.is_ascii_digit() || b"bytes=,- ".contains(&b)));
                let origin_kind = match request_origin.as_deref() { None => "missing", Some("null") => "null", Some(origin) if allowed_frontend_origin(origin) => "app", _ => "other" };
                playback_log::record("protocol.request", serde_json::json!({"resource": resource, "route": route, "method": request.method().as_str(), "range": range, "origin_kind": origin_kind}));
            }
            // Allow loopback media requests with missing/null Origin from Android WebViews
            let origin_ok = match request_origin.as_deref() {
                None | Some("") | Some("null") => true,
                Some(origin) => allowed_frontend_origin(origin),
            };
            if network_policy::strict_security() && !origin_ok {
                playback_log::record("security.origin_denied", serde_json::json!({"origin_null": request_origin.as_deref() == Some("null")}));
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(b"origin denied".to_vec())
                        .unwrap_or_else(|_| tauri::http::Response::new(b"origin denied".to_vec())),
                );
                return;
            }
            let uri = request.uri().clone();
            let path = uri.path().to_string();
            let query = uri.query().unwrap_or("").to_string();
            let is_head = request.method() == tauri::http::Method::HEAD;
            // Handle single-range GET request for iOS native player
            let range = if request.method() == tauri::http::Method::GET
                && !request.headers().contains_key("If-Range")
                && request.headers().get_all("Range").iter().count() == 1
            {
                request.headers().get("Range").and_then(|v| v.to_str().ok()).map(str::to_owned)
            } else {
                None
            };
            // Platform-specific local origin defined in media::LOCAL_ORIGIN
            tauri::async_runtime::spawn(async move {
                let mut resp = media::handle_with_method(&path, &query, media::LOCAL_ORIGIN, range.as_deref(), is_head).await;
                if let Some(origin) =
                    request_origin.and_then(|s| tauri::http::HeaderValue::from_str(&s).ok())
                {
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", origin);
                    resp.headers_mut()
                        .insert("Vary", tauri::http::HeaderValue::from_static("Origin"));
                } else {
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", tauri::http::HeaderValue::from_static("*"));
                }
                responder.respond(resp);
            });
        })
        .invoke_handler(tauri::generate_handler![
            api::app_boot,
            api::app_exit,
            playback_log::playback_log_status,
            playback_log::playback_log_set,
            playback_log::playback_log_write,
            playback_log::playback_log_read,
            api::security_set,
            api::debug_log,
            api::net_diag,
            api::line_state,
            api::line_set,
            api::line_custom_set,
            api::line_reset,
            api::line_cancel,
            api::line_mirrors,
            api::line_probe,
            api::line_auto,
            api::line_try_main,
            api::line_health,
            api::proxy_state,
            api::proxy_set,
            api::proxy_test,
            api::check_update,
            api::open_url,
            api::set_orientation,
            api::set_text_interaction,
            api::api_login,
            api::api_register,
            api::api_logout,
            api::api_me,
            api::api_account_history,
            api::api_account_history_record,
            api::api_account_history_delete,
            api::api_feed,
            api::api_original_videos,
            api::api_topics,
            api::api_topic,
            api::api_tags,
            api::api_tag_videos,
            api::api_category,
            api::api_rank,
            api::api_search,
            api::api_search_hot,
            api::cache_clear,
            api::api_posts,
            api::api_post,
            api::api_post_playback,
            api::api_post_like,
            api::api_post_collect,
            api::api_post_comments,
            api::api_post_categories,
            api::api_post_category,
            api::api_related,
            api::api_following,
            api::api_user,
            api::api_user_stats,
            api::api_user_videos,
            api::api_video,
            api::api_play,
            api::api_comments,
            api::api_comment_send,
            api::api_like,
            api::api_collect,
            api::api_follow,
            downloader::native_download_enqueue,
            downloader::native_download_pause,
            downloader::native_download_pause_all,
            downloader::native_download_resume,
            downloader::native_download_resume_all,
            downloader::native_download_cancel,
            downloader::native_download_cancel_all,
            downloader::native_download_status,
            downloader::native_offline_list,
            downloader::native_offline_delete,
            downloader::native_offline_clear,
            downloader::native_offline_prepare_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
