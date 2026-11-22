/**
 * Subtitle and Closed Captions (CC) Types for AuraStream
 */

export type SubtitleMode = "off" | "en";
export type SubtitleSize = "sm" | "md" | "lg" | "xl";
export type SubtitlePosition = "bottom" | "above_title" | "middle" | "top" | "custom";
export type AICaptionProvider = "none" | "gemini" | "groq" | "whisper" | "custom";

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
  offsetSec?: number; // -5.0 to +5.0 seconds
}

export interface AICaptionConfig {
  provider: AICaptionProvider;
  geminiKey?: string;
  groqKey?: string;
  whisperKey?: string;
  customUrl?: string;
  customModel?: string;
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
  source:
    | "local_import"
    | "ai_whisper"
    | "ai_gemini"
    | "ai_groq"
    | "upstream_vtt"
    | "native_track"
    | "cache"
    | "offline_download"
    | "none";
  generatedAt?: number;
  fileName?: string;
}

export interface SubtitleTrackStatus {
  hasTrack: boolean;
  source: SubtitleTrack["source"];
  cueCount: number;
  fileName?: string;
}
