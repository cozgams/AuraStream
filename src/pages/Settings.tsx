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
import {
  IBack,
  IBoltF,
  IBroom,
  ICheck,
  IChevR,
  IDownload,
  IHeart,
  IInfo,
  ILink,
  ILockF,
  IMoon,
  IPalette,
  IRefresh,
  ISun,
  IVolMute,
  ISettings,
} from "../icons";
import UpdateModal from "../components/UpdateModal";
import { getAvailableUpdateInfo, getOtaRuntimeState, isAutoUpdateCheckEnabled, setAutoUpdateCheckEnabled, setAvailableUpdateInfo, isAndroidNativeOtaSupported, subscribeAvailableUpdate, subscribeOtaRuntimeState, type OtaRuntimeState } from "../otaUpdater";
import { getAndroidPermissionsStatus, type AndroidPermissionsStatus } from "../offline/exportService";
import { clearSubtitleCache } from "../subtitles/aiSubtitleService";
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

function SettingsSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 mb-5">
      <div className="px-3.5">
        <h2 className="text-[11.5px] font-bold uppercase tracking-wider text-mut/80">{title}</h2>
        {subtitle && <p className="text-[11px] text-dim mt-0.5 leading-snug">{subtitle}</p>}
      </div>
      <Surface className="ios-setting-group rounded-2xl bg-s1/95 border border-edge/30 shadow-xs divide-y divide-edge/20 overflow-hidden">
        {children}
      </Surface>
    </div>
  );
}

