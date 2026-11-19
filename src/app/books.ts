// Cookbooks you've opened: the list of recipes found in each one, kept on this
// phone so you can import another recipe later without opening the PDF again.
// Only the recipe text is kept, never the PDF itself.
import type { BookRecipe } from "../engine/index.ts";
import { openDb } from "./store.tsx";

export interface SavedBook {
  id: string;
  name: string;
  fileName: string;
  pageCount: number;
  scannedAt: string;
  recipes: BookRecipe[];
}

const PREFIX = "book:";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the cookbook list"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Couldn't save the cookbook"));
    tx.onabort = () => reject(tx.error ?? new Error("Saving the cookbook was cancelled"));
  });
}

export async function listBooks(): Promise<SavedBook[]> {
  const db = await openDb();
  const all = await req(db.transaction("kv", "readonly").objectStore("kv").getAll(IDBKeyRange.bound(PREFIX, `${PREFIX}￿`)));
  return (all as SavedBook[]).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

export async function getBook(id: string): Promise<SavedBook | undefined> {
  const db = await openDb();
  return (await req(db.transaction("kv", "readonly").objectStore("kv").get(PREFIX + id))) as SavedBook | undefined;
}

export async function saveBook(book: SavedBook): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(book, PREFIX + book.id);
  await finished(tx);
}

export async function deleteBook(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").delete(PREFIX + id);
  await finished(tx);
}

/** The same file opened again gets the same id, so it replaces its old list. */
export function bookIdFor(file: { name: string; size: number }): string {
  return `${file.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${file.size}`;
}
