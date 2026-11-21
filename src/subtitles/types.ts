/**
 * Subtitle and Closed Captions (CC) Types for AuraStream
 */

export type SubtitleMode = "off" | "en";
export type SubtitleSize = "sm" | "md" | "lg" | "xl";
export type SubtitlePosition = "bottom" | "above_title" | "middle" | "top" | "custom";
export type AICaptionProvider = "procedural" | "gemini" | "whisper" | "custom";

export type SubtitleColor = "white" | "yellow" | "cyan" | "green";
export type SubtitleEdgeStyle = "drop_shadow" | "raised" | "depressed" | "uniform" | "none";
export type SubtitleFont = "sans" | "rounded" | "serif" | "mono";
export type SubtitleBgStyle = "translucent" | "solid" | "none";

export interface SubtitleStyleConfig {
  color: SubtitleColor;
  edgeStyle: SubtitleEdgeStyle;
  font: SubtitleFont;
  bgStyle: SubtitleBgStyle;
  bgOpacity: number; // 0 to 100
  position?: SubtitlePosition;
  customOffsetPercent?: number; // 5 to 90 (%)
}

export interface AICaptionConfig {
  provider: AICaptionProvider;
  geminiKey?: string;
  whisperKey?: string;
  customUrl?: string;
}

export interface SubtitleCue {
  id: string | number;
  start: number; // Start time in seconds (e.g. 1.25)
  end: number;   // End time in seconds (e.g. 4.60)
  en: string;    // English translation
  zh: string;    // Chinese original / transcript
  speaker?: string; // Optional speaker identifier
}

export interface SubtitleTrack {
  videoId: number;
  episode: number;
  cues: SubtitleCue[];
  source: "ai_whisper" | "ai_gemini" | "upstream_vtt" | "procedural" | "cache" | "offline_download";
  generatedAt?: number;
}
