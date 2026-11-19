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
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

/**
 * Parses timestamp string (00:01:23.456 or 01:23.456 or 00:01:23,456) into seconds
 */
export function parseTimestamp(ts: string): number {
  const clean = ts.trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  }
  return parseFloat(clean) || 0;
}

/**
 * Parses standard WebVTT or SRT format text into SubtitleCue[]
 */
export function parseVtt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\s*\n/);

  let idCounter = 1;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (!lines.length) continue;

    // Skip "WEBVTT" header block
    if (lines[0].toUpperCase().startsWith("WEBVTT") || lines[0].startsWith("NOTE")) {
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
    const start = parseTimestamp(timeParts[0]);
    const parsedEnd = parseTimestamp((timeParts[1] || "").trim().split(/\s+/)[0] || "");
    const end = parsedEnd > start ? parsedEnd : start + 1.0;

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
