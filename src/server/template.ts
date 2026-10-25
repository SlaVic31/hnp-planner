import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Szablon opisu zadania (Markdown) — deterministyczny podzbiór składni Mustache:
 *   {{nazwa}}              wartość pola
 *   {{#nazwa}}…{{/nazwa}}  sekcja renderowana tylko, gdy pole jest niepuste
 *   {{^nazwa}}…{{/nazwa}}  sekcja renderowana tylko, gdy pole jest puste
 *   {{! komentarz }}       pomijany
 * Wartości są wstawiane dosłownie i nie są ponownie interpretowane (brak wstrzykiwania znaczników).
 */

export const TEMPLATE_FIELDS = {
  title: "Tytuł zadania",
  summary: "Opis / cel zadania (od modelu)",
  acceptance_criteria: "Kryteria akceptacji — lista „- …” (od modelu)",
  technical_notes: "Uwagi techniczne (od modelu)",
  sources: "Źródła — lista linków budowana przez serwer wyłącznie z dokumentów i zadań przekazanych modelowi",
  project: "Nazwa projektu",
  date: "Data przygotowania propozycji (RRRR-MM-DD)",
} as const;
export type TemplateField = keyof typeof TEMPLATE_FIELDS;

export const DEFAULT_DESCRIPTION_TEMPLATE = `{{summary}}
{{#acceptance_criteria}}

## Kryteria akceptacji
{{acceptance_criteria}}
{{/acceptance_criteria}}
{{#technical_notes}}

## Uwagi techniczne
{{technical_notes}}
{{/technical_notes}}
{{#sources}}

## Źródła
{{sources}}
{{/sources}}`;

export const MAX_TEMPLATE_LENGTH = 10000;
export const MAX_DESCRIPTION_LENGTH = 20000;

type Node = { kind: "text"; text: string } | { kind: "var"; name: TemplateField } | { kind: "section"; name: TemplateField; inverted: boolean; children: Node[] };

export class TemplateError extends Error {}

const TAG = /\{\{\s*([#^/!]?)\s*([^}]*?)\s*\}\}/g;

export function parseTemplate(src: string): Node[] {
  if (src.length > MAX_TEMPLATE_LENGTH) throw new TemplateError(`Szablon jest za długi (maks. ${MAX_TEMPLATE_LENGTH} znaków).`);
  const root: Node[] = [];
  const stack: { name: TemplateField; inverted: boolean; children: Node[] }[] = [];
  const target = () => (stack.length ? stack[stack.length - 1]!.children : root);
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    const idx = m.index ?? 0;
    if (idx > last) target().push({ kind: "text", text: src.slice(last, idx) });
    last = idx + m[0].length;
    const sigil = m[1] ?? "";
    const name = (m[2] ?? "").trim();
    if (sigil === "!") continue;
    if (!(name in TEMPLATE_FIELDS)) {
      throw new TemplateError(`Nieznane pole „${name || "(puste)"}” w ${m[0]}. Dozwolone: ${Object.keys(TEMPLATE_FIELDS).join(", ")}.`);
    }
    const field = name as TemplateField;
    if (sigil === "#" || sigil === "^") {
      if (stack.some((s) => s.name === field)) throw new TemplateError(`Sekcja „${field}” jest zagnieżdżona sama w sobie.`);
      const node = { kind: "section" as const, name: field, inverted: sigil === "^", children: [] as Node[] };
      target().push(node);
      stack.push(node);
    } else if (sigil === "/") {
      const open = stack.pop();
      if (!open) throw new TemplateError(`Zamknięcie {{/${field}}} bez otwarcia sekcji.`);
      if (open.name !== field) throw new TemplateError(`Sekcja „${open.name}” zamknięta jako „${field}”.`);
    } else {
      target().push({ kind: "var", name: field });
    }
  }
  if (last < src.length) target().push({ kind: "text", text: src.slice(last) });
  if (stack.length) throw new TemplateError(`Niezamknięta sekcja „${stack[stack.length - 1]!.name}”.`);
  // Wykrywa pozostałości niedomkniętych znaczników, np. „{{summary”.
  const stripped = src.replace(TAG, "");
  if (stripped.includes("{{")) throw new TemplateError("Niedomknięty znacznik „{{”.");
  return root;
}

export function validateTemplate(src: string): string | null {
  try {
    parseTemplate(src);
    if (!src.trim()) return "Szablon nie może być pusty.";
    return null;
  } catch (e) {
    return e instanceof TemplateError ? e.message : String(e);
  }
}

export interface DescriptionSource {
  ref: string;
  title: string;
  url: string;
}

export interface DescriptionParts {
  summary: string;
  acceptanceCriteria: string[];
  technicalNotes: string;
  sources: DescriptionSource[];
}

export interface TemplateContext {
  title: string;
  project: string;
  /** Data w formacie RRRR-MM-DD — przekazywana jawnie, aby rendering był deterministyczny. */
  date: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Tytuły źródeł nie mogą łamać składni linku Markdown. */
const linkText = (s: string) => oneLine(s).replace(/[[\]]/g, "");
const URL_ESCAPES: Record<string, string> = { "(": "%28", ")": "%29", "<": "%3C", ">": "%3E" };
/** Tylko http(s); nawiasy i białe znaki kodowane, by nie łamały składni linku Markdown. */
const linkUrl = (s: string) => (/^https?:\/\//i.test(s) ? s.replace(/[()<>]/g, (c) => URL_ESCAPES[c]!).replace(/\s/g, "%20") : "");

function fieldValues(parts: DescriptionParts, ctx: TemplateContext): Record<TemplateField, string> {
  return {
    title: oneLine(ctx.title),
    summary: parts.summary.trim(),
    acceptance_criteria: parts.acceptanceCriteria.map((c) => `- ${oneLine(c)}`).join("\n"),
    technical_notes: parts.technicalNotes.trim(),
    sources: parts.sources
      .map((s) => {
        const url = linkUrl(s.url);
        return url ? `- [${linkText(s.title)}](${url})` : `- ${linkText(s.title)}`;
      })
      .join("\n"),
    project: oneLine(ctx.project),
    date: ctx.date,
  };
}

function renderNodes(nodes: Node[], values: Record<TemplateField, string>): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "var") out += values[n.name];
    else {
      const filled = values[n.name].trim().length > 0;
      if (filled !== n.inverted) out += renderNodes(n.children, values);
    }
  }
  return out;
}

/** Deterministyczne renderowanie opisu. Ten sam szablon + te same dane = ten sam tekst (i hash propozycji). */
export function renderDescription(template: string, parts: DescriptionParts, ctx: TemplateContext): string {
  const text = renderNodes(parseTemplate(template), fieldValues(parts, ctx))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) throw new TemplateError(`Wygenerowany opis przekracza ${MAX_DESCRIPTION_LENGTH} znaków.`);
  return text;
}

export function templateHash(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 12);
}

/** Części opisu przysyłane przez model (walidowane przed renderowaniem). */
export const DescriptionPartsInput = z
  .object({
    summary: z.string().max(8000, "Opis (summary) może mieć maks. 8000 znaków").optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(500, "Kryterium może mieć maks. 500 znaków")).max(20, "Maks. 20 kryteriów akceptacji").optional(),
    technicalNotes: z.string().max(8000, "Uwagi techniczne mogą mieć maks. 8000 znaków").optional(),
    sourceRefs: z.array(z.string().trim().regex(/^(D|T)\d{1,9}$/, "Odwołanie do źródła ma postać D1 lub T123")).max(20).optional(),
  })
  .strict();
export type DescriptionPartsInput = z.infer<typeof DescriptionPartsInput>;

export const SAMPLE_PARTS: DescriptionParts = {
  summary: "Gracz otrzymuje ostrzeżenie, gdy poziom oleju w latarni spada poniżej 20%.",
  acceptanceCriteria: ["Ostrzeżenie dźwiękowe i wizualne poniżej 20% oleju", "Ostrzeżenie znika po uzupełnieniu oleju"],
  technicalNotes: "Próg konfigurowalny w ustawieniach rozgrywki.",
  sources: [{ ref: "D1", title: "Dokument projektowy: Latarnik", url: "https://outline.example/doc/latarnik-gdd" }],
};
