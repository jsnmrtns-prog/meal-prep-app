// Turns an opened file into plain text: PDF (pdf.js, loaded only when needed),
// Word (.docx) and plain text. Photos go through iPhone Live Text instead.
//
// PDFs are read in pieces straight from the file (a range transport), so a
// 300 MB cookbook never has to fit in the phone's memory at once: only the
// parts pdf.js asks for are read. Only text is extracted; no page is drawn.
import { docxText, piecesToLines, type TextPiece } from "../engine/index.ts";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export type FileText =
  | { kind: "docx" | "text-file"; text: string }
  | { kind: "pdf"; pages: string[] };

export interface ReadProgress {
  page: number;
  pages: number;
}

let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    if (typeof document !== "undefined") m.GlobalWorkerOptions.workerSrc = new URL("./assets/pdf.worker.min.js", document.baseURI).href;
    return m;
  });
  return pdfjsPromise;
}

export async function textFromFile(file: File, onProgress?: (p: ReadProgress) => void, signal?: AbortSignal): Promise<FileText> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return { kind: "pdf", pages: await pdfPages(await loadPdfJs(), file, onProgress, signal) };
  if (name.endsWith(".docx")) return { kind: "docx", text: await docxText(new Uint8Array(await file.arrayBuffer())) };
  if (name.endsWith(".doc")) throw new Error("Older .doc files can't be read. In Word or Pages, save it as .docx or PDF and try again.");
  if (/\.(jpe?g|png|heic|heif|webp|gif)$/.test(name) || file.type.startsWith("image/")) {
    throw new Error("Photos can't be read directly. Open the photo, use Live Text to copy the recipe text, and paste it here.");
  }
  return { kind: "text-file", text: await file.text() };
}

/**
 * The text of every page, in reading order (columns read one after another).
 * pdf.js sets aside room for the whole file once (about the file's size in
 * memory) and fills it only as pages are read; the file is never copied twice.
 */
export async function pdfPages(pdfjs: PdfJs, file: Blob, onProgress?: (p: ReadProgress) => void, signal?: AbortSignal, pagesPerOpen = Number.POSITIVE_INFINITY): Promise<string[]> {
  const CHUNK = 256 * 1024;
  const first = new Uint8Array(await file.slice(0, Math.min(file.size, CHUNK)).arrayBuffer());
  const open = () => {
    const transport = new pdfjs.PDFDataRangeTransport(file.size, first);
    transport.requestDataRange = (begin: number, end: number) => {
      void file.slice(begin, end).arrayBuffer().then((buf) => transport.onDataRange(begin, new Uint8Array(buf)));
    };
    return pdfjs.getDocument({ range: transport, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true, disableFontFace: true, verbosity: 0 });
  };
  const out: string[] = [];
  let anyText = false;
  let total = 1;
  for (let start = 1; start <= total; start += pagesPerOpen) {
    const task = open();
    try {
      const doc = await task.promise;
      total = doc.numPages;
      for (let i = start; i < start + pagesPerOpen && i <= total; i++) {
        if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const pieces: TextPiece[] = tc.items.flatMap((it) =>
          "str" in it ? [{ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width, height: it.height || Math.abs(it.transform[3] as number) }] : [],
        );
        const text = piecesToLines([pieces]).join("\n").trim();
        if (text) anyText = true;
        out.push(text);
        page.cleanup();
        onProgress?.({ page: i, pages: total });
      }
    } finally {
      await task.destroy();
    }
  }
  if (!anyText) throw new Error("This PDF has no text in it (it may be scanned pictures). Use Live Text on a photo of the page instead.");
  return out;
}
