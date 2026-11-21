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
      .map((l) => decodeHtmlEntities(l.replace(/\{\\[^}]+\}/g, "").replace(/<[^>]+>/g, "").trim()))
      .filter(Boolean);
    if (!textLines.length) continue;

    const enLines: string[] = [];
    const zhLines: string[] = [];

    // Preserve multi-line cues cleanly instead of treating line 2 as a second language
    for (const line of textLines) {
      if (/^(\[EN\]|EN:)/i.test(line)) {
        const cleaned = line.replace(/^(\[EN\]|EN:)\s*/i, "").trim();
        if (cleaned) enLines.push(cleaned);
      } else if (/^(\[ZH\]|ZH:)/i.test(line)) {
        const cleaned = line.replace(/^(\[ZH\]|ZH:)\s*/i, "").trim();
        if (cleaned) zhLines.push(cleaned);
      } else {
        const hasChinese = /[\u4e00-\u9fa5]/.test(line);
        if (hasChinese) {
          zhLines.push(line);
        } else {
          enLines.push(line);
        }
      }
    }

    const joinedEn = enLines.join("\n");
    const joinedZh = zhLines.join("\n");
    const englishCue = formatSubtitleText(joinedEn || joinedZh);
    if (!englishCue) continue;

    cues.push({
      id: idCounter++,
      start,
      end,
      en: englishCue,
      zh: joinedZh || englishCue,
    });
  }

  return cues;
}

/**
 * Balances caption text into at most two clean lines (Netflix/YouTube mobile caption guidelines).
 */
export function formatBalancedCaptionLines(text: string, maxCharsPerLine = 42): string {
  const rawLines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (rawLines.length === 0) return "";
  if (rawLines.length >= 2) {
    const first = rawLines[0];
    const rest = rawLines.slice(1).join(" ").trim();
    return rest ? `${first}\n${rest}` : first;
  }

  const single = rawLines[0];
  if (single.length <= maxCharsPerLine) return single;

  const words = single.split(" ");
  if (words.length <= 2) return single;

  const targetMid = Math.floor(single.length / 2);
  let bestSplitIdx = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let runningLen = 0;

  for (let i = 0; i < words.length - 1; i++) {
    runningLen += (i > 0 ? 1 : 0) + words[i].length;
    const line1Len = runningLen;
    const line2Len = single.length - runningLen - 1;
    const penalty = line1Len > maxCharsPerLine || line2Len > maxCharsPerLine ? 100 : 0;
    const score = Math.abs(line1Len - targetMid) + penalty;
    if (score < bestScore) {
      bestScore = score;
      bestSplitIdx = i;
    }
  }

  if (bestSplitIdx >= 0) {
    return `${words.slice(0, bestSplitIdx + 1).join(" ")}\n${words.slice(bestSplitIdx + 1).join(" ")}`;
  }
  return single;
}
