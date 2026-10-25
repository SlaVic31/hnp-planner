import { AppError } from "../errors.js";
import { keywords } from "./scoped.js";
import type { OutlineCollection, OutlineDoc, OutlineDocRef, OutlineSource, OutlineStatus } from "./types.js";

const BASE = "https://demo.outline.invalid";

/** Fikcyjne dokumenty trybu demo. `col-hr` celowo NIE jest przypisana do projektu demo (test zakresu). */
export const DEMO_COLLECTIONS: OutlineCollection[] = [
  { id: "col-design", name: "Projekt gry", url: `${BASE}/collection/projekt-gry` },
  { id: "col-tech", name: "Technologia", url: `${BASE}/collection/technologia` },
  { id: "col-hr", name: "Kadry (poza zakresem)", url: `${BASE}/collection/kadry` },
];

export const DEMO_DOCS: OutlineDoc[] = [
  {
    id: "doc-gdd",
    title: "Dokument projektowy: Latarnik",
    collectionId: "col-design",
    url: `${BASE}/doc/dokument-projektowy-latarnik-gdd`,
    updatedAt: "2026-10-01T10:00:00.000Z",
    text: `# Latarnik — dokument projektowy

Gracz wciela się w latarnika na wyspie. Główna pętla: dzień (naprawy, zbieranie zasobów) i noc (utrzymanie światła, ratowanie statków).

## Mechanika światła
Latarnia zużywa olej. Gdy poziom oleju spadnie poniżej 20%, gracz musi otrzymać ostrzeżenie dźwiękowe i wizualne.
Zasięg światła zależy od czystości soczewki — soczewka brudzi się podczas sztormu.

## Sztorm
Sztorm pojawia się co 3–5 nocy. Podczas sztormu wiatr gasi pochodnie na ścieżce, a statki potrzebują dwukrotnie mocniejszego światła.

## Kamienie milowe
- Pionowy wycinek (vertical slice): jedna wyspa, jeden cykl dzień/noc, sztorm.
- Alfa: trzy wyspy, system ulepszeń latarni.`,
  },
  {
    id: "doc-audio",
    title: "Audio: wytyczne",
    collectionId: "col-design",
    url: `${BASE}/doc/audio-wytyczne`,
    updatedAt: "2026-09-20T09:00:00.000Z",
    text: `# Audio
Każde ostrzeżenie (niski poziom oleju, nadciągający sztorm) ma własny sygnał dźwiękowy.
Dźwięk sztormu narasta przez 30 sekund przed jego rozpoczęciem.`,
  },
  {
    id: "doc-save",
    title: "System zapisu gry",
    collectionId: "col-tech",
    url: `${BASE}/doc/system-zapisu-gry`,
    updatedAt: "2026-10-10T12:00:00.000Z",
    text: `# System zapisu
Zapis automatyczny następuje o świcie. Format: JSON z wersją schematu.
Wymaganie: zapis musi być odporny na przerwanie (zapis do pliku tymczasowego, potem zamiana nazwy).
Otwarte kwestie: migracje między wersjami schematu, zapis w chmurze.`,
  },
  {
    id: "doc-salaries",
    title: "Wynagrodzenia zespołu",
    collectionId: "col-hr",
    url: `${BASE}/doc/wynagrodzenia`,
    updatedAt: "2026-10-05T12:00:00.000Z",
    text: `# Poufne
Ten dokument nie należy do kolekcji projektu i nie może trafić do kontekstu modelu.
Słowa kluczowe dla testów: latarnik sztorm zapis olej.`,
  },
];

/** Deterministyczne źródło dokumentów dla trybu demo i testów. Nie łączy się z siecią. */
export class DemoOutlineSource implements OutlineSource {
  readonly mode = "demo" as const;

  async search(query: string, collectionId: string, limit: number): Promise<OutlineDocRef[]> {
    const terms = query.trim() ? [query.toLowerCase(), ...keywords(query, 6)] : [];
    return DEMO_DOCS.filter((d) => d.collectionId === collectionId)
      .map((d) => {
        const hay = `${d.title}\n${d.text}`.toLowerCase();
        const score = terms.length === 0 ? 1 : terms.filter((t) => hay.includes(t)).length;
        return { d, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ d }) => ({ id: d.id, title: d.title, url: d.url, collectionId: d.collectionId, snippet: d.text.slice(0, 160) }));
  }

  async getDocument(id: string): Promise<OutlineDoc> {
    const d = DEMO_DOCS.find((x) => x.id === id);
    if (!d) throw new AppError(`Nie znaleziono dokumentu ${id}`, { status: 404, code: "outline_not_found", source: "outline" });
    return { ...d };
  }

  async listCollections(): Promise<OutlineCollection[]> {
    return DEMO_COLLECTIONS.map((c) => ({ ...c }));
  }

  async status(): Promise<OutlineStatus> {
    return {
      mode: "demo",
      connected: true,
      serverName: "demo (dane fikcyjne)",
      tools: [
        { name: "list_documents", readOnlyHint: true, allowed: true },
        { name: "fetch", readOnlyHint: true, allowed: true },
        { name: "list_collections", readOnlyHint: true, allowed: true },
      ],
      blockedWriteTools: [],
      missingCapabilities: [],
    };
  }

  async close(): Promise<void> {}
}
