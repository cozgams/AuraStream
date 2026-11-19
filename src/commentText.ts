import DOMPurify from "dompurify";

const PARAGRAPHS = ["p", "div", "li", "blockquote", "pre"];

/**
 * Sanitizes comment text to clean plain text.
 * Strips HTML, scripts, and format paragraphs with safe newlines.
 */
export function commentText(raw: string): string {
  if (!raw || !DOMPurify.isSupported) return "";
  let text = raw;
  for (let pass = 0; pass < 3; pass++) {
    const template = document.createElement("template");
    template.innerHTML = text;
    const fragment = DOMPurify.sanitize(template.content, {
      ALLOWED_TAGS: ["br", ...PARAGRAPHS],
      ALLOWED_ATTR: [],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ADD_FORBID_CONTENTS: ["object", "embed", "textarea"],
      RETURN_DOM_FRAGMENT: true,
    });
    fragment.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    fragment.querySelectorAll(PARAGRAPHS.join(",")).forEach((node) => {
      node.prepend("\n");
      node.append("\n");
    });
    const next = (fragment.textContent || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
    if (next === text) break;
    text = next;
    if (!/[<&]/.test(text)) break;
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Translates and formats relative timestamps into fluent English.
 * Converts raw relative timestamp strings into standard English ("3d ago", "1mo ago", "just now").
 */
export function formatRelativeTime(raw: string | undefined): string {
  if (!raw) return "just now";
  const s = raw.trim();
  if (!/[\u4e00-\u9fff]/.test(s)) return s;

  return s
    .replace(/刚刚|刚才/g, "just now")
    .replace(/(\d+)\s*秒前/g, "$1s ago")
    .replace(/(\d+)\s*分钟前/g, "$1m ago")
    .replace(/(\d+)\s*小时前/g, "$1h ago")
    .replace(/昨天/g, "yesterday")
    .replace(/前天/g, "2d ago")
    .replace(/(\d+)\s*天前/g, "$1d ago")
    .replace(/(\d+)\s*周前/g, "$1w ago")
    .replace(/(\d+)\s*个月前/g, "$1mo ago")
    .replace(/(\d+)\s*月前/g, "$1mo ago")
    .replace(/(\d+)\s*年前/g, "$1y ago");
}
