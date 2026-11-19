/**
 * Rebuilds lines of text from the positioned text pieces a PDF reader gives
 * (pdf.js getTextContent). Pieces on the same baseline are joined left to
 * right; columns are read left column first when the page clearly has two.
 */
export interface TextPiece {
  str: string;
  /** Left edge and baseline, in PDF units (y grows upward). */
  x: number;
  y: number;
  width: number;
  height: number;
}

import { isSectionHeading } from "./parse.ts";

interface Row {
  y: number;
  height: number;
  pieces: TextPiece[];
}

function rowText(pieces: TextPiece[]): string {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  let text = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const p of sorted) {
    const gap = p.x - end;
    if (text && gap > Math.max(1, p.height * 0.15) && !/\s$/.test(text) && !/^\s/.test(p.str)) text += " ";
    text += p.str;
    end = p.x + p.width;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Lines of text in reading order. Where part of a page is laid out in two
 * columns (common for ingredient lists), the left column is read before the
 * right one, band by band.
 */
export function piecesToLines(pages: TextPiece[][]): string[] {
  const out: string[] = [];
  for (const pieces of pages) {
    const items = pieces.filter((p) => p.str.trim() !== "");
    if (items.length === 0) continue;
    // Rows: pieces on the same baseline.
    const rows: Row[] = [];
    for (const p of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const last = rows.at(-1);
      if (last && Math.abs(last.y - p.y) <= Math.max(2, Math.min(p.height, last.height) * 0.4)) last.pieces.push(p);
      else rows.push({ y: p.y, height: p.height, pieces: [p] });
    }
    /** Where a row splits into two columns: the start of the piece after a wide gap. */
    const splitOf = (r: Row): number | null => {
      const s = [...r.pieces].sort((a, b) => a.x - b.x);
      for (let k = 1; k < s.length; k++) {
        const gap = s[k]!.x - (s[k - 1]!.x + s[k - 1]!.width);
        if (gap > Math.max(15, s[k]!.height * 1.5)) return s[k]!.x;
      }
      return null;
    };
    // A piece that runs well past the split belongs to full-width text (a small overrun is a long ingredient).
    const crossesAt = (r: Row, x: number) => r.pieces.some((p) => p.x < x - 3 && p.x + p.width > x + Math.max(10, p.height * 2));
    let i = 0;
    let prevY = Number.NaN;
    while (i < rows.length) {
      const r = rows[i]!;
      if (!Number.isNaN(prevY) && prevY - r.y > r.height * 1.8) out.push("");
      const split = splitOf(r);
      if (split !== null && !isSectionHeading(rowText(r.pieces))) {
        // A two-column band runs until a row crosses the split, a heading appears, or there's a big gap.
        const band: Row[] = [r];
        i++;
        while (i < rows.length) {
          const next = rows[i]!;
          if (crossesAt(next, split) || isSectionHeading(rowText(next.pieces))) break;
          if (band.at(-1)!.y - next.y > next.height * 3) break;
          band.push(next);
          i++;
        }
        for (const side of [(p: TextPiece) => p.x < split - 3, (p: TextPiece) => p.x >= split - 3]) {
          for (const row of band) {
            const part = row.pieces.filter(side);
            if (part.length) out.push(rowText(part));
          }
          out.push("");
        }
        prevY = band.at(-1)!.y;
        continue;
      }
      out.push(rowText(r.pieces));
      prevY = r.y;
      i++;
    }
    out.push("");
  }
  return out;
}
