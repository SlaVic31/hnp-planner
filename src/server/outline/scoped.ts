import { AppError } from "../errors.js";
import type { ProjectConfig } from "../config.js";
import type { OutlineDoc, OutlineDocRef, OutlineSource } from "./types.js";

const STOPWORDS = new Set(
  "oraz jest będzie które który która których przez jakie jaki jaka czego czy dla jest się nie tak jako może można trzeba proszę zadanie zadania zadań dodaj utwórz zmień popraw what with that this from have".split(
    " ",
  ),
);

export function keywords(text: string, max = 3): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}

/**
 * Egzekwuje zakres kolekcji przypisanych do projektu:
 * - wyszukuje wyłącznie w skonfigurowanych kolekcjach,
 * - odrzuca wyniki i dokumenty spoza zakresu (także gdy brak collectionId — fail closed).
 */
export class ScopedOutline {
  constructor(
    private readonly source: OutlineSource,
    private readonly project: ProjectConfig,
  ) {}

  private inScope(collectionId: string | null): boolean {
    return !!collectionId && this.project.outlineCollectionIds.includes(collectionId);
  }

  async search(query: string, limit: number): Promise<OutlineDocRef[]> {
    const scope = this.project.outlineCollectionIds;
    if (scope.length === 0) return [];
    const found = new Map<string, OutlineDocRef>();
    const run = async (q: string) => {
      for (const col of scope) {
        const res = await this.source.search(q, col, limit);
        for (const r of res) if (this.inScope(r.collectionId) && !found.has(r.id)) found.set(r.id, r);
      }
    };
    await run(query);
    if (found.size === 0) {
      for (const kw of keywords(query)) {
        await run(kw);
        if (found.size >= limit) break;
      }
    }
    return [...found.values()].slice(0, limit);
  }

  async getDocument(id: string): Promise<OutlineDoc> {
    const doc = await this.source.getDocument(id);
    if (!this.inScope(doc.collectionId)) {
      throw new AppError(`Dokument „${doc.title}” nie należy do kolekcji przypisanych do projektu ${this.project.name} — pominięto.`, {
        status: 403,
        code: "outline_out_of_scope",
        source: "outline",
      });
    }
    return doc;
  }
}
