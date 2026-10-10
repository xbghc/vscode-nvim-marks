/**
 * Gutter icon generation. Icons are inline SVG data URIs so the extension
 * ships no image files and can color them per theme and per mark kind.
 */

import type { MarkKind } from "./model";

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
 * Local marks: a plain bold letter, like Neovim's sign column.
 * Global marks: the letter inside a thin rounded frame, so cross-file marks are
 * distinguishable at a glance even when the color is similar.
 */
export function markIconSvg(label: string, kind: MarkKind, color: string): string {
  const text = escapeXml(label);
  // Font size shrinks with label length so "ab+" still fits in 16px.
  const size = label.length <= 1 ? 11 : label.length === 2 ? 8.5 : 7;
  const frame =
    kind === "global"
      ? `<rect x="1.5" y="1.5" width="13" height="13" rx="2.5" ry="2.5" fill="none" stroke="${color}" stroke-width="1.2"/>`
      : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    frame +
    `<text x="8" y="8" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
    `font-weight="700" font-size="${size}" fill="${color}">${text}</text>` +
    `</svg>`
  );
}

export function svgDataUri(svg: string): string {
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

export function markIconUri(label: string, kind: MarkKind, color: string): string {
  return svgDataUri(markIconSvg(label, kind, color));
}
