/**
 * AuraStream Internationalization (i18n) Module
 * English-only interface per design requirements.
 */

export type Language = "en";

export const translations = {
  en: {
    // Navigation
    "nav.home": "Home",
    "nav.search": "Search",
    "nav.category": "Categories",
    "nav.profile": "Profile",

    // Player Controls
    "player.play": "Play",
    "player.pause": "Pause",
    "player.next": "Next",
    "player.next_ep": "Next Ep",
    "player.next_episode": "Up Next",
    "player.play_next": "Play Next",
    "player.prev": "Previous",
    "player.episodes": "Episodes",
    "player.quality": "Quality",
    "player.favorite": "Favorite",
    "player.favorited": "Saved",
    "player.unfavorited": "Removed from Saved",
    "player.liked": "Added to Likes",
    "player.unliked": "Removed from Likes",
    "player.comments": "Comments",
    "player.fullscreen": "Fullscreen",
    "player.share": "Share",
    "player.speed": "Speed",
    "player.mute": "Mute",
    "player.unmute": "Unmute",
    "player.lock": "Lock",
    "player.unlock": "Unlock",
    "player.swipe_ep": "Swipe Ep",
    "player.swipe_ep_on": "Swipe Ep: ON",
    "player.swipe_ep_off": "Swipe Ep: OFF",
    "player.hd": "HD",
    "player.sd": "SD",
    "player.episode_num": "Ep. {num}",
    "player.episode_of": "Ep. {cur}/{total}",
    "player.total_episodes": "{count} Episodes",
    "player.reset_zoom": "Reset {zoom}x",
    "player.fill": "Fill",
    "player.fit": "Fit",
    "player.landscape": "Rotate",
    "player.load_error": "Video temporarily unavailable",
    "player.link_copied": "Share link copied to clipboard",
    "player.continue_watching": "Continue Watching",
    "player.resume": "Resume",
    "player.dismiss_continue": "Dismiss Continue Watching",

    // Profile Page
    "profile.title": "Profile",
    "profile.guest": "Guest User",
    "profile.login_prompt": "Sign in to sync likes, favorites & history",
    "profile.login_btn": "Sign In",
    "profile.my_library": "My Library",
    "profile.local_active": "Local Active",
    "profile.private_device": "Offline Ready · Local",
    "profile.saved": "Saved",
    "profile.sync_btn": "Sync",
    "profile.sync_title": "Optional cloud account sync for comments and multi-device",
    "profile.likes": "Likes",
    "profile.favorites": "Favorites",
    "profile.history": "History",
    "profile.downloads": "Downloads",
    "profile.watch_later": "Watch Later",
    "profile.following": "Following",
    "profile.following_sub": "Updates from creators",
    "profile.my_channel": "My Channel",
    "profile.my_channel_sub": "Uploaded series & profile",
    "profile.no_favs": "No favorites yet",
    "profile.no_favs_sub": "Save dramas while watching to find them here",
    "profile.no_watch_later": "No watch later items",
    "profile.no_watch_later_sub": "Add dramas while browsing to watch them later",
    "profile.no_hist": "No watch history",
    "profile.no_hist_sub": "Start watching to track your episodes",
    "profile.no_downloads": "No downloaded episodes",
    "profile.no_downloads_sub": "Download episodes while online to watch offline anytime without data",
    "profile.phone_storage": "Phone Storage",
    "profile.app_offline": "AuraStream Offline",
    "profile.other_apps": "Other Apps & System",
    "profile.free_space": "Free Space",
    "profile.auto_dl_next": "Auto-Download Next Episode",
    "profile.auto_dl_next_desc": "Automatically downloads next episode while connected to Wi-Fi",
    "profile.auto_del_watched": "Auto-Delete Watched Episodes",
    "profile.auto_del_watched_desc": "Deletes cached episode after you finish watching",
    "profile.wifi_only": "Download on Wi-Fi Only",
    "profile.wifi_only_desc": "Prevents cellular data usage for downloads",
    "profile.cellular_saver": "Cellular Data Saver",
    "profile.cellular_saver_desc": "Streams at optimal bitrate on mobile data to save quota",
    "profile.batch_downloader": "Series Batch Downloader",
    "profile.export_all": "Export All",
    "profile.clear_all": "Clear All",
    "profile.pause_all": "Pause All",
    "profile.resume_all": "Resume All",
    "profile.download_all_watch_later": "Download Watch Later",
    "profile.aggregate_speed": "{speed} · {count} downloading",
    "profile.active_downloads": "Active Downloads ({count})",
    "profile.downloaded_series": "Downloaded Series ({series}) · {episodes} Total Episodes",
    "profile.mb_total": "{mb} MB Total",
    "profile.export_series": "Export Series",
    "profile.delete_series": "Delete Series",
    "profile.confirm_clear_title": "Clear All Offline Downloads?",
    "profile.confirm_clear_desc": "This will remove all downloaded episodes from this device. You will need to re-download them to watch offline.",
    "profile.explore": "Explore Now",
    "profile.logout": "Log Out",
    "profile.client_footer": "AuraStream {version} · {platform} Client",

    // Categories Page
    "cat.title": "Categories",
    "cat.subtitle": "Updated weekly with new series",
    "cat.rankings": "Rankings",
    "cat.rankings_sub": "Top Charts · Trending · Staff Picks",
    "cat.topics": "Topics",
    "cat.topics_title": "Featured Topics",
    "cat.topics_sub": "Curated series",
    "cat.tags": "Genres",
    "cat.tags_title": "Genres & Tags",
    "cat.tags_sub": "Browse by tags",
    "cat.related_topics": "Related Topics",
    "cat.all": "All",
    "cat.retry": "Retry",
    "cat.channel_ai_duanju": "AI Short Dramas",
    "cat.channel_ai_duanju_desc": "Twists & cliffhangers · Binge-worthy",
    "cat.channel_ai_manju": "AI Anime Dramas",
    "cat.channel_ai_manju_desc": "Animated stories · Weekly updates",
    "cat.channel_original": "Originals",
    "cat.channel_original_desc": "Exclusive original productions",
    "cat.posts": "Community",
    "cat.posts_desc": "Hot topics, discussions & leaks",

    // Search Page
    "search.placeholder": "Search dramas, actors...",
    "search.hot": "Trending Searches",
    "search.history": "Recent Searches",
    "search.clear": "Clear",
    "search.dramas": "Dramas",
    "search.posts": "Posts",
    "search.no_result": "No results found",
    "search.no_result_sub": "Try searching for a different keyword or genre",
    "search.hot_error": "Hot searches temporarily unavailable.",
    "search.hot_error_refresh": "Failed to refresh hot list.",
    "search.trending_genres": "Trending Genres",
    "search.full_rankings": "Full Rankings ›",
    "search.popular_tropes": "Popular Tropes & Themes",
    "search.surprise_me": "Surprise Me",

    // Batch Downloader
    "batch.title": "Series Batch Downloader",
    "batch.next_5": "Next 5",
    "batch.next_10": "Next 10",
    "batch.all_unsaved": "All Unsaved ({count})",
    "batch.clear": "Clear",
    "batch.download_selected": "Download ({count})",
    "batch.selected_count": "{count} Episodes Selected",
    "batch.est_size": "Est. size: ~{size}",
    "batch.downloading": "Downloading Ep. {current} ({completed}/{total})",
    "batch.cancel_batch": "Cancel Batch",
    "batch.allow_cellular": "Allow Cellular",
    "batch.cellular_warning": "Cellular data active (\"Wi-Fi Only\" guard enabled)",
    "batch.quality_title": "Download Quality",
    "batch.quality_hevc": "Data Saver (HEVC ~40% smaller)",
    "batch.quality_standard": "Standard HD (Universal)",
    "batch.quality_auto": "Auto (Best Available)",
    "batch.low_storage_warning": "Low device storage space. Please free up space before downloading.",

    // Settings Page
    "settings.title": "Settings",
    "settings.subtitle": "Customize AuraStream to your preference",
    "settings.appearance": "Appearance",
    "settings.theme": "Theme",
    "settings.theme_system": "System",
    "settings.theme_light": "Light",
    "settings.theme_dark": "Dark",
    "settings.accent": "Accent Color",
    "settings.accent_desc": "Personalize buttons and highlights",
    "settings.accent_blue": "Electric Blue",
    "settings.accent_cyan": "Cyan",
    "settings.accent_emerald": "Emerald",
    "settings.accent_rose": "Rose",
    "settings.accent_amber": "Amber",
    "settings.accent_violet": "Violet",
    "settings.language": "Language",
    "settings.language_desc": "Display language for the app",
    "settings.download_quality": "Default Download Quality",
    "settings.download_quality_desc": "Select preferred video codec and size for offline downloads",
    "settings.playback": "Playback",
    "settings.mute_startup": "Mute on Launch",
    "settings.mute_startup_desc": "Start playback muted by default; saves battery and prevents sudden loud audio",
    "settings.prefer_hd": "Prefer High Definition",
    "settings.prefer_hd_desc": "Automatically use HEVC HD stream when available",
    "settings.data": "Local Data",
    "settings.library": "Local Library",
    "settings.library_desc": "{favs} favorites · {hist} watch history items",
    "settings.clear_cache": "Clear Cache",
    "settings.clear_cache_desc": "Cover images, media cache & local logs",
    "settings.cache_cleared": "Cache cleared successfully",
    "settings.network": "Network & Connectivity",
    "settings.proxy": "Proxy Settings",
    "settings.proxy_system": "System Proxy",
    "settings.proxy_custom": "Custom Proxy",
    "settings.proxy_direct": "Direct Connection",
    "settings.source": "Streaming Source",
    "settings.auto_line": "Auto-Select Best Line",
    "settings.auto_line_desc": "Automatically detect and switch to healthy mirrors if primary fails",
    "settings.strict_security": "Strict Security Mode",
    "settings.strict_security_desc": "Protects against upstream injection and local probing",
    "settings.net_diag": "Network Diagnostics",
    "settings.net_diag_desc": "Test DNS, TCP, and proxy connectivity; one-click report export",
    "settings.playback_diag": "Playback Diagnostics Log",
    "settings.playback_diag_desc": "Logs detailed buffer & decoding traces for troubleshooting",
    "settings.copy_playback_log": "Copy Playback Diagnostics",
    "settings.check_update": "Check for Updates",
    "settings.check_update_desc": "Current v{version} · Compare with GitHub Releases",
    "settings.about": "About AuraStream",
    "settings.about_desc": "Version {version} · Non-commercial use only",

    // Modals & General
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.copied": "Copied to clipboard",
    "common.failed": "Request failed, please check your network",
    "common.login_title": "Sign In to AuraStream",
    "common.register_title": "Register for AuraStream",
    "common.details": "Details",
    "common.following": "Following",
    "common.follow": "+ Follow",
    "common.recommended": "Recommended Series",
    "common.synopsis": "Synopsis",
    "common.no_desc": "No description available",
    "common.back": "Back",
  },
} as const;

