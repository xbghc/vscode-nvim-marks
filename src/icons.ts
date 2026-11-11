/**
 * Gutter icon generation. Icons are inline SVG data URIs so the extension
 * ships no image files and can color them per theme and per mark kind.
 */

export interface IconColors {
  light: string;
  dark: string;
}

export interface IconFontOptions {
  /** CSS font-family from `editor.fontFamily`; falls back to system monospace. */
  fontFamily?: string;
  /** Editor font size in px from `editor.fontSize` (default 14). */
  editorFontSize?: number;
}

const FALLBACK_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const DEFAULT_EDITOR_FONT_SIZE = 14;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the SVG for one gutter icon.
 *
 * Both local and global marks use plain italic letters in the editor's font,
 * sized relative to `editor.fontSize`. Letter case and the configured color
 * distinguish the mark kinds.
 */
export function markIconSvg(label: string, color: string, opts?: IconFontOptions): string {
  const text = escapeXml(label);
  const fill = escapeXml(color);
  const cleanedFont =
    typeof opts?.fontFamily === "string"
      ? opts.fontFamily.replace(/;/g, "").trim().replace(/,+\s*$/, "").replace(/"/g, "'")
      : "";
  const fontFamily = escapeXml(
    cleanedFont ? `${cleanedFont}, ${FALLBACK_FONT_FAMILY}` : FALLBACK_FONT_FAMILY,
  );
  const rawBase = opts?.editorFontSize;
  const base =
    typeof rawBase === "number" && Number.isFinite(rawBase) && rawBase > 0
      ? Math.min(Math.max(rawBase, 6), 72)
      : DEFAULT_EDITOR_FONT_SIZE;
  // Single mark uses 100% of editor.fontSize; multi-mark labels shrink so "ab+" fits the gutter.
  const scale = label.length <= 1 ? 1 : label.length === 2 ? 0.75 : 0.6;
  const size = round2(base * scale);
  const box = Math.max(16, Math.ceil((base * 1.3) / 2) * 2);
  const center = box / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}">` +
    `<text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="${fontFamily}" font-style="italic" font-weight="400" ` +
    `font-size="${size}" fill="${fill}">${text}</text>` +
    `</svg>`
  );
}

export function svgDataUri(svg: string): string {
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

export function markIconUri(label: string, color: string, opts?: IconFontOptions): string {
  return svgDataUri(markIconSvg(label, color, opts));
}
