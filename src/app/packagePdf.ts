// Builds the recipe package as a real PDF inside the app. A Home Screen web
// app on iPhone can't open the print screen, so the app writes the PDF itself
// and hands it to the share sheet (Messages, Mail, WhatsApp, Save to Files,
// or Print from there).
//
// pdf-lib is loaded only when this runs, like pdf.js for reading PDFs.

export type Run = { text: string; bold?: boolean | undefined };

export type Block =
  | { t: "title"; text: string }
  | { t: "sub"; text: string }
  | { t: "heading"; text: string }
  | { t: "group"; text: string }
  | { t: "row"; left: string; right?: string | undefined; box?: boolean | undefined; sub?: string | undefined }
  | { t: "step"; n: number; runs: Run[] }
  | { t: "note"; text: string }
  | { t: "page" };

type PdfLib = typeof import("pdf-lib");
type PDFFont = import("pdf-lib").PDFFont;
type PDFPage = import("pdf-lib").PDFPage;

const PAGE_W = 612; // U.S. Letter, in points
const PAGE_H = 792;
const MARGIN = 54;
const WIDTH = PAGE_W - MARGIN * 2;

/** Characters the built-in PDF fonts can't draw, written the way you'd type them. */
const SWAP: Record<string, string> = {
  "⅓": "1/3", "⅔": "2/3", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅕": "1/5", "⅙": "1/6",
  "−": "-", "→": "->", "≥": ">=", "≤": "<=", "≈": "~", "✓": "", "✗": "", "☐": "", "⁄": "/",
  " ": " ", " ": " ", " ": " ",
};

export function cleanText(text: string, has: (code: number) => boolean): string {
  let out = "";
  for (const ch of text) {
    if (has(ch.codePointAt(0)!)) { out += ch; continue; }
    if (ch in SWAP) { out += SWAP[ch]; continue; }
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += [...plain].every((c) => has(c.codePointAt(0)!)) ? plain : "";
  }
  return out.replace(/ {2,}/g, " ");
}

export async function packagePdf(title: string, blocks: Block[], lib?: PdfLib): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = lib ?? (await import("pdf-lib"));
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator("Meal Prep");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(regular.getCharacterSet());
  const clean = (s: string) => cleanText(s, (c) => charset.has(c));
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.42, 0.42, 0.46);
  const rule = rgb(0.85, 0.85, 0.87);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  let pageHasContent = false;
  const newPage = () => { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; pageHasContent = false; };
  const room = (h: number) => { if (y - h < MARGIN) newPage(); };

  /** Word-wraps runs of mixed regular/bold text into lines no wider than `width`. */
  const wrap = (runs: Run[], size: number, width: number): Run[][] => {
    const words: Run[] = [];
    for (const r of runs) for (const piece of clean(r.text).split(/(\s+)/)) if (piece) words.push({ text: piece, bold: r.bold });
    const lines: Run[][] = [[]];
    let w = 0;
    for (const word of words) {
      const f = word.bold ? bold : regular;
      const ww = f.widthOfTextAtSize(word.text, size);
      const space = /^\s+$/.test(word.text);
      if (!space && w + ww > width && w > 0) { lines.push([]); w = 0; }
      if (space && w === 0) continue;
      lines[lines.length - 1]!.push(word);
      w += ww;
    }
    return lines.filter((l) => l.length > 0);
  };

  const drawLine = (line: Run[], x: number, size: number, color = ink) => {
    for (const r of line) {
      const f = r.bold ? bold : regular;
      page.drawText(r.text, { x, y, size, font: f, color });
      x += f.widthOfTextAtSize(r.text, size);
    }
  };

  const paragraph = (runs: Run[], size: number, opts: { x?: number; width?: number; color?: ReturnType<typeof rgb>; gap?: number; lead?: number } = {}) => {
    const x = opts.x ?? MARGIN;
    const lead = opts.lead ?? size * 1.35;
    for (const line of wrap(runs, size, opts.width ?? WIDTH - (x - MARGIN))) {
      room(lead);
      y -= size;
      drawLine(line, x, size, opts.color);
      y -= lead - size;
      pageHasContent = true;
    }
    y -= opts.gap ?? 0;
  };

  for (const b of blocks) {
    switch (b.t) {
      case "page":
        if (pageHasContent) newPage();
        break;
      case "title":
        paragraph([{ text: b.text, bold: true }], 20, { gap: 4 });
        break;
      case "sub":
        paragraph([{ text: b.text }], 10, { color: grey, gap: 4 });
        break;
      case "heading": {
        // Keep a heading with at least a couple of the lines under it.
        room(14 + 6 + 40);
        y -= 10;
        paragraph([{ text: b.text, bold: true }], 13, { gap: 2 });
        page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: MARGIN + WIDTH, y: y + 2 }, thickness: 0.6, color: rule });
        y -= 6;
        break;
      }
      case "group":
        room(10 + 6 + 28);
        y -= 6;
        paragraph([{ text: b.text.toUpperCase(), bold: true }], 8.5, { color: grey, gap: 1 });
        break;
      case "row": {
        const size = 10.5;
        const indent = b.box ? 16 : 0;
        const right = b.right ? clean(b.right) : "";
        const rightW = right ? Math.min(bold.widthOfTextAtSize(right, size), WIDTH * 0.45) : 0;
        const leftLines = wrap([{ text: b.left }], size, WIDTH - indent - rightW - 14);
        const rightLines = right ? wrap([{ text: right, bold: true }], size, WIDTH * 0.45) : [];
        const lead = size * 1.3;
        const h = Math.max(leftLines.length, rightLines.length) * lead + (b.sub ? 12 : 0);
        room(h + 3);
        const top = y;
        if (b.box) page.drawRectangle({ x: MARGIN, y: top - size + 0.5, width: 9, height: 9, borderColor: ink, borderWidth: 0.8 });
        leftLines.forEach((line, k) => { y = top - k * lead - size; drawLine(line, MARGIN + indent, size); });
        rightLines.forEach((line, k) => {
          const w = line.reduce((s, r) => s + bold.widthOfTextAtSize(r.text, size), 0);
          y = top - k * lead - size;
          drawLine(line, MARGIN + WIDTH - w, size);
        });
        y = top - Math.max(leftLines.length, rightLines.length) * lead;
        if (b.sub) { y += lead - size - 2; paragraph([{ text: b.sub }], 8.5, { x: MARGIN + indent, color: grey, lead: 12, width: WIDTH - indent - rightW - 14 }); }
        y -= 3;
        pageHasContent = true;
        break;
      }
      case "step": {
        const size = 10.5;
        room(size * 1.45 * 2);
        const top = y;
        page.drawText(`${b.n}.`, { x: MARGIN, y: top - size, size, font: bold, color: ink });
        paragraph(b.runs, size, { x: MARGIN + 20, lead: size * 1.45, gap: 5 });
        pageHasContent = true;
        break;
      }
      case "note":
        paragraph([{ text: b.text }], 9.5, { color: grey, gap: 4 });
        break;
    }
  }
  return doc.save();
}

/**
 * Sends the PDF through the iPhone share sheet. Where a browser can't share
 * files, it downloads instead. The file must already be built: iPhone only
 * opens the share sheet straight from a tap, with no waiting in between.
 */
export async function sharePdf(file: File): Promise<"shared" | "downloaded"> {
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name.replace(/\.pdf$/i, "") });
      return "shared";
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "shared";
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
