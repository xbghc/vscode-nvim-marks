/**
 * Gutter icon generation. Icons are inline SVG data URIs so the extension
 * ships no image files and can color them per theme and per mark kind.
 */

export interface IconColors {
  light: string;
  dark: string;
}

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

/**
 * Build the SVG for one gutter icon.
 *
 * Both local and global marks use plain bold letters, like Neovim's sign
 * column. Letter case and the configured color distinguish the mark kinds.
 */
export function markIconSvg(label: string, color: string): string {
  const text = escapeXml(label);
  // Font size shrinks with label length so "ab+" still fits in 16px.
  const size = label.length <= 1 ? 11 : label.length === 2 ? 8.5 : 7;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<text x="8" y="8" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
    `font-weight="700" font-size="${size}" fill="${color}">${text}</text>` +
    `</svg>`
  );
}

export function svgDataUri(svg: string): string {
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

export function markIconUri(label: string, color: string): string {
  return svgDataUri(markIconSvg(label, color));
}
