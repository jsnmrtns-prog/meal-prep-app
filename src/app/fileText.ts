// Turns an opened file into plain text: PDF (pdf.js, loaded only when needed),
// Word (.docx) and plain text. Photos go through iPhone Live Text instead.
import { docxText, piecesToLines, type TextPiece } from "../engine/index.ts";

export async function textFromFile(file: File): Promise<{ text: string; kind: "pdf" | "docx" | "text-file" }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return { text: await pdfText(file), kind: "pdf" };
  if (name.endsWith(".docx")) return { text: await docxText(new Uint8Array(await file.arrayBuffer())), kind: "docx" };
  if (name.endsWith(".doc")) throw new Error("Older .doc files can't be read. In Word or Pages, save it as .docx or PDF and try again.");
  if (/\.(jpe?g|png|heic|heif|webp|gif)$/.test(name) || file.type.startsWith("image/")) {
    throw new Error("Photos can't be read directly. Open the photo, use Live Text to copy the recipe text, and paste it here.");
  }
  return { text: await file.text(), kind: "text-file" };
}

async function pdfText(file: File): Promise<string> {
  // The legacy build supports a wider range of Safari versions.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./assets/pdf.worker.min.js", document.baseURI).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const pages: TextPiece[][] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      pages.push(
        tc.items.flatMap((it) =>
          "str" in it ? [{ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width, height: it.height || Math.abs(it.transform[3] as number) }] : [],
        ),
      );
    }
    const text = piecesToLines(pages).join("\n").trim();
    if (!text) throw new Error("This PDF has no text in it (it may be a scanned picture). Use Live Text on a photo of it instead.");
    return text;
  } finally {
    await task.destroy();
  }
}