function SettingItem({
  icon,
  iconBg = "bg-primary/10 text-primary",
  title,
  description,
  badge,
  action,
  onClick,
  hasChevron = false,
  disabled = false,
  className = "",
}: {
  icon: ReactNode;
  iconBg?: string;
  title: string;
  description?: string;
  badge?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  hasChevron?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      type={onClick ? "button" : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3.5 px-4 py-3 text-left transition-colors ${
        onClick ? "pressable hover:bg-s2/40 active:bg-s2/60 cursor-pointer" : ""
      } ${disabled ? "opacity-60 pointer-events-none" : ""} ${className}`}
    >
      <span className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-2xs ${iconBg}`}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium text-on leading-snug">{title}</div>
        {description && <div className="text-[11.5px] text-mut leading-snug mt-0.5">{description}</div>}
      </div>
      {badge && <div className="shrink-0 text-[12px] font-medium">{badge}</div>}
      {action && <div className="shrink-0 flex items-center">{action}</div>}
      {hasChevron && <IChevR size={14} className="shrink-0 text-mut/60" />}
    </Component>
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
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(() => getAvailableUpdateInfo());
  const [otaRuntime, setOtaRuntime] = useState<OtaRuntimeState>(() => getOtaRuntimeState());
  const [autoUpdateOn, setAutoUpdateOn] = useState(() => isAutoUpdateCheckEnabled());
  const [androidPerms, setAndroidPerms] = useState<AndroidPermissionsStatus | null>(() => getAndroidPermissionsStatus());
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);
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
    const unsubAvailUpdate = subscribeAvailableUpdate(setAvailableUpdate);
    const unsubOtaRuntime = subscribeOtaRuntimeState(setOtaRuntime);
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
      unsubAvailUpdate();
      unsubOtaRuntime();
      window.removeEventListener("aurastream:storage-config-changed", syncStorageCfg);
      window.removeEventListener("aurastream:playback-config-changed", syncPlaybackCfg);
      window.removeEventListener("aurastream:ota-config-changed", syncOtaCfg);
      window.removeEventListener("aurastream:app-resumed", refreshPerms);
      window.removeEventListener("aurastream:permissions-changed", refreshPerms);
      document.removeEventListener("visibilitychange", onVis);
    };
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
    if (availableUpdate?.has_update && typeof navigator !== "undefined" && navigator.onLine === false) {
      setUpdate(availableUpdate);
      return;
    }
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      setAvailableUpdateInfo(info?.has_update ? info : null);
      if (info.has_update) setUpdate(info);
      else toast(`Already on latest version v${info.current}`, "ok");
    } catch (e) {
      if (availableUpdate?.has_update) setUpdate(availableUpdate);
      else toast(errorMessage(e, "Failed to check for updates"), "info");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col select-none">
      {/* Top Header Bar */}
      <header
        className="shrink-0 px-4 flex items-center justify-between border-b border-edge/30 bg-bg/95 backdrop-blur-md z-10"
        style={{ paddingTop: "calc(var(--sat, 0px) + 8px)", paddingBottom: "10px" }}
      >
        <div className="flex items-center gap-3">
          <Button onClick={onBack} aria-label={t("common.back")} className="ios-icon-button">
            <IBack size={20} />
          </Button>
          <div>
            <h1 className="text-[18px] font-bold text-on tracking-tight leading-tight">{t("settings.title")}</h1>
            <p className="text-[11px] text-mut leading-none mt-0.5">Preferences, playback, network & offline</p>
          </div>
        </div>
        <div className="px-2.5 py-1 rounded-full bg-s2 border border-edge/30 text-[10.5px] font-mono text-mut">
          v{APP_VERSION}
        </div>
      </header>

      {/* Main Settings Content */}
      <div
        className="ios-page-body flex-1 scroll-y px-4 pt-3.5"
        style={{ paddingBottom: "calc(var(--sab, 48px) + 48px)" }}
      >
        <div className={wide ? "max-w-[700px] mx-auto" : ""}>
          {/* Section 1: Appearance & Accent */}
          <SettingsSection title={t("settings.appearance")} subtitle="Theme appearance and system accent color">
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="w-8 h-8 rounded-xl flex items-center justify-center bg-indigo-500/10 text-indigo-500">
                    {themePreference === "system" ? <IRefresh size={15} /> : theme === "dark" ? <IMoon size={15} /> : <ISun size={15} />}
                  </span>
                  <div>
                    <div className="text-[13.5px] font-medium text-on">Appearance Theme</div>
                    <div className="text-[11px] text-mut">
                      {themePreference === "system"
                        ? `Follows system (${theme === "dark" ? "Dark" : "Light"})`
                        : theme === "dark"
                        ? "Dark theme active"
                        : "Light theme active"}
                    </div>
                  </div>
                </div>
              </div>
              <SegmentedControl
                className="w-full"
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

            {/* Accent Color Palette */}
            <div className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-xl flex items-center justify-center bg-rose-500/10 text-rose-500">
                  <IPalette size={15} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-on">{t("settings.accent")}</div>
                  <div className="text-[11px] text-mut">{t("settings.accent_desc")}</div>
                </div>
              </div>
              <div className="grid grid-cols-6 gap-2 pt-1">
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
                      className={`flex flex-col items-center justify-center gap-1.5 py-2 px-1 rounded-xl border transition-all pressable ${
                        active
                          ? "bg-s2 border-primary text-on font-semibold shadow-xs"
                          : "bg-s3/40 border-edge/20 text-mut hover:text-on hover:bg-s3/70"
                      }`}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-white shadow-2xs"
                        style={{ backgroundColor: swatch }}
                      >
                        {active && <ICheck size={11} strokeWidth={3} />}
                      </span>
                      <span className="text-[10px] leading-tight">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </SettingsSection>

          {/* Section 2: Playback & Streaming */}
          <SettingsSection title={t("settings.playback")} subtitle="Audio, stream decoding, and buffer management">
            <SettingItem
              icon={<IVolMute size={15} />}
              iconBg="bg-blue-500/10 text-blue-500"
              title="Mute on Startup"
              description="Starts video muted by default; remember previous volume when off"
              action={<Toggle on={muteOnStartup} onChange={setMuteOnStartup} label="Mute on Startup" />}
            />
            <SettingItem
              icon={<IBoltF size={15} />}
              iconBg="bg-cyan-500/10 text-cyan-500"
              title="Prefer High Quality (HEVC)"
              description="Streams hardware-accelerated HEVC when available for higher quality"
              action={<Toggle on={preferHevc} onChange={setPreferHevc} label="Prefer High Quality (HEVC)" />}
            />
            <SettingItem
              icon={<IBoltF size={15} />}
              iconBg="bg-emerald-500/10 text-emerald-500"
              title="Instant Next-Episode Preload"
              description="Pre-fetches upcoming episode segments for zero-wait transition"
              action={
                <Toggle
                  on={nextPreload}
                  onChange={(enabled) => {
                    setNextPreload(enabled);
                    setNextEpisodePreloadEnabled(enabled);
                    toast(enabled ? "Instant next-episode preload enabled" : "Next-episode preload disabled", "info");
                  }}
                  label="Instant Next-Episode Preload"
                />
              }
            />
            <SettingItem
              icon={<IBoltF size={15} />}
              iconBg="bg-indigo-500/10 text-indigo-500"
              title="Turbo Full-Episode Pre-Cache"
              description="Buffers full short episode ahead on Wi-Fi to eliminate pauses"
              action={
                <Toggle
                  on={fullPreCache}
                  onChange={(enabled) => {
                    setFullPreCache(enabled);
                    setFullEpisodePreCacheEnabled(enabled);
                    toast(enabled ? "Turbo full-episode pre-cache enabled" : "Standard buffer window enabled", "info");
                  }}
                  label="Turbo Full-Episode Pre-Cache"
                />
              }
            />
          </SettingsSection>

          {/* Section 4: Offline & Downloads */}
          <SettingsSection title="Offline & Downloads" subtitle="Storage formats, cellular policies, and notifications">
            <div className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-xl flex items-center justify-center bg-sky-500/10 text-sky-500">
                  <IDownload size={15} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-on">Download Quality</div>
                  <div className="text-[11px] text-mut">Preferred resolution and codec for offline media</div>
                </div>
              </div>
              <SegmentedControl
                className="w-full mt-1"
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

            <SettingItem
              icon={<IDownload size={15} />}
              iconBg="bg-sky-500/10 text-sky-500"
              title={t("profile.wifi_only")}
              description={t("profile.wifi_only_desc")}
              action={
                <Toggle
                  on={wifiOnlyDl}
                  onChange={(enabled) => {
                    setWifiOnlyDl(enabled);
                    setWifiOnlyDownloadEnabled(enabled);
                    toast(enabled ? "Download on Wi-Fi Only enabled" : "Cellular downloads allowed", "info");
                  }}
                  label={t("profile.wifi_only")}
                />
              }
            />

            <SettingItem
              icon={<IDownload size={15} />}
              iconBg="bg-teal-500/10 text-teal-500"
              title={t("profile.auto_dl_next")}
              description={t("profile.auto_dl_next_desc")}
              action={
                <Toggle
                  on={smartDl}
                  onChange={(enabled) => {
                    setSmartDl(enabled);
                    setSmartDownloadEnabled(enabled);
                    toast(enabled ? "Smart Auto-Download enabled" : "Smart Auto-Download disabled", "info");
                  }}
                  label={t("profile.auto_dl_next")}
                />
              }
            />

            <SettingItem
              icon={<IDownload size={15} />}
              iconBg="bg-cyan-500/10 text-cyan-500"
              title="Background Download Alerts"
              description="Live progress and controls in Android notification shade"
              action={
                <Toggle
                  on={downloadNotifs}
                  onChange={(enabled) => {
                    setDownloadNotifs(enabled);
                    setDownloadNotificationEnabled(enabled);
                    toast(enabled ? "Download notifications enabled" : "Download notifications disabled", "info");
                  }}
                  label="Background Download Alerts"
                />
              }
            />
          </SettingsSection>

          {/* Section 5: Streaming Network & Line Selection */}
          <SettingsSection title={t("settings.network")} subtitle="Route selection, security boundaries, and diagnostics">
            <ProxySettings />

            <SettingItem
              icon={<IBoltF size={15} />}
              iconBg="bg-amber-500/10 text-amber-500"
              title="Streaming Source"
              description={lineBase ? hostOf(lineBase) : "Loading..."}
              hasChevron
              onClick={() => setLineOpen(true)}
              badge={
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10.5px] font-semibold flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Active
                </span>
              }
            />

            <SettingItem
              icon={<IRefresh size={15} />}
              iconBg="bg-blue-500/10 text-blue-500"
              title="Auto-Select Best Line"
              description="Automatically discovers responsive mirrors when official route slows down"
              action={
                <Toggle
                  label="Auto-Select Best Line"
                  on={autoLineOn}
                  onChange={async (on) => {
                    setAutoLineOn(on);
                    try {
                      await setAutoLine(on);
                      toast(on ? "Auto-select line enabled" : "Auto-select line disabled, manual preserved", "info");
                    } catch {
                      setAutoLineOn(!on);
                      toast("Failed to update auto-select line", "info");
                    }
                  }}
                />
              }
            />

            <SettingItem
              icon={<ILockF size={15} />}
              iconBg="bg-violet-500/10 text-violet-500"
              title="Strict Security Mode"
              description={
                cliRelaxed
                  ? "Running in compatibility mode via --no-strict"
                  : "Guards against upstream tampering and intranet probing"
              }
              action={
                <Toggle
                  on={strictSecurity}
                  disabled={!strictSecurityReady || securityPending}
                  onChange={(on) => {
                    void setStrictSecurity(on)
                      .then(() => toast(on ? "Strict security enabled" : "Compatibility mode enabled", "info"))
                      .catch(() => toast("Failed to save security mode", "info"));
                  }}
                  label="Strict Security Mode"
                />
              }
            />

            <SettingItem
              icon={<ILink size={15} />}
              iconBg="bg-slate-500/10 text-slate-500"
              title={diagnosing ? "Diagnosing Network..." : "Network Diagnostics"}
              description="Checks DNS resolution, TCP handshakes, proxies, and latency"
              hasChevron
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
                    toast("Diagnostics completed, copy report below", "info");
                  }
                } catch (e) {
                  const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "Retry later";
                  toast(`Diagnostics error: ${detail}`, "info");
                } finally {
                  setDiagnosing(false);
                }
              }}
            />
          </SettingsSection>

          {/* Section 6: Android Permissions & Execution */}
          {androidPerms !== null && (
            <SettingsSection
              title="Permissions & Background"
              subtitle="Android OS battery, notification, and package permissions"
            >
              <SettingItem
                icon={<IBoltF size={15} />}
                iconBg="bg-amber-500/10 text-amber-500"
                title="Unrestricted Background Downloads"
                description="Prevents system from pausing active downloads when app is backgrounded"
                hasChevron
                badge={
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                      androidPerms.batteryOptimizationIgnored
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {androidPerms.batteryOptimizationIgnored ? "Granted" : "Action Needed"}
                  </span>
                }
                onClick={() => {
                  window.AuraNativeExport?.requestIgnoreBatteryOptimizations?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
              />

              <SettingItem
                icon={<IDownload size={15} />}
                iconBg="bg-blue-500/10 text-blue-500"
                title="Download Notifications"
                description="Shows speed, progress bar, and Pause/Cancel in status bar"
                hasChevron
                badge={
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                      androidPerms.notificationsGranted
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {androidPerms.notificationsGranted ? "Granted" : "Action Needed"}
                  </span>
                }
                onClick={() => {
                  window.AuraNativeExport?.requestNotificationPermissionNow?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
              />

              <SettingItem
                icon={<IRefresh size={15} />}
                iconBg="bg-teal-500/10 text-teal-500"
                title="In-App Updates (Install APKs)"
                description="Required to install new GitHub OTA updates inside the app"
                hasChevron
                badge={
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                      androidPerms.canInstallPackages
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {androidPerms.canInstallPackages ? "Granted" : "Action Needed"}
                  </span>
                }
                onClick={() => {
                  window.AuraNativeExport?.openInstallPermissionSettings?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
              />

              <SettingItem
                icon={<IInfo size={15} />}
                iconBg="bg-indigo-500/10 text-indigo-500"
                title="Storage & Gallery Export"
                description="Saves offline episodes to Movies/AuraStream or Download/AuraStream"
                hasChevron
                badge={
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10.5px] font-bold ${
                      androidPerms.storageGranted
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {androidPerms.storageGranted ? "Granted" : "Action Needed"}
                  </span>
                }
                onClick={() => {
                  if (androidPerms.storageGranted) {
                    toast("Media & Downloads export permission is active", "ok");
                    return;
                  }
                  window.AuraNativeExport?.requestLegacyStoragePermission?.();
                  window.setTimeout(() => setAndroidPerms(getAndroidPermissionsStatus()), 400);
                }}
              />

              <SettingItem
                icon={<ISettings size={15} />}
                iconBg="bg-neutral-500/10 text-neutral-500"
                title="Open Android App Settings"
                description="Manage battery, notifications, and permissions in system settings"
                hasChevron
                onClick={() => {
                  window.AuraNativeExport?.openAppSettings?.();
                }}
              />
            </SettingsSection>
          )}

          {/* Section 7: Storage & Maintenance */}
          <SettingsSection title="Storage & Data" subtitle="Cache management, device memory, and saved items">
            <SettingItem
              icon={<IHeart size={15} />}
              iconBg="bg-pink-500/10 text-pink-500"
              title="Local Library Data"
              description={`${favs.length} favorites · ${history.length} watch history entries`}
              badge={<span className="text-[11.5px] text-mut font-mono">Protected</span>}
            />

            <SettingItem
              icon={<IBoltF size={15} />}
              iconBg="bg-amber-500/10 text-amber-500"
              title={purgingRam ? "Optimizing Memory..." : "Optimize Memory & Temp Buffers"}
              description="Purges inactive preloaded buffers and frees RAM while keeping all downloads"
              hasChevron
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
            />

            <SettingItem
              icon={<IBroom size={15} />}
              iconBg="bg-rose-500/10 text-rose-500"
              title={t("settings.clear_cache")}
              description={t("settings.clear_cache_desc")}
              hasChevron
              onClick={() => setClearOpen(true)}
            />
          </SettingsSection>

          {/* Section 8: Diagnostics & Support */}
          <SettingsSection title="Playback Diagnostics" subtitle="Troubleshooting logs and performance telemetry">
            <SettingItem
              icon={<IInfo size={15} />}
              iconBg="bg-blue-500/10 text-blue-500"
              title="Playback Diagnostics Log"
              description="Records version, platform, current line, and stream events for support"
              action={
                <Toggle
                  label="Playback Diagnostics Log"
                  on={playbackLog.enabled}
                  disabled={!playbackLog.ready || playbackLog.pending}
                  onChange={(on) => {
                    void setPlaybackLog(on)
                      .then(() => toast(on ? "Playback diagnostics enabled" : "Playback diagnostics disabled", "ok"))
                      .catch(() => toast("Failed to save log config", "info"));
                  }}
                />
              }
            />

            <SettingItem
              icon={<ILink size={15} />}
              iconBg="bg-sky-500/10 text-sky-500"
              title={copyingLog ? "Copying Diagnostics..." : "Copy Playback Diagnostics"}
              description={`Includes version, platform, active line, and errors${playbackLog.path ? ` · ${playbackLog.path}` : ""}`}
              hasChevron
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
            />
          </SettingsSection>

          {/* Section 9: About & Updates */}
          <SettingsSection title="About & Updates" subtitle="Version details, licensing, and updates">
            <SettingItem
              icon={<IRefresh size={15} />}
              iconBg="bg-emerald-500/10 text-emerald-500"
              title="Auto-Check for Updates"
              description="Check GitHub Releases on startup when online"
              action={
                <Toggle
                  label="Auto-Check for Updates"
                  on={autoUpdateOn}
                  onChange={(on) => {
                    setAutoUpdateOn(on);
                    setAutoUpdateCheckEnabled(on);
                    toast(on ? "Auto-check for updates enabled" : "Auto-check for updates disabled", "info");
                  }}
                />
              }
            />

            <SettingItem
              icon={<IRefresh size={15} />}
              iconBg="bg-cyan-500/10 text-cyan-500"
              title="Check for Updates"
              description={
                checking
                  ? "Checking GitHub Releases..."
                  : isAndroidNativeOtaSupported()
                  ? `Current v${APP_VERSION} · In-app GitHub OTA`
                  : `Current v${APP_VERSION} · Compare with GitHub Release`
              }
              hasChevron
              disabled={checking}
              onClick={() => {
                if (otaRuntime.stage === "downloading" && availableUpdate?.has_update) {
                  setUpdate(availableUpdate);
                  return;
                }
                void checkUpdate();
              }}
              badge={
                otaRuntime.stage === "downloading" && availableUpdate?.has_update ? (
                  <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-mono text-[11px] font-bold border border-primary/25">
                    {otaRuntime.progress}%
                  </span>
                ) : availableUpdate?.has_update ? (
                  <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary font-mono text-[11px] font-bold border border-primary/25">
                    v{availableUpdate.latest} Ready
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-s2 text-primary font-mono text-[11px] font-semibold">
                    v{APP_VERSION}
                  </span>
                )
              }
            />

            <SettingItem
              icon={<IInfo size={15} />}
              iconBg="bg-indigo-500/10 text-indigo-500"
              title={t("settings.about")}
              description="Version, licensing terms, and project information"
              hasChevron
              onClick={() => setAbout(true)}
            />
          </SettingsSection>

          {/* Clean App Signature Footer */}
          <div className="text-center text-[11.5px] text-dim/80 py-4 leading-relaxed">
            AuraStream v{APP_VERSION} ({platform === "android" ? "Android" : platform === "ios" ? "iOS" : "Mobile Client"})
            <div className="text-[10.5px] text-dim/60 mt-0.5">This App Created by AAA. All rights reserved.</div>
          </div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      {/* Network Diagnostics Report Fallback Modal */}
      <Modal open={diagReport !== null} onClose={() => setDiagReport(null)} width={520} label="Network Diagnostics Report">
        <div className="p-5">
          <h2 className="text-[15px] font-bold text-on">Network Diagnostics Report</h2>
          <p className="text-[12.5px] text-mut mt-1.5">Diagnostics completed. Automatic clipboard copy was blocked. You can copy the diagnostic details below.</p>
          <TextArea
            readOnly
            aria-label="Network diagnostics report"
            value={diagReport ?? ""}
            className="w-full h-56 mt-3 p-3 rounded-xl bg-s3 text-[11.5px] font-mono text-on resize-none border border-edge/30"
          />
          <div className="flex gap-2.5 mt-4">
            <Button onClick={() => setDiagReport(null)} className="flex-1 h-9 rounded-xl bg-s3 text-[13.5px] text-on pressable">
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
                  toast("Copy failed, please select text manually", "info");
                } finally {
                  setCopyingReport(false);
                }
              }}
              className="flex-1 h-9 rounded-xl brand-grad text-[13.5px] text-on-primary font-medium pressable disabled:opacity-60"
            >
              {copyingReport ? "Copying..." : "Copy Report"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* About Modal */}
      <Modal open={about} onClose={() => setAbout(false)} width={390} label={t("settings.about")}>
        <div className="p-5">
          <div className="flex items-center gap-3.5">
            <span className="w-11 h-11 shrink-0 rounded-2xl brand-grad shadow-md flex items-center justify-center text-on-primary text-[17px] font-black">
              A
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-bold text-on leading-tight">AuraStream</div>
              <div className="text-[11.5px] text-mut mt-0.5 leading-snug">v{APP_VERSION} · This App Created by AAA. All rights reserved.</div>
            </div>
          </div>

          <p className="text-[12.5px] text-on/80 leading-relaxed mt-3.5">
            Modern mobile streaming media client built with Rust and Tauri 2, featuring an immersive mobile-first feed, hardware-accelerated offline downloads, and high-performance playback.
          </p>

          <Surface className="mt-3.5 rounded-xl bg-s3/60 p-3 text-[11.5px] text-mut leading-relaxed border border-edge/20">
            This project is provided for research and personal use. All content is fetched live from upstream video endpoints; the client does not store or distribute copyrighted material.
          </Surface>

          <div className="mt-4 divide-y divide-s3/60">
            <Button
              onClick={() => {
                api.openUrl("https://github.com/cozgams/AuraStream").catch(() => {
                  copyText("https://github.com/cozgams/AuraStream")
                    .then(() => toast("Repository URL copied", "ok"))
                    .catch(() => {});
                });
              }}
              className="w-full flex items-center gap-2.5 py-2.5 text-left pressable"
            >
              <ILink size={15} className="text-primary shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-on/85">github.com/cozgams/AuraStream</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-primary font-medium whitespace-nowrap">Open</span>
            </Button>
            <div className="flex items-center gap-2.5 py-2.5">
              <IInfo size={15} className="text-mut shrink-0" />
              <span className="min-w-0 flex-1 text-[12.5px] text-on/85 whitespace-nowrap truncate">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-mut whitespace-nowrap">License</span>
            </div>
          </div>

          <Button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-xl bg-s3 text-[13.5px] text-on font-medium pressable">
            Close
          </Button>
        </div>
      </Modal>

      {/* Clear Cache Modal */}
      <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330} label="Clear Cache">
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">Clear Cache</div>
          <p className="text-[12.5px] text-mut leading-relaxed mt-2">
            Clears cover thumbnails and decrypted stream manifests. Favorites, watch history, offline downloads, and login state are completely preserved.
          </p>
          <div className="flex gap-2.5 mt-5">
            <Button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-xl bg-s3 text-[13.5px] text-on/80 pressable">
              Cancel
            </Button>
            <Button
              disabled={clearing}
              onClick={async () => {
                setClearing(true);
                try {
                  await api.clearCache();
                  clearSubtitleCache();
                  setClearOpen(false);
                  toast(t("settings.cache_cleared"), "ok");
                } catch (e) {
                  toast((e as Error)?.message || "Failed to clear cache", "info");
                } finally {
                  setClearing(false);
                }
              }}
              className="flex-1 h-9 rounded-xl bg-primary text-[13.5px] font-semibold text-on-primary pressable disabled:opacity-60"
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
