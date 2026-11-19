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
import { IBack, IBoltF, IBroom, ICaptionsF, IChevR, IClock, IDownload, IHeart, IInfo, ILink, ILockF, IMoon, IRefresh, ISun, IVolMute } from "../icons";
import { getSubtitleStyleConfig, setSubtitleStyleConfig } from "../subtitles/aiSubtitleService";
import type { SubtitleStyleConfig } from "../subtitles/types";
import { getDownloadQualityPreference, setDownloadQualityPreference, type DownloadQuality } from "../offline/downloadService";

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
  const [updating, setUpdating] = useState("");
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);
  const [subStyle, setSubStyle] = useState<SubtitleStyleConfig>(() => getSubtitleStyleConfig());
  const [downloadQuality, setDownloadQuality] = useState<DownloadQuality>(() => getDownloadQualityPreference());

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

  const doUpdate = async () => {
    if (!update) return;
    setUpdating("Opening...");
    try {
      await api.openUrl(update.url);
    } catch (e) {
      await copyText(update.url)
        .then(() => toast("Download link copied to clipboard", "ok"))
        .catch((err) => toast(errorMessage(err, "Failed to open link"), "info"));
    } finally {
      setUpdating("");
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 pt-3 pb-4" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <Button onClick={onBack} aria-label={t("common.back")} className="ios-icon-button mb-3">
          <IBack size={20} />
        </Button>
        <h1 className="ios-page-title text-on">{t("settings.title")}</h1>
        <p className="text-[13px] text-mut mt-2">Customize your AuraStream experience</p>
      </div>

      <div className="ios-page-body flex-1 scroll-y px-4 pt-1 pb-10">
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
          </Section>

          {/* Storage & Data */}
          <Section title="Storage & Data">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IHeart size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">Local Library</div>
                <div className="text-[12px] text-mut">{favs.length} favorites · {history.length} watch history items</div>
              </div>
            </div>
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
                onChange={(on) => {
                  void setAutoLine(on).catch(() => toast("Failed to pause auto line, please retry", "info"));
                  setAutoLineOn(on);
                  toast(on ? "Auto-select line enabled" : "Auto-select line disabled, manual selection preserved", "info");
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
            <Button onClick={checkUpdate} disabled={checking} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><IRefresh size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">Check for Updates</div>
                <div className="text-[12px] text-mut">{checking ? "Checking..." : `Current v${APP_VERSION} · Compare with GitHub Release`}</div>
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
      <Modal open={diagReport !== null} onClose={() => setDiagReport(null)} width={520}>
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
      <Modal open={about} onClose={() => setAbout(false)} width={392}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">
              A
            </span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">AuraStream</div>
              <div className="text-[12px] text-mut mt-0.5">AuraStream Client v{APP_VERSION} · Created by AAA</div>
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
      <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330}>
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

      {/* Update Modal */}
      <Modal open={!!update?.has_update} onClose={() => setUpdate(null)} width={392}>
        <div className="p-5">
          <div className="text-[16px] font-bold text-on">New Version Available</div>
          <p className="text-[12px] text-mut mt-1.5">
            v{update?.current} → <b className="text-on">v{update?.latest}</b>
            {update?.published_at ? ` · ${update.published_at.slice(0, 10)}` : ""}
          </p>
          {!!update?.notes && (
            <Surface className="mt-3 max-h-[180px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[12px] text-mut whitespace-pre-wrap leading-relaxed">
              {update.notes}
            </Surface>
          )}
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => setUpdate(null)}
              disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable disabled:opacity-60"
            >
              Later
            </Button>
            <Button
              onClick={() => void doUpdate()}
              disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60"
            >
              {updating || "Download"}
            </Button>
          </div>
          <div className="text-[12px] text-dim mt-2.5 break-all">{update?.url}</div>
        </div>
      </Modal>
    </div>
  );
}
