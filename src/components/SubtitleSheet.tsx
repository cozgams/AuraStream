import React, { useEffect, useRef, useState } from "react";
import { Sheet } from "./ios/overlays";
import { Button } from "./ios/controls";
import { IBan, ICheck, IClose, ICaptionsF, IFileText, ILangEn, IRefresh, ISparkles, ITrash } from "../icons";
import type {
  AICaptionConfig,
  SubtitleMode,
  SubtitlePosition,
  SubtitleSize,
  SubtitleStyleConfig,
  SubtitleTrackStatus,
} from "../subtitles/types";
import { useStore } from "../store";
import { processSubtitleExport } from "../offline/exportService";
import {
  getAICaptionConfig,
  getSubtitleStyleConfig,
  importSubtitleTextForEpisode,
  removeSubtitleTrackForEpisode,
  setAICaptionConfig,
  setSubtitleStyleConfig,
  transcribeEpisodeWithAI,
} from "../subtitles/aiSubtitleService";

type Props = {
  open: boolean;
  onClose: () => void;
  mode: SubtitleMode;
  onModeChange: (m: SubtitleMode) => void;
  size: SubtitleSize;
  onSizeChange: (s: SubtitleSize) => void;
  videoId?: number;
  episode?: number;
  title?: string;
  streamUrl?: string;
  trackInfo?: SubtitleTrackStatus;
};

