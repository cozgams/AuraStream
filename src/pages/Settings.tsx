import { Button, SegmentedControl, Surface, TextArea } from "../components/ios/controls";
import { useEffect, useState, type ReactNode } from "react";
import { api, APP_VERSION, errorMessage, hostOf, logLine, platform, type UpdateInfo } from "../api";
import { useStore } from "../store";
import { Modal, Toggle } from "../components/ui";
import LinePicker from "../components/LinePicker";
import ProxySettings from "../components/ProxySettings";
import { autoLineEnabled, setAutoLine } from "../autoLine";
import { copyPlaybackLog, initPlaybackLog, setPlaybackLog, tracePlayback, usePlaybackLog } from "../playbackDiagnostics";
import { formatNetDiag, shortVerdict } from "../netDiagReport";
import { copyText } from "../clipboard";
import { IBack, IBoltF, IBroom, ICaptionsF, ICheck, IChevR, IDownload, IHeart, IInfo, ILink, ILockF, IMoon, IPalette, IRefresh, ISun, IVolMute } from "../icons";
import UpdateModal from "../components/UpdateModal";
import { isAutoUpdateCheckEnabled, setAutoUpdateCheckEnabled, isAndroidNativeOtaSupported } from "../otaUpdater";
import { getAndroidPermissionsStatus, type AndroidPermissionsStatus } from "../offline/exportService";
import { getSubtitleStyleConfig, setSubtitleStyleConfig } from "../subtitles/aiSubtitleService";
import type { SubtitleStyleConfig } from "../subtitles/types";
import {
  getDownloadQualityPreference,
  setDownloadQualityPreference,
  isDownloadNotificationEnabled,
  setDownloadNotificationEnabled,
  isWifiOnlyDownloadEnabled,
  setWifiOnlyDownloadEnabled,
  isSmartDownloadEnabled,
  setSmartDownloadEnabled,
  type DownloadQuality,
} from "../offline/downloadService";
import {
  isFullEpisodePreCacheEnabled,
  setFullEpisodePreCacheEnabled,
  isNextEpisodePreloadEnabled,
  setNextEpisodePreloadEnabled,
  runDeepRamPurge,
} from "../playbackFeatures";
import type { AccentColor } from "../store";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="ios-section-label">{title}</div>
      <Surface className="ios-setting-group">{children}</Surface>
    </>
  );
}