export type TranslationKey = keyof typeof translations["en"];

export function getTranslation(_lang: Language, key: TranslationKey, params?: Record<string, string | number>): string {
  let str: string = (translations.en as Record<string, string>)[key] || key;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    });
  }
  return str;
}

/**
 * Localizes and sanitizes backend/network error messages so no raw Chinese
 * strings or internal technical details leak into the UI.
 */
export function localizeError(raw: unknown, _lang: Language = "en"): string {
  if (!raw) return "An unexpected error occurred.";
  const msg = typeof raw === "string" ? raw : (raw as Error).message || String(raw);
  const trimmed = msg.trim();
  if (!trimmed) return "An unexpected error occurred.";

  if (trimmed.includes("视频不存在") || trimmed.includes("不可播放") || trimmed.includes("暂无播放")) {
    return "This video is currently unavailable or has expired.";
  }
  if (trimmed.includes("请先登录")) {
    return "Please sign in to access this feature.";
  }
  if (trimmed.includes("网络") || trimmed.includes("超时") || trimmed.includes("timed out") || trimmed.includes("timeout")) {
    return "Network timeout. Please check your internet connection.";
  }
  if (trimmed.includes("重定向次数超过限制")) {
    return "Network redirect limit reached. Please switch line.";
  }
  if (trimmed.includes("账号或线路已变化") || trimmed.includes("线路已变化")) {
    return "Server route updated. Please try again.";
  }
  if (trimmed.includes("镜像线路仅供游客浏览")) {
    return "This mirror line is for guest browsing only. Please switch lines to sign in.";
  }
  if (trimmed.includes("账号资料响应无效")) {
    return "Account session expired. Please sign in again.";
  }
  if (trimmed.includes("重试") || trimmed.includes("失败")) {
    return "Operation failed. Please try again.";
  }

  // If error message contains CJK characters, map to safe English fallback
  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    return "This content is temporarily unavailable.";
  }

  return trimmed;
}