export default function SubtitleSheet({
  open,
  onClose,
  mode,
  onModeChange,
  size,
  onSizeChange,
  videoId,
  episode,
  title,
  streamUrl,
  trackInfo,
}: Props) {
  const { t, toast } = useStore();
  const [styleConfig, setStyleConfig] = useState<SubtitleStyleConfig>(() => getSubtitleStyleConfig());
  const [aiConfig, setAiConfig] = useState<AICaptionConfig>(() => getAICaptionConfig());
  const [aiExpanded, setAiExpanded] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStyleConfig(getSubtitleStyleConfig());
      setAiConfig(getAICaptionConfig());
    }
  }, [open]);

  const applyPreset = (preset: "yellow" | "white" | "cyan" | "green" | "solid") => {
    let updated: SubtitleStyleConfig;
    if (preset === "yellow") {
      updated = { ...styleConfig, color: "yellow", edgeStyle: "drop_shadow", font: "sans", bgStyle: "translucent", bgOpacity: 75 };
    } else if (preset === "white") {
      updated = { ...styleConfig, color: "white", edgeStyle: "drop_shadow", font: "sans", bgStyle: "translucent", bgOpacity: 75 };
    } else if (preset === "cyan") {
      updated = { ...styleConfig, color: "cyan", edgeStyle: "uniform", font: "sans", bgStyle: "translucent", bgOpacity: 85 };
    } else if (preset === "green") {
      updated = { ...styleConfig, color: "green", edgeStyle: "drop_shadow", font: "sans", bgStyle: "translucent", bgOpacity: 85 };
    } else {
      updated = { ...styleConfig, color: "white", edgeStyle: "none", font: "sans", bgStyle: "solid", bgOpacity: 100 };
    }
    setStyleConfig(updated);
    setSubtitleStyleConfig(updated);
  };

  const onPositionPreset = (pos: SubtitlePosition, defaultPct: number) => {
    const updated: SubtitleStyleConfig = {
      ...styleConfig,
      position: pos,
      customOffsetPercent: defaultPct,
    };
    setStyleConfig(updated);
    setSubtitleStyleConfig(updated);
  };

  const onSliderChange = (newPct: number) => {
    const clamped = Number.isFinite(newPct) ? Math.max(5, Math.min(90, Math.round(newPct))) : 12;
    const updated: SubtitleStyleConfig = {
      ...styleConfig,
      position: "custom",
      customOffsetPercent: clamped,
    };
    setStyleConfig(updated);
    setSubtitleStyleConfig(updated);
  };

  const updateOffsetSec = (nextOffset: number) => {
    const clamped = Math.max(-5, Math.min(5, Math.round(nextOffset * 100) / 100));
    const updated: SubtitleStyleConfig = {
      ...styleConfig,
      offsetSec: clamped,
    };
    setStyleConfig(updated);
    setSubtitleStyleConfig(updated);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || videoId == null || episode == null) return;
    try {
      const rawText = await file.text();
      const imported = importSubtitleTextForEpisode(videoId, episode, rawText, file.name);
      if (mode === "off") onModeChange("en");
      toast(`Loaded ${imported.cues.length} subtitle lines from ${file.name}`, "ok");
    } catch (err) {
      toast((err as Error)?.message || "Failed to parse subtitle file", "info");
    }
  };

  const handleAiTranscribe = async () => {
    if (videoId == null || episode == null) return;
    setAiConfig(aiConfig);
    setAICaptionConfig(aiConfig);
    setTranscribing(true);
    setTranscribeStatus("Preparing episode stream...");
    try {
      const track = await transcribeEpisodeWithAI(videoId, episode, streamUrl || "", setTranscribeStatus);
      if (mode === "off") onModeChange("en");
      toast(`Generated ${track.cues.length} synced subtitle lines`, "ok");
      setTranscribeStatus("");
    } catch (err) {
      toast((err as Error)?.message || "AI transcription failed", "info");
      setTranscribeStatus("");
    } finally {
      setTranscribing(false);
    }
  };

  const hasRealTrack = Boolean(trackInfo?.hasTrack && trackInfo.cueCount > 0 && trackInfo.source !== "none");
  const trackSourceLabel = (() => {
    switch (trackInfo?.source) {
      case "local_import":
        return "Imported File";
      case "upstream_vtt":
      case "native_track":
      case "offline_download":
        return "Embedded Stream CC";
      case "ai_gemini":
        return "Gemini AI Track";
      case "ai_whisper":
        return "Whisper AI Track";
      case "cache":
        return "Cached Track";
      default:
        return "No Embedded Subtitles";
    }
  })();

  const canRemoveTrack =
    hasRealTrack &&
    (trackInfo?.source === "local_import" ||
      trackInfo?.source === "ai_gemini" ||
      trackInfo?.source === "ai_whisper" ||
      trackInfo?.source === "cache");

  const modes: Array<{ id: SubtitleMode; label: string; desc: string; icon: React.ReactNode }> = [
    {
      id: "en",
      label: "Captions On",
      desc: "Show real or imported English captions",
      icon: <ILangEn size={22} className="text-amber-500" />,
    },
    {
      id: "off",
      label: "Captions Off",
      desc: "Hide all overlay captions during playback",
      icon: <IBan size={20} className="text-mut" />,
    },
  ];

  const sizes: Array<{ id: SubtitleSize; label: string; px: string }> = [
    { id: "sm", label: "Small", px: "13px" },
    { id: "md", label: "Standard", px: "15px" },
    { id: "lg", label: "Large", px: "17px" },
    { id: "xl", label: "XL", px: "20px" },
  ];

  const positions: Array<{ id: SubtitlePosition; label: string; desc: string; defaultPct: number }> = [
    { id: "bottom", label: "Downside", desc: "Active video anchor", defaultPct: 12 },
    { id: "above_title", label: "Above Title", desc: "Clear of controls", defaultPct: 32 },
    { id: "middle", label: "Middle", desc: "Center screen", defaultPct: 50 },
    { id: "top", label: "Top", desc: "Upper screen third", defaultPct: 85 },
  ];

  const colorMap = {
    white: "#FFFFFF",
    yellow: "#FFE600",
    cyan: "#00E5FF",
    green: "#76FF03",
  };
  const previewTextColor = colorMap[styleConfig.color] || "#FFFFFF";
  const edgeShadowMap = {
    drop_shadow: "0 1px 3px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)",
    raised: "1px 1px 0px #000",
    depressed: "-1px -1px 0px #000",
    uniform: "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
    none: "none",
  };
  const previewShadow = edgeShadowMap[styleConfig.edgeStyle] || edgeShadowMap.drop_shadow;
  const previewBg =
    styleConfig.bgStyle === "solid"
      ? "#000000"
      : styleConfig.bgStyle === "none"
      ? "transparent"
      : `rgba(10, 10, 12, ${(styleConfig.bgOpacity ?? 75) / 100})`;

  const previewFontSize = {
    sm: "text-[13px]",
    md: "text-[15px]",
    lg: "text-[17px]",
    xl: "text-[19px]",
  }[size] || "text-[15px]";

  const currentPosition = styleConfig.position || "bottom";
  const rawPercent =
    typeof styleConfig.customOffsetPercent === "number" && Number.isFinite(styleConfig.customOffsetPercent)
      ? styleConfig.customOffsetPercent
      : currentPosition === "top"
      ? 85
      : currentPosition === "middle"
      ? 50
      : currentPosition === "above_title"
      ? 32
      : 12;
  const currentPercent = Math.max(5, Math.min(90, Math.round(rawPercent)));
  const currentOffsetSec = styleConfig.offsetSec || 0;

  return (
    <Sheet open={open} onClose={onClose} label={t("captions.title")}>
      <div className="p-4 sm:p-5 pb-4 flex flex-col gap-3.5 text-on max-h-[82dvh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 flex items-center justify-center text-amber-600">
              <ICaptionsF size={20} />
            </div>
            <div>
              <h2 className="text-[17px] font-bold leading-tight text-on">Closed Captions (CC)</h2>
              <p className="text-[12px] text-mut">Stream tracks, .SRT / .VTT files & AI captions</p>
            </div>
          </div>
          <Button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-s3 hover:bg-s4/20 flex items-center justify-center text-on/70 hover:text-on pressable"
            aria-label={t("common.close")}
          >
            <IClose size={16} />
          </Button>
        </div>

        {/* Active Track Status & Import Card */}
        {videoId != null && episode != null && (
          <div
            className={`p-3 rounded-2xl border flex flex-col gap-2.5 ${
              hasRealTrack
                ? "bg-emerald-500/10 border-emerald-500/30"
                : "bg-s2 border-border"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      hasRealTrack ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                  />
                  <span className="text-[13px] font-bold text-on">{trackSourceLabel}</span>
                  {hasRealTrack && (
                    <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                      · {trackInfo?.cueCount} lines
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] text-mut mt-0.5 leading-snug truncate">
                  {hasRealTrack
                    ? trackInfo?.fileName || `Episode ${episode} active subtitle track`
                    : "This video has no embedded subtitle track. Load an .SRT / .VTT file or transcribe below."}
                </p>
              </div>
              {canRemoveTrack && (
                <button
                  type="button"
                  onClick={() => {
                    removeSubtitleTrackForEpisode(videoId, episode);
                    toast("Subtitle track removed", "info");
                  }}
                  className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[11px] font-bold flex items-center gap-1 shrink-0 pressable"
                >
                  <ITrash size={12} />
                  <span>Remove</span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip,text/plain"
              className="hidden"
              onChange={handleImportFile}
            />

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-3 rounded-xl bg-white dark:bg-neutral-800 border border-border text-[12px] font-bold text-on flex items-center justify-center gap-1.5 pressable shadow-xs"
              >
                <IFileText size={14} className="text-amber-500" />
                <span>Load .SRT / .VTT</span>
              </Button>
              <Button
                type="button"
                onClick={() => setAiExpanded((v) => !v)}
                className="h-9 px-3 rounded-xl bg-white dark:bg-neutral-800 border border-border text-[12px] font-bold text-on flex items-center justify-center gap-1.5 pressable shadow-xs"
              >
                <ISparkles size={14} className="text-primary" />
                <span>{aiExpanded ? "Hide AI Setup" : "AI Transcribe"}</span>
              </Button>
            </div>

            {aiExpanded && (
              <div className="pt-2 border-t border-border/60 flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ["gemini", "Gemini 2.5 Flash"],
                      ["whisper", "OpenAI Whisper"],
                    ] as const
                  ).map(([prov, label]) => {
                    const selected = aiConfig.provider === prov || (aiConfig.provider === "none" && prov === "gemini");
                    return (
                      <button
                        key={prov}
                        type="button"
                        onClick={() => {
                          const next = { ...aiConfig, provider: prov };
                          setAiConfig(next);
                          setAICaptionConfig(next);
                        }}
                        className={`h-8 rounded-lg border text-[11.5px] font-bold transition-all ${
                          selected
                            ? "bg-primary/15 border-primary text-primary"
                            : "bg-s3 border-border text-mut"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="password"
                  value={
                    aiConfig.provider === "whisper"
                      ? aiConfig.whisperKey || ""
                      : aiConfig.geminiKey || ""
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    const activeProv = aiConfig.provider === "whisper" ? "whisper" : "gemini";
                    const next: AICaptionConfig =
                      activeProv === "whisper"
                        ? { ...aiConfig, provider: "whisper", whisperKey: val }
                        : { ...aiConfig, provider: "gemini", geminiKey: val };
                    setAiConfig(next);
                    setAICaptionConfig(next);
                  }}
                  placeholder={
                    aiConfig.provider === "whisper"
                      ? "Paste OpenAI API key (sk-...)"
                      : "Paste Google Gemini API key (AIza...)"
                  }
                  className="h-9 px-3 rounded-xl bg-bg border border-border text-[12px] text-on placeholder:text-mut outline-none focus:border-primary"
                />
                <Button
                  type="button"
                  disabled={transcribing}
                  onClick={() => void handleAiTranscribe()}
                  className="h-9 rounded-xl bg-primary text-on-primary text-[12px] font-bold flex items-center justify-center gap-1.5 pressable disabled:opacity-60"
                >
                  <ISparkles size={13} />
                  <span>{transcribing ? (transcribeStatus || "Transcribing...") : "Transcribe Current Episode"}</span>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Live Interactive Preview Box */}
        {mode !== "off" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-mut">
              <span>Live Caption Preview</span>
              <span className="text-amber-500 font-semibold lowercase">
                {currentPosition} ({currentPercent}%) · {size}
              </span>
            </div>
            <div className="h-28 rounded-2xl bg-gradient-to-br from-neutral-900 to-black flex flex-col justify-end p-2.5 relative overflow-hidden shadow-inner border border-white/10 select-none">
              <div className="absolute top-2 inset-x-3 flex justify-between text-[8px] text-white/30 font-mono">
                <span>TOP (85%)</span>
                <span>SAFE FRAME</span>
              </div>
              <div className="absolute inset-x-3 border-b border-dashed border-white/10" style={{ top: "50%" }}>
                <span className="text-[8px] text-white/20 font-mono">MIDDLE (50%)</span>
              </div>
              <div className="absolute bottom-2 inset-x-3 flex justify-between text-[8px] text-white/30 font-mono">
                <span>DOWNSIDE (12%)</span>
                <span>CONTROLS</span>
              </div>
              <div
                className="absolute inset-x-0 flex items-center justify-center px-4 transition-all duration-150 pointer-events-none"
                style={{
                  bottom: `${Math.max(8, Math.min(88, currentPercent))}%`,
                  transform: `translateY(${Math.round(Math.max(0, Math.min(100, ((currentPercent - 10) / 75) * 100)))}%)`,
                }}
              >
                <div
                  className={`font-semibold text-center px-3 py-1 rounded-md shadow-[0_2px_8px_rgba(0,0,0,0.85)] transition-all leading-snug max-w-[90%] ${previewFontSize}`}
                  style={{
                    color: previewTextColor,
                    textShadow: previewShadow,
                    backgroundColor: previewBg,
                  }}
                >
                  "Never let go of what matters most."
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Subtitle Mode Selection */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
            Caption Display
          </span>
          <div className="grid grid-cols-2 gap-2">
            {modes.map((item) => {
              const active = mode === item.id;
              return (
                <Button
                  key={item.id}
                  type="button"
                  data-card={true}
                  style={{ borderRadius: 14 }}
                  onClick={() => onModeChange(item.id)}
                  className={`flex flex-col items-start p-3 rounded-[14px] border text-left pressable transition-all relative ${
                    active
                      ? "bg-amber-500/10 border-amber-500/40 text-on shadow-xs ring-1 ring-amber-500/30"
                      : "bg-white dark:bg-neutral-800/80 border-border text-on/80 hover:bg-s2"
                  }`}
                >
                  <div className="flex items-center justify-between w-full mb-1">
                    <span className="text-xl">{item.icon}</span>
                    {active && (
                      <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center text-white shadow-xs">
                        <ICheck size={12} strokeWidth={2.8} />
                      </div>
                    )}
                  </div>
                  <div className="text-[13.5px] font-bold text-on">{item.label}</div>
                  <div className="text-[11px] text-mut leading-tight mt-0.5">{item.desc}</div>
                </Button>
              );
            })}
          </div>
        </div>

        {/* Timing Sync Offset */}
        {mode !== "off" && (
          <div className="flex items-center justify-between p-3 rounded-2xl bg-s2 border border-border gap-2">
            <div>
              <div className="text-[12.5px] font-bold text-on">Timing Sync Offset</div>
              <div className="text-[10.5px] text-mut">Adjust if dialogue leads or lags captions</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => updateOffsetSec(currentOffsetSec - 0.25)}
                className="px-2 py-1 rounded-lg bg-s3 border border-border text-[11px] font-bold text-on pressable"
              >
                -0.25s
              </button>
              <button
                type="button"
                onClick={() => updateOffsetSec(0)}
                className="px-2 py-1 rounded-lg bg-white dark:bg-neutral-900 border border-border text-[11px] font-mono font-bold text-amber-500 min-w-[54px] text-center pressable"
                title="Reset offset to 0.00s"
              >
                {currentOffsetSec > 0 ? `+${currentOffsetSec.toFixed(2)}s` : `${currentOffsetSec.toFixed(2)}s`}
              </button>
              <button
                type="button"
                onClick={() => updateOffsetSec(currentOffsetSec + 0.25)}
                className="px-2 py-1 rounded-lg bg-s3 border border-border text-[11px] font-bold text-on pressable"
              >
                +0.25s
              </button>
            </div>
          </div>
        )}

        {/* Vertical Position Selection & Fine-Tuning Slider */}
        {mode !== "off" && (
          <div className="flex flex-col gap-2 pt-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
                Screen Position & Offset
              </span>
              <span className="text-[11px] font-bold text-amber-500 font-mono">
                {currentPercent}% from bottom
              </span>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {positions.map((p) => {
                const active = currentPosition === p.id;
                return (
                  <Button
                    key={p.id}
                    type="button"
                    data-card={true}
                    style={{ borderRadius: 12 }}
                    onClick={() => onPositionPreset(p.id, p.defaultPct)}
                    className={`flex flex-col items-center justify-center py-2 px-1 rounded-[12px] border pressable transition-all ${
                      active
                        ? "bg-white dark:bg-neutral-900 text-on border-amber-500/60 shadow-xs ring-1 ring-amber-500/30 font-bold"
                        : "bg-s2 border-border text-on/80 hover:bg-s3"
                    }`}
                  >
                    <span className="text-[12px] font-bold">{p.label}</span>
                    <span className="text-[9.5px] text-mut leading-tight mt-0.5">{p.desc}</span>
                  </Button>
                );
              })}
            </div>

            <div className="p-3 rounded-2xl bg-s2 border border-border flex flex-col gap-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-semibold text-on flex items-center gap-1.5">
                  <span>Custom Vertical Height</span>
                  {currentPosition === "custom" && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-500">
                      Custom
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => onPositionPreset("bottom", 12)}
                  className="text-amber-500 hover:text-amber-400 text-[11px] font-semibold flex items-center gap-1 pressable"
                >
                  <IRefresh size={11} /> Reset Downside
                </button>
              </div>
              <input
                type="range"
                min={5}
                max={90}
                step={1}
                value={currentPercent}
                onChange={(e) => onSliderChange(Number(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer h-2 bg-s4 rounded-lg"
                aria-label="Subtitle Vertical Position Slider"
              />
              <div className="flex justify-between text-[10px] text-mut font-medium">
                <span>5% (Downside)</span>
                <span>32% (Above Title)</span>
                <span>50% (Center)</span>
                <span>90% (Top)</span>
              </div>
            </div>
          </div>
        )}

        {/* Subtitle Font Size Selection */}
        {mode !== "off" && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
              Font Size & Scale
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {sizes.map((s) => {
                const active = size === s.id;
                return (
                  <Button
                    key={s.id}
                    type="button"
                    data-card={true}
                    style={{ borderRadius: 12 }}
                    onClick={() => onSizeChange(s.id)}
                    className={`h-9 rounded-[12px] border text-[12px] font-bold flex items-center justify-center gap-1 pressable transition-all ${
                      active
                        ? "bg-white dark:bg-neutral-900 text-on border-amber-500/60 shadow-xs ring-1 ring-amber-500/30"
                        : "bg-s2 border-border text-on/80 hover:bg-s3 font-semibold"
                    }`}
                  >
                    <span>{s.label}</span>
                    <span className="text-[10px] text-mut opacity-75">{s.px}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        {/* Quick Style Presets */}
        {mode !== "off" && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
              Color & Style Presets
            </span>
            <div className="grid grid-cols-5 gap-1.5">
              {[
                { id: "white" as const, label: "YouTube", dot: "#FFFFFF" },
                { id: "yellow" as const, label: "Netflix", dot: "#FFE600" },
                { id: "cyan" as const, label: "Cinema", dot: "#00E5FF" },
                { id: "green" as const, label: "Neon", dot: "#76FF03" },
                { id: "solid" as const, label: "Solid", dot: "#FFFFFF" },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className="h-8 rounded-xl bg-s2 hover:bg-s3 border border-border text-[11px] font-bold text-on flex items-center justify-center gap-1 pressable transition-all active:scale-95"
                >
                  <span className="w-2.5 h-2.5 rounded-full border border-black/20" style={{ backgroundColor: p.dot }} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Background Opacity */}
        {mode !== "off" && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
              Background Box Opacity
            </span>
            <div className="grid grid-cols-4 gap-1.5">
              {[
                { label: "None (0%)", opacity: 0, bgStyle: "none" as const },
                { label: "Subtle (50%)", opacity: 50, bgStyle: "translucent" as const },
                { label: "Standard (75%)", opacity: 75, bgStyle: "translucent" as const },
                { label: "Solid (100%)", opacity: 100, bgStyle: "solid" as const },
              ].map((op) => {
                const active =
                  styleConfig.bgStyle === op.bgStyle &&
                  (op.bgStyle === "translucent" ? styleConfig.bgOpacity === op.opacity : true);
                return (
                  <button
                    key={op.label}
                    type="button"
                    onClick={() => {
                      const updated: SubtitleStyleConfig = {
                        ...styleConfig,
                        bgStyle: op.bgStyle,
                        bgOpacity: op.opacity,
                      };
                      setStyleConfig(updated);
                      setSubtitleStyleConfig(updated);
                    }}
                    className={`h-8 rounded-xl border text-[11px] font-bold flex items-center justify-center pressable transition-all ${
                      active
                        ? "bg-white dark:bg-neutral-900 text-on border-amber-500/60 shadow-xs ring-1 ring-amber-500/30"
                        : "bg-s2 border-border text-on/80 hover:bg-s3 font-semibold"
                    }`}
                  >
                    {op.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Subtitle (.SRT / .VTT) Export */}
        {videoId != null && episode != null && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-mut">
                Export Subtitles
              </span>
              {!hasRealTrack && (
                <span className="text-[10.5px] text-mut">Load a subtitle track to export</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                disabled={!hasRealTrack}
                onClick={async () => {
                  const res = await processSubtitleExport(
                    videoId,
                    episode,
                    "srt",
                    title || "Episode",
                    "en",
                    "save_downloads",
                    streamUrl
                  );
                  if (res.success) {
                    toast(`Exported ${res.fileName}`, "ok");
                  } else {
                    toast(res.error || "Failed to export SRT", "info");
                  }
                }}
                className="h-9 px-3 rounded-xl bg-s2 hover:bg-s3 border border-border text-[12.5px] font-semibold text-on flex items-center justify-center gap-1.5 pressable disabled:opacity-45"
              >
                <IFileText size={14} className="text-amber-500" />
                <span>Export .SRT</span>
              </Button>
              <Button
                type="button"
                disabled={!hasRealTrack}
                onClick={async () => {
                  const res = await processSubtitleExport(
                    videoId,
                    episode,
                    "vtt",
                    title || "Episode",
                    "en",
                    "save_downloads",
                    streamUrl
                  );
                  if (res.success) {
                    toast(`Exported ${res.fileName}`, "ok");
                  } else {
                    toast(res.error || "Failed to export VTT", "info");
                  }
                }}
                className="h-9 px-3 rounded-xl bg-s2 hover:bg-s3 border border-border text-[12.5px] font-semibold text-on flex items-center justify-center gap-1.5 pressable disabled:opacity-45"
              >
                <IFileText size={14} className="text-amber-500" />
                <span>Export .VTT</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