export default function Settings({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const {
    theme,
    themePreference,
    setTheme,
    accent,
    setAccent,
    favs,
    history,
    muteOnStartup,
    setMuteOnStartup,
    preferHevc,
    setPreferHevc,
    strictSecurity,
    strictSecurityReady,
    securityPending,
    cliRelaxed,
    setStrictSecurity,
    toast,
    t,
  } = useStore();

  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [autoLineOn, setAutoLineOn] = useState(autoLineEnabled);
  const [clearing, setClearing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [autoUpdateOn, setAutoUpdateOn] = useState(() => isAutoUpdateCheckEnabled());
  const [androidPerms, setAndroidPerms] = useState<AndroidPermissionsStatus | null>(() => getAndroidPermissionsStatus());
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);
  const [subStyle, setSubStyle] = useState<SubtitleStyleConfig>(() => getSubtitleStyleConfig());
  const [downloadQuality, setDownloadQuality] = useState<DownloadQuality>(() => getDownloadQualityPreference());
  const [downloadNotifs, setDownloadNotifs] = useState(() => isDownloadNotificationEnabled());
  const [wifiOnlyDl, setWifiOnlyDl] = useState(() => isWifiOnlyDownloadEnabled());
  const [smartDl, setSmartDl] = useState(() => isSmartDownloadEnabled());
  const [fullPreCache, setFullPreCache] = useState(() => isFullEpisodePreCacheEnabled());
  const [nextPreload, setNextPreload] = useState(() => isNextEpisodePreloadEnabled());
  const [purgingRam, setPurgingRam] = useState(false);

  useEffect(() => {
    const syncStorageCfg = () => {
      setDownloadQuality(getDownloadQualityPreference());
      setWifiOnlyDl(isWifiOnlyDownloadEnabled());
      setSmartDl(isSmartDownloadEnabled());
    };
    const syncPlaybackCfg = () => {
      setFullPreCache(isFullEpisodePreCacheEnabled());
      setNextPreload(isNextEpisodePreloadEnabled());
    };
    const syncOtaCfg = () => setAutoUpdateOn(isAutoUpdateCheckEnabled());
    const refreshPerms = () => setAndroidPerms(getAndroidPermissionsStatus());
    const onVis = () => {
      if (document.visibilityState === "visible") refreshPerms();
    };
    window.addEventListener("aurastream:storage-config-changed", syncStorageCfg);
    window.addEventListener("aurastream:playback-config-changed", syncPlaybackCfg);
    window.addEventListener("aurastream:ota-config-changed", syncOtaCfg);
    window.addEventListener("aurastream:app-resumed", refreshPerms);
    window.addEventListener("aurastream:permissions-changed", refreshPerms);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("aurastream:storage-config-changed", syncStorageCfg);
      window.removeEventListener("aurastream:playback-config-changed", syncPlaybackCfg);
      window.removeEventListener("aurastream:ota-config-changed", syncOtaCfg);
      window.removeEventListener("aurastream:app-resumed", refreshPerms);
      window.removeEventListener("aurastream:permissions-changed", refreshPerms);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const onStyleChange = (e: Event) => {
      const customEvent = e as CustomEvent<SubtitleStyleConfig>;
      if (customEvent.detail) setSubStyle(customEvent.detail);
      else setSubStyle(getSubtitleStyleConfig());
    };
    window.addEventListener("aurastream:subtitlestyle-changed", onStyleChange);
    return () => window.removeEventListener("aurastream:subtitlestyle-changed", onStyleChange);
  }, []);

  useEffect(() => {
    void initPlaybackLog();
  }, []);

  const readLine = () => {
    api.lineState().then((state) => setLineBase(state.base)).catch(() => {});
  };

  useEffect(() => {
    const sync = () => {
      readLine();
      setAutoLineOn(autoLineEnabled());
    };
    sync();
    window.addEventListener("hg:line-changed", sync);
    window.addEventListener("hg:auto-line-changed", sync);
    return () => {
      window.removeEventListener("hg:line-changed", sync);
      window.removeEventListener("hg:auto-line-changed", sync);
    };
  }, []);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      if (info.has_update) setUpdate(info);
      else toast(`Already on latest version v${info.current}`, "ok");
    } catch (e) {
      toast(errorMessage(e, "Failed to check for updates"), "info");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      {/* Top App Bar Header */}
      <div
        className="shrink-0 px-4 flex items-center justify-between border-b border-edge/30 bg-bg/90 backdrop-blur-md z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 8px)", paddingBottom: "10px" }}
      >
        <div className="flex items-center gap-3">
          <Button onClick={onBack} aria-label={t("common.back")} className="ios-icon-button">
            <IBack size={20} />
          </Button>
          <div>
            <h1 className="text-[18px] font-bold text-on tracking-tight leading-tight">{t("settings.title")}</h1>
            <p className="text-[11px] text-mut leading-none mt-0.5">Customize your experience</p>
          </div>
        </div>
      </div>

      <div
        className="ios-page-body flex-1 scroll-y px-4 pt-3"
        style={{ paddingBottom: "calc(var(--sab, 48px) + 40px)" }}
      >
        <div className={wide ? "max-w-[720px] mx-auto" : ""}>
          {/* Appearance Section */}
          <Section title={t("settings.appearance")}>
            <div className="ios-appearance-row items-center">
              <span className="ios-setting-icon">
                {themePreference === "system" ? <IRefresh size={16} /> : theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}
              </span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{t("settings.appearance")}</div>
                <div className="text-[12px] text-mut">
                  {themePreference === "system"
                    ? `Follow system (${theme === "dark" ? "Dark" : "Light"})`
                    : theme === "dark"
                    ? "Dark appearance"
                    : "Light appearance"}
                </div>
              </div>
              <SegmentedControl
                className="ios-appearance-picker"
                aria-label="Appearance Mode"
                activeIndex={(["system", "light", "dark"] as const).indexOf(themePreference)}
              >
                {(
                  [
                    ["system", "System"],
                    ["light", "Light"],
                    ["dark", "Dark"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    aria-pressed={themePreference === value}
                    onClick={() => setTheme(value)}
                  >
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
            </div>
            {/* Accent Color Picker */}
            <div className="flex flex-col gap-2.5 px-3.5 py-3">
              <div className="flex items-center gap-3">
                <span className="ios-setting-icon"><IPalette size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">{t("settings.accent")}</div>
                  <div className="text-[12px] text-mut">{t("settings.accent_desc")}</div>
                </div>
              </div>
              <div className="grid grid-cols-6 gap-2 pt-0.5">
                {(
                  [
                    ["blue", "Blue", "#1a73e8"],
                    ["cyan", "Cyan", "#00b8d4"],
                    ["emerald", "Emerald", "#10b981"],
                    ["rose", "Rose", "#f43f5e"],
                    ["amber", "Amber", "#f59e0b"],
                    ["violet", "Violet", "#8b5cf6"],
                  ] as const
                ).map(([key, label, swatch]) => {
                  const active = accent === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`Accent ${label}`}
                      aria-pressed={active}
                      onClick={() => {
                        setAccent(key as AccentColor);
                        toast(`Accent color: ${label}`, "ok");
                      }}
                      className={`flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-xl border transition-all pressable ${
                        active
                          ? "bg-s2 border-primary text-on font-bold shadow-xs"
                          : "bg-s3/60 border-edge/30 text-mut hover:text-on"
                      }`}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-white shadow-xs"
                        style={{ backgroundColor: swatch }}
                      >
                        {active && <ICheck size={11} strokeWidth={3} />}
                      </span>
                      <span className="text-[10.5px] leading-tight">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

          {/* Subtitles & Closed Captions (CC) Section */}
          <Section title="Subtitles & Closed Captions (CC)">
            <div className="flex flex-col gap-2 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="ios-setting-icon"><ICaptionsF size={16} /></span>
                  <div>
                    <div className="text-[14px] text-on font-medium">Caption Screen Position</div>
                    <div className="text-[12px] text-mut">Vertical placement on screen & video</div>
                  </div>
                </div>
                <span className="text-[12px] font-mono text-amber-500 font-semibold">
                  {typeof subStyle.customOffsetPercent === "number"
                    ? `${subStyle.customOffsetPercent}%`
                    : subStyle.position === "top"
                    ? "85%"
                    : subStyle.position === "middle"
                    ? "50%"
                    : subStyle.position === "above_title"
                    ? "32%"
                    : "12%"}
                </span>
              </div>
              <SegmentedControl
                className="ios-appearance-picker mt-1"
                aria-label="Caption Position"
                activeIndex={(["bottom", "above_title", "middle", "top"] as const).indexOf(
                  (subStyle.position === "custom" ? "bottom" : subStyle.position) || "bottom"
                )}
              >
                {(
                  [
                    ["bottom", "Downside", 12],
                    ["above_title", "Above Title", 32],
                    ["middle", "Middle", 50],
                    ["top", "Top", 85],
                  ] as const
                ).map(([pos, label, defaultPct]) => (
                  <Button
                    key={pos}
                    type="button"
                    aria-pressed={subStyle.position === pos}
                    onClick={() => {
                      const updated: SubtitleStyleConfig = {
                        ...subStyle,
                        position: pos,
                        customOffsetPercent: defaultPct,
                      };
                      setSubStyle(updated);
                      setSubtitleStyleConfig(updated);
                      toast(`Caption position: ${label}`, "ok");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-[11px] text-mut shrink-0 font-medium">Fine-tune:</span>
                <input
                  type="range"
                  min={5}
                  max={90}
                  step={1}
                  value={
                    typeof subStyle.customOffsetPercent === "number"
                      ? subStyle.customOffsetPercent
                      : subStyle.position === "top"
                      ? 85
                      : subStyle.position === "middle"
                      ? 50
                      : subStyle.position === "above_title"
                      ? 32
                      : 12
                  }
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    const updated: SubtitleStyleConfig = {
                      ...subStyle,
                      position: "custom",
                      customOffsetPercent: pct,
                    };
                    setSubStyle(updated);
                    setSubtitleStyleConfig(updated);
                  }}
                  className="flex-1 accent-amber-500 cursor-pointer h-2 bg-s4 rounded-lg"
                  aria-label="Caption Position Fine Tune Slider"
                />
              </div>
            </div>
          </Section>

          {/* Playback & Download Settings */}
          <Section title={t("settings.playback")}>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IVolMute size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Mute on Startup</div>
                <div className="text-[12px] text-mut">Starts playback muted by default. Toggle off to remember previous volume.</div>
              </div>
              <Toggle on={muteOnStartup} onChange={setMuteOnStartup} label="Mute on Startup" />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Prefer High Quality (HEVC)</div>
                <div className="text-[12px] text-mut">Streams HEVC high-efficiency video when available, falls back to standard automatically</div>
              </div>
              <Toggle on={preferHevc} onChange={setPreferHevc} label="Prefer High Quality (HEVC)" />
            </div>
            {/* Download Quality Preference */}
            <div className="flex flex-col gap-1.5 px-3.5 py-3">
              <div className="flex items-center gap-3">
                <span className="ios-setting-icon"><IDownload size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">Download Quality</div>
                  <div className="text-[12px] text-mut">Preferred resolution and codec for offline downloads</div>
                </div>
              </div>
              <SegmentedControl
                className="ios-appearance-picker mt-1"
                aria-label="Download Quality"
                activeIndex={(["auto", "hevc", "standard"] as const).indexOf(downloadQuality)}
              >
                {(
                  [
                    ["auto", "Auto"],
                    ["hevc", "HEVC"],
                    ["standard", "H.264"],
                  ] as const
                ).map(([val, label]) => (
                  <Button
                    key={val}
                    type="button"
                    aria-pressed={downloadQuality === val}
                    onClick={() => {
                      setDownloadQuality(val as DownloadQuality);
                      setDownloadQualityPreference(val as DownloadQuality);
                      toast(`Download quality: ${label}`, "ok");
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3 border-t border-edge/20">
              <span className="ios-setting-icon"><IDownload size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">{t("profile.wifi_only")}</div>
                <div className="text-[12px] text-mut">{t("profile.wifi_only_desc")}</div>
              </div>
              <Toggle
                on={wifiOnlyDl}
                onChange={(enabled) => {
                  setWifiOnlyDl(enabled);
                  setWifiOnlyDownloadEnabled(enabled);
                  toast(enabled ? "Download on Wi-Fi Only enabled" : "Cellular downloads allowed", "info");
                }}
                label={t("profile.wifi_only")}
              />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3 border-t border-edge/20">
              <span className="ios-setting-icon"><IDownload size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">{t("profile.auto_dl_next")}</div>
                <div className="text-[12px] text-mut">{t("profile.auto_dl_next_desc")}</div>
              </div>
              <Toggle
                on={smartDl}
                onChange={(enabled) => {
                  setSmartDl(enabled);
                  setSmartDownloadEnabled(enabled);
                  toast(enabled ? "Smart Auto-Download enabled" : "Smart Auto-Download disabled", "info");
                }}
                label={t("profile.auto_dl_next")}
              />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3 border-t border-edge/20">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Turbo Full-Episode Pre-Cache</div>
                <div className="text-[12px] text-mut">Buffers entire short episode ahead on Wi-Fi to eliminate mid-scene pauses</div>
              </div>
              <Toggle
                on={fullPreCache}
                onChange={(enabled) => {
                  setFullPreCache(enabled);
                  setFullEpisodePreCacheEnabled(enabled);
                  toast(enabled ? "Turbo full-episode pre-cache enabled" : "Standard buffer window enabled", "info");
                }}
                label="Turbo Full-Episode Pre-Cache"
              />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3 border-t border-edge/20">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Instant Next-Episode Preload</div>
                <div className="text-[12px] text-mut">Pre-fetches upcoming episode playlist and first segments for zero-wait transitions</div>
              </div>
              <Toggle
                on={nextPreload}
                onChange={(enabled) => {
                  setNextPreload(enabled);
                  setNextEpisodePreloadEnabled(enabled);
                  toast(enabled ? "Instant next-episode preload enabled" : "Next-episode preload disabled", "info");
                }}
                label="Instant Next-Episode Preload"
              />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3 border-t border-edge/20">
              <span className="ios-setting-icon"><IDownload size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Background Download Alerts</div>
                <div className="text-[12px] text-mut">Show progress notifications in system bar when app is minimized</div>
              </div>
              <Toggle
                on={downloadNotifs}
                onChange={(enabled) => {
                  setDownloadNotifs(enabled);
                  setDownloadNotificationEnabled(enabled);
                  toast(enabled ? "Download notifications enabled" : "Download notifications disabled", "info");
                }}
                label="Background Download Alerts"
              />
            </div>
          </Section>

          {/* Android Permissions & Background Execution */}
          {androidPerms !== null && (
            <Section title="Permissions & Background">
              <Button
                onClick={() => {
                  window.AuraNativeExport?.requestIgnoreBatteryOptimizations?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable"
              >
                <span className="ios-setting-icon"><IBoltF size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">Unrestricted Background Downloads</div>
                  <div className="text-[12px] text-mut">Prevents Android from pausing downloads when you leave the app</div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${
                    androidPerms.batteryOptimizationIgnored
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {androidPerms.batteryOptimizationIgnored ? "Granted" : "Action Needed"}
                </span>
              </Button>
              <Button
                onClick={() => {
                  window.AuraNativeExport?.requestNotificationPermissionNow?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable"
              >
                <span className="ios-setting-icon"><IDownload size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">Download Notifications</div>
                  <div className="text-[12px] text-mut">Live speed, progress bar, and Pause/Cancel controls in notification shade</div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${
                    androidPerms.notificationsGranted
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {androidPerms.notificationsGranted ? "Granted" : "Action Needed"}
                </span>
              </Button>
              <Button
                onClick={() => {
                  window.AuraNativeExport?.openInstallPermissionSettings?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable"
              >
                <span className="ios-setting-icon"><IRefresh size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">In-App Updates (Install APKs)</div>
                  <div className="text-[12px] text-mut">Required on Android to install GitHub OTA updates inside the app</div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${
                    androidPerms.canInstallPackages
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {androidPerms.canInstallPackages ? "Granted" : "Action Needed"}
                </span>
              </Button>
              <Button
                onClick={() => {
                  if (androidPerms.storageGranted) {
                    toast("Media & Downloads export permission is active", "ok");
                    return;
                  }
                  window.AuraNativeExport?.requestLegacyStoragePermission?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable"
              >
                <span className="ios-setting-icon"><IInfo size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">Storage & Gallery Export</div>
                  <div className="text-[12px] text-mut">Save offline episodes to Movies/AuraStream or Download/AuraStream</div>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${
                    androidPerms.storageGranted
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {androidPerms.storageGranted ? "Granted" : "Action Needed"}
                </span>
              </Button>
              <Button
                onClick={() => {
                  window.AuraNativeExport?.openAppSettings?.();
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable"
              >
                <span className="ios-setting-icon"><ILockF size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-on">Open Android App Settings</div>
                  <div className="text-[12px] text-mut">Inspect Battery, Notifications, and App permissions in system settings</div>
                </div>
                <IChevR size={15} className="text-mut" />
              </Button>
            </Section>
          )}

          {/* Storage & Data */}
          <Section title="Storage & Data">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IHeart size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">Local Library</div>
                <div className="text-[12px] text-mut">{favs.length} favorites · {history.length} watch history items</div>
              </div>
            </div>
            <Button
              disabled={purgingRam}
              onClick={async () => {
                setPurgingRam(true);
                try {
                  const res = await runDeepRamPurge();
                  toast(`Memory optimized · Freed ${res.freedFormatted}`, "ok");
                } catch {
                  toast("Memory & temporary buffers optimized", "ok");
                } finally {
                  setPurgingRam(false);
                }
              }}
              className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60"
            >
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{purgingRam ? "Optimizing Memory..." : "Optimize Memory & Temp Buffers"}</div>
                <div className="text-[12px] text-mut">Purges inactive preloaded segments and frees RAM while keeping all downloads</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <Button onClick={() => setClearOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IBroom size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{t("settings.clear_cache")}</div>
                <div className="text-[12px] text-mut">{t("settings.clear_cache_desc")}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          {/* Network & Source */}
          <Section title={t("settings.network")}>
            <ProxySettings />
            <Button onClick={() => setLineOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Streaming Source</div>
                <div className="text-[12px] text-mut truncate">{lineBase ? hostOf(lineBase) : "Loading..."}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IRefresh size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Auto-Select Best Line</div>
                <div className="text-[12px] text-mut">Detects active published mirrors when official source is slow or unavailable</div>
              </div>
              <Toggle
                label="Auto-Select Best Line"
                on={autoLineOn}
                onChange={async (on) => {
                  setAutoLineOn(on);
                  try {
                    await setAutoLine(on);
                    toast(
                      on ? "Auto-select line enabled" : "Auto-select line disabled, manual selection preserved",
                      "info"
                    );
                  } catch {
                    setAutoLineOn(!on);
                    toast("Failed to update auto-select line, please retry", "info");
                  }
                }}
              />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><ILockF size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Strict Security Mode</div>
                <div className="text-[12px] text-mut">
                  {cliRelaxed
                    ? "Running in compatibility mode via --no-strict; can be re-enabled manually"
                    : "Default enabled to guard against upstream tampering and intranet probing; toggle off for compatibility"}
                </div>
              </div>
              <Toggle
                on={strictSecurity}
                disabled={!strictSecurityReady || securityPending}
                onChange={(on) => {
                  void setStrictSecurity(on)
                    .then(() => {
                      toast(on ? "Strict security mode enabled" : "Compatibility mode enabled", "info");
                    })
                    .catch(() => toast("Failed to save security mode, preserved original setting", "info"));
                }}
                label="Strict Security Mode"
              />
            </div>
            {/* Network Diagnostics */}
            <Button
              disabled={diagnosing}
              onClick={async () => {
                setDiagnosing(true);
                try {
                  const diag = await api.netDiag();
                  logLine(`[net_diag] ${JSON.stringify(diag)}`);
                  const http = (diag.http ?? {}) as { ms?: number; status?: number };
                  const dns = (diag.dns ?? {}) as { count?: number; has_fake_ip?: boolean };
                  const env = (diag.env ?? {}) as Record<string, unknown>;
                  tracePlayback("net.diag", {
                    verdict: String(diag.verdict ?? ""),
                    host: hostOf(String(diag.host ?? "")),
                    http_status: http.status ?? null,
                    http_ms: http.ms ?? null,
                    dns_count: dns.count ?? null,
                    fake_ip: dns.has_fake_ip ?? null,
                    proxy: Object.values(env).some(Boolean),
                    strict: strictSecurity,
                  });
                  const report = formatNetDiag(diag);
                  try {
                    await copyText(report);
                    toast(`Diagnostics copied · ${shortVerdict(diag)}`, "ok");
                  } catch {
                    setDiagReport(report);
                    toast("Diagnostics completed, copy failed, select text below to copy", "info");
                  }
                } catch (e) {
                  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "Please retry later";
                  toast(`Diagnostics error: ${detail}`, "info");
                } finally {
                  setDiagnosing(false);
                }
              }}
              className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60"
            >
              <span className="ios-setting-icon"><ILink size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{diagnosing ? "Diagnosing..." : "Network Diagnostics"}</div>
                <div className="text-[12px] text-mut">DNS / TCP / Proxy / Server connectivity diagnostic report</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          {/* Playback Diagnostics */}
          <Section title="Playback Diagnostics">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Playback Diagnostics Log</div>
                <div className="text-[12px] text-mut">Version, platform, current line, and error events are always recorded; toggle enables sub-frame buffering logs</div>
                {playbackLog.error && <div role="alert" className="text-[12px] text-danger">{playbackLog.error}</div>}
              </div>
              <Toggle
                label="Playback Diagnostics Log"
                on={playbackLog.enabled}
                disabled={!playbackLog.ready || playbackLog.pending}
                onChange={(on) => {
                  void setPlaybackLog(on)
                    .then(() => toast(on ? "Playback diagnostics enabled" : "Playback diagnostics disabled", "ok"))
                    .catch(() => toast("Failed to save log configuration, please retry", "info"));
                }}
              />
            </div>
            <Button
              disabled={!playbackLog.ready || playbackLog.pending || copyingLog}
              onClick={async () => {
                setCopyingLog(true);
                try {
                  await copyPlaybackLog();
                  toast("Playback log copied", "ok");
                } catch (e) {
                  toast(errorMessage(e, "Failed to copy logs"), "info");
                } finally {
                  setCopyingLog(false);
                }
              }}
              className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60"
            >
              <span className="ios-setting-icon"><ILink size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">{copyingLog ? "Copying..." : "Copy Playback Diagnostics"}</div>
                <div className="text-[12px] text-mut break-all">
                  Includes version, platform, current line, and playback errors{playbackLog.path ? ` · ${playbackLog.path}` : ""}
                </div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          {/* About & Updates Section */}
          <Section title="About">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IRefresh size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">Auto-Check for Updates</div>
                <div className="text-[12px] text-mut">Check GitHub Releases on launch when online</div>
              </div>
              <Toggle
                label="Auto-Check for Updates"
                on={autoUpdateOn}
                onChange={(on) => {
                  setAutoUpdateOn(on);
                  setAutoUpdateCheckEnabled(on);
                  toast(on ? "Auto-check for updates enabled" : "Auto-check for updates disabled", "info");
                }}
              />
            </div>
            <Button onClick={checkUpdate} disabled={checking} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><IRefresh size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">Check for Updates</div>
                <div className="text-[12px] text-mut">
                  {checking
                    ? "Checking..."
                    : isAndroidNativeOtaSupported()
                    ? `Current v${APP_VERSION} · In-app GitHub OTA`
                    : `Current v${APP_VERSION} · Compare with GitHub Release`}
                </div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <Button onClick={() => setAbout(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{t("settings.about")}</div>
                <div className="text-[12px] text-mut">Version {APP_VERSION} · Open-source non-commercial</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          <div className="text-center text-[12px] text-dim mt-5">
            AuraStream v{APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} Client
          </div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      {/* Network Diagnostics Report Fallback Modal */}
      <Modal open={diagReport !== null} onClose={() => setDiagReport(null)} width={520} label="Network Diagnostics Report">
        <div className="p-5">
          <h2 className="text-[15px] font-bold text-on">Network Diagnostics Report</h2>
          <p className="text-[13px] text-mut mt-2">Diagnostics completed. Automatic clipboard copy was blocked. You can retry or copy below.</p>
          <TextArea
            readOnly
            aria-label="Network diagnostics report"
            value={diagReport ?? ""}
            className="w-full h-64 mt-3 p-3 rounded-(--r-sm) bg-s3 text-[12px] text-on resize-none"
          />
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setDiagReport(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">
              Close
            </Button>
            <Button
              disabled={copyingReport}
              onClick={async () => {
                if (diagReport === null) return;
                setCopyingReport(true);
                try {
                  await copyText(diagReport);
                  toast("Report copied", "ok");
                  setDiagReport(null);
                } catch {
                  toast("Copy failed, please select and copy text manually", "info");
                } finally {
                  setCopyingReport(false);
                }
              }}
              className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable disabled:opacity-60"
            >
              {copyingReport ? "Copying..." : "Copy Report"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* About Modal */}
      <Modal open={about} onClose={() => setAbout(false)} width={392} label={t("settings.about")}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">
              A
            </span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">AuraStream</div>
              <div className="text-[12px] text-mut mt-0.5">AuraStream Client v{APP_VERSION} · This App Created by AAA. All rights reserved.</div>
            </div>
          </div>

          <p className="text-[13px] text-on/70 leading-relaxed mt-4">
            Modern cross-platform streaming media client built with Rust and Tauri 2, featuring an immersive mobile-first media feed, high-performance offline downloads, and customizable real-time closed captions.
          </p>

          <Surface className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[12px] text-mut leading-relaxed">
            This project is provided for research and personal use. All content is fetched live from upstream video endpoints; the client does not store or distribute copyrighted material.
          </Surface>

          <div className="mt-4 divide-y divide-s3">
            <Button
              onClick={() => {
                api.openUrl("https://github.com/cozgams/AuraStream").catch(() => {
                  copyText("https://github.com/cozgams/AuraStream")
                    .then(() => toast("Repository URL copied", "ok"))
                    .catch(() => {});
                });
              }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable"
            >
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">github.com/cozgams/AuraStream</span>
              <span className="ml-auto text-[12px] text-primary">Copy</span>
            </Button>
            <div className="flex items-center gap-2 py-2.5">
              <IInfo size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto text-[12px] text-mut">Noncommercial</span>
            </div>
          </div>

          <Button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">
            Close
          </Button>
        </div>
      </Modal>

      {/* Clear Cache Modal */}
      <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330} label="Clear Cache">
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">Clear Cache</div>
          <p className="text-[13px] text-mut leading-relaxed mt-2">
            Clears cover thumbnails and decrypted stream manifests. Favorites, watch history, offline downloads, and login state are completely preserved.
          </p>
          <div className="flex gap-2 mt-5">
            <Button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable">
              Cancel
            </Button>
            <Button
              disabled={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  await api.clearCache();
                } catch {
                  /* ignore */
                }
                setClearing(false);
                setClearOpen(false);
                toast(t("settings.cache_cleared"), "ok");
              }}
              className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60"
            >
              {clearing ? "Clearing..." : "Clear"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* GitHub OTA Update Modal */}
      <UpdateModal info={update} onClose={() => setUpdate(null)} />
    </div>
  );
}
