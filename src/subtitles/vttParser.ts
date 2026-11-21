import type { SubtitleCue } from "./types";
import { formatSubtitleText } from "./dramaTranslator";

/**
 * Decodes standard HTML entities commonly found in subtitle tracks
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || !text.includes("&")) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
      } catch {
        return _;
      }
    });
}

function tryParseTimestamp(ts: string): number | null {
  if (!ts || typeof ts !== "string") return null;
  const clean = ts.trim().replace(",", ".");
  if (!clean) return null;
  if (/^\d+(?:\.\d+)?$/.test(clean)) {
    const val = parseFloat(clean);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  if (/^\d+:\d{1,2}(?:\.\d+)?$/.test(clean)) {
    const [m, s] = clean.split(":");
    const total = parseFloat(m) * 60 + parseFloat(s);
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  if (/^\d+:\d{1,2}:\d{1,2}(?:\.\d+)?$/.test(clean)) {
    const [h, m, s] = clean.split(":");
    const total = parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  return null;
}

/**
 * Parses timestamp string (00:01:23.456 or 01:23.456 or 00:01:23,456) into seconds
 */
export function parseTimestamp(ts: string): number {
  return tryParseTimestamp(ts) ?? 0;
}

/**
 * Parses standard WebVTT or SRT format text into SubtitleCue[]
 */
export function parseVtt(content: string): SubtitleCue[] {
  if (!content || typeof content !== "string") return [];
  const cues: SubtitleCue[] = [];
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);

  let idCounter = 1;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (!lines.length) continue;

    // Skip "WEBVTT", "NOTE", "STYLE", "REGION" header/metadata blocks
    const head = lines[0].trim().toUpperCase();
    if (
      head.startsWith("WEBVTT") ||
      head === "NOTE" ||
      head.startsWith("NOTE ") ||
      head === "STYLE" ||
      head.startsWith("STYLE ") ||
      head === "REGION" ||
      head.startsWith("REGION ")
    ) {
      continue;
    }

    let timeLineIdx = 0;
    if (!lines[0].includes("-->") && lines.length > 1 && lines[1].includes("-->")) {
      timeLineIdx = 1;
    }

    if (!lines[timeLineIdx] || !lines[timeLineIdx].includes("-->")) {
      continue;
    }

    const timeParts = lines[timeLineIdx].split("-->");
    const parsedStart = tryParseTimestamp(timeParts[0]);
    if (parsedStart === null) continue;
    const start = parsedStart;
    const parsedEnd = tryParseTimestamp((timeParts[1] || "").trim().split(/\s+/)[0] || "");
    const end = parsedEnd !== null && parsedEnd > start ? parsedEnd : start + 1.0;

    const textLines = lines
      .slice(timeLineIdx + 1)
      .map((l) => decodeHtmlEntities(l.replace(/<[^>]+>/g, "").trim()))
      .filter(Boolean);
    if (!textLines.length) continue;

    let en = "";
    let zh = "";

    // Check if dual format [EN] / [ZH]
    for (const line of textLines) {
      if (line.startsWith("[EN]") || line.startsWith("EN:")) {
        en = line.replace(/^(\[EN\]|EN:)\s*/i, "");
      } else if (line.startsWith("[ZH]") || line.startsWith("ZH:")) {
        zh = line.replace(/^(\[ZH\]|ZH:)\s*/i, "");
      } else {
        // Fallback: check character range
        const hasChinese = /[\u4e00-\u9fa5]/.test(line);
        if (hasChinese && !zh) {
          zh = line;
        } else if (!hasChinese && !en) {
          en = line;
        } else {
          if (!en) en = line;
          else if (!zh) zh = line;
        }
      }
    }

    const englishCue = formatSubtitleText(en || zh);
    if (!englishCue) continue;

    cues.push({
      id: idCounter++,
      start,
      end,
      en: englishCue,
      zh: zh || englishCue,
    });
  }

  return cues;
}
