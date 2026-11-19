/**
 * Reads the text of a Word (.docx) file without any library: a .docx is a
 * zip archive whose word/document.xml holds the paragraphs. Uses the
 * browser's built-in DecompressionStream (Safari 16.4+, Node 18+).
 */

function u16(b: Uint8Array, o: number) {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number) {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One file from a zip archive, or null if it isn't there. */
export async function readZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | null> {
  // End of central directory: signature 0x06054b50, searched from the end.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new Error("Damaged zip directory");
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOffset = u32(zip, p + 42);
    const entryName = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      const lNameLen = u16(zip, localOffset + 26);
      const lExtraLen = u16(zip, localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = zip.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw);
      throw new Error("Unsupported compression in file");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** The paragraphs of a .docx file as lines of text (list numbering isn't included). */
export async function docxText(file: Uint8Array): Promise<string> {
  const xmlBytes = await readZipEntry(file, "word/document.xml");
  if (!xmlBytes) throw new Error("This doesn't look like a Word document");
  const xml = new TextDecoder().decode(xmlBytes);
  const lines: string[] = [];
  for (const para of xml.split(/<\/w:p>/)) {
    let text = "";
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (m[0] === "<w:tab/>") text += " ";
      else if (m[0] === "<w:br/>") text += "\n";
      else text += decodeXml(m[1]!);
    }
    lines.push(text);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
