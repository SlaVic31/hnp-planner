import { AppError, UpstreamError, errorMessage, redact } from "./errors.js";
import { isLocalModelUrl } from "./config.js";
import type { ProjectMeta, WorkItem } from "./hacknplan/types.js";
import type { OutlineDoc } from "./outline/types.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContext {
  projectName: string;
  docs: (OutlineDoc & { ref: string })[];
  tasks: WorkItem[];
  meta: ProjectMeta;
  history: ChatTurn[];
  question: string;
  today: string;
}

export type LlmMode = "demo" | "openai" | "openai-responses" | "anthropic";

export interface PingResult {
  /** Krótki fragment odpowiedzi modelu (bez danych projektu). */
  sample: string;
  model: string;
  note?: string;
}

export interface ModelInfo {
  id: string;
  label?: string;
}

export interface LlmProvider {
  readonly mode: LlmMode;
  /** true, gdy model działa na tym komputerze (pętla zwrotna lub host Dockera) — dane nie opuszczają komputera. */
  readonly isLocal: boolean;
  readonly label: string;
  complete(ctx: ChatContext): Promise<string>;
  /** Prawdziwe, neutralne mini-zapytanie (bez dokumentów i zadań projektu) — weryfikuje adres, klucz i model. */
  ping(): Promise<PingResult>;
  /** Lista modeli udostępnianych przez dostawcę (bez generowania tokenów). */
  listModels(): Promise<ModelInfo[]>;
}

export const PING_PROMPT = "Reply with the single word OK.";

export const SYSTEM_PROMPT = `Jesteś asystentem planowania projektu gry. Odpowiadasz po polsku.
Opierasz się WYŁĄCZNIE na dostarczonych dokumentach Outline (oznaczonych [D1], [D2]...) i zadaniach HacknPlan (oznaczonych [T<id>]).
Cytuj źródła w tekście w nawiasach kwadratowych, np. [D1] lub [T103]. Jeśli czegoś nie ma w źródłach, powiedz to wprost.
Możesz ZAPROPONOWAĆ utworzenie lub edycję zadań — nie wykonujesz ich; użytkownik musi je zatwierdzić.
Proponuj zmiany tylko wtedy, gdy użytkownik o to prosi lub wynika to jasno z rozmowy.
Odpowiedz WYŁĄCZNIE obiektem JSON o kształcie:
{"answer": "tekst odpowiedzi (markdown)",
 "proposals": [
  {"type":"create","title":"...","summary":"cel i opis zadania","acceptanceCriteria":["kryterium 1","kryterium 2"],"technicalNotes":"uwagi lub pomiń","sourceRefs":["D1","T103"],"categoryId":<id z listy>,"importanceLevelId":<id>,"boardId":<id lub pomiń>,"estimatedCost":<liczba godzin/punktów>,"isStory":false,"dueDate":"RRRR-MM-DD lub pomiń","rationale":"dlaczego, ze źródłem"},
  {"type":"update","workItemId":<id istniejącego zadania>,"changes":{"title"?:"...","categoryId"?:<id>,"stageId"?:<id>,"importanceLevelId"?:<id>,"boardId"?:<id>,"estimatedCost"?:<liczba>,"dueDate"?:"RRRR-MM-DD"},"descriptionParts"?:{"summary":"...","acceptanceCriteria":[...],"technicalNotes":"...","sourceRefs":["D1"]},"rationale":"..."}
 ]}
Opis zadania NIE jest pisany ręcznie: podaj jego części (summary, acceptanceCriteria, technicalNotes), a w sourceRefs wyłącznie oznaczenia źródeł z kontekstu (D1, T103) — aplikacja złoży opis według szablonu projektu i sama doda linki do źródeł.
Używaj tylko identyfikatorów kategorii, etapów, priorytetów i tablic z listy metadanych projektu. Jeśli nie ma propozycji, zwróć "proposals": [].`;

export function buildContextText(ctx: ChatContext): string {
  const meta = ctx.meta;
  const lines: string[] = [];
  lines.push(`Projekt: ${ctx.projectName}. Dzisiejsza data: ${ctx.today}.`);
  lines.push(`\nMETADANE HACKNPLAN:`);
  lines.push(`Kategorie: ${meta.categories.map((c) => `${c.id}=${c.name}`).join(", ") || "(brak)"}`);
  lines.push(`Etapy: ${meta.stages.map((s) => `${s.id}=${s.name}`).join(", ") || "(brak)"}`);
  lines.push(`Priorytety: ${meta.importanceLevels.map((l) => `${l.id}=${l.name}${l.isDefault ? " (domyślny)" : ""}`).join(", ") || "(brak)"}`);
  lines.push(`Tablice: ${meta.boards.filter((b) => !b.closed).map((b) => `${b.id}=${b.name}`).join(", ") || "(brak)"}`);
  lines.push(`\nZADANIA HACKNPLAN (${ctx.tasks.length}):`);
  for (const t of ctx.tasks) {
    lines.push(
      `[T${t.workItemId}] ${t.title} | kategoria: ${t.category?.name ?? "-"} | etap: ${t.stage?.name ?? "-"} | priorytet: ${t.importanceLevel?.name ?? "-"} | tablica: ${t.board?.name ?? "-"} | koszt: ${t.estimatedCost ?? "-"}${t.dueDate ? ` | termin: ${t.dueDate.slice(0, 10)}` : ""}${t.description ? `\n    ${t.description.replace(/\s+/g, " ").slice(0, 300)}` : ""}`,
    );
  }
  lines.push(`\nDOKUMENTY OUTLINE (${ctx.docs.length}):`);
  for (const d of ctx.docs) lines.push(`--- [${d.ref}] ${d.title}\n${d.text}\n--- koniec [${d.ref}]`);
  return lines.join("\n");
}

export interface OpenAiOptions {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  jsonMode: boolean;
  temperature: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Dostawca zgodny z API OpenAI Chat Completions (Ollama, LM Studio, vLLM, OpenAI, OpenRouter...). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly mode = "openai" as const;
  readonly isLocal: boolean;
  readonly label: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiOptions) {
    this.isLocal = isLocalModelUrl(opts.baseUrl);
    this.label = `Zgodny z OpenAI: ${opts.model} @ ${new URL(opts.baseUrl).host}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(ctx: ChatContext): Promise<string> {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: buildContextText(ctx) },
      ...ctx.history.slice(-8),
      { role: "user", content: ctx.question },
    ];
    const body: Record<string, unknown> = { model: this.opts.model, messages, temperature: this.opts.temperature, stream: false };
    if (this.opts.jsonMode) body.response_format = { type: "json_object" };
    return this.chat(body);
  }

  async ping(): Promise<PingResult> {
    const sample = await this.chat({ model: this.opts.model, messages: [{ role: "user", content: PING_PROMPT }], max_tokens: 32, stream: false }, true);
    return { sample: sample.trim().slice(0, 40), model: this.opts.model };
  }

  async listModels(): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/models`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs, 30000)) });
    } catch (e) {
      throw new UpstreamError(`Nie można pobrać listy modeli (${new URL(url).host}): ${errorMessage(e)}`, { source: "llm", definitive: false, hint: this.isLocal ? "Czy lokalny serwer modelu działa?" : undefined });
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new UpstreamError(`Lista modeli: HTTP ${res.status}: ${redact(text).slice(0, 200)}`, { source: "llm", httpStatus: res.status, definitive: true });
    try {
      const data = (JSON.parse(text) as { data?: { id?: unknown }[] }).data ?? [];
      return data.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string })).sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      throw new UpstreamError("Lista modeli: odpowiedź nie jest JSON-em zgodnym z OpenAI.", { source: "llm", definitive: true });
    }
  }

  private async chat(body: Record<string, unknown>, allowEmpty = false): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new UpstreamError(
        timeout ? `Model nie odpowiedział w ciągu ${Math.round(this.opts.timeoutMs / 1000)} s.` : `Nie można połączyć się z dostawcą modelu (${new URL(url).host}): ${errorMessage(e)}`,
        {
          source: "llm",
          definitive: false,
          hint: this.isLocal
            ? "Czy lokalny serwer modelu działa? Dla Ollamy: `ollama serve` i `ollama pull <model>`."
            : "Sprawdź adres bazowy dostawcy i połączenie sieciowe; przy długich odpowiedziach zwiększ llm.timeoutMs.",
        },
      );
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "Klucz API dostawcy modelu jest nieprawidłowy lub brak go w ustawieniach."
          : res.status === 404
            ? "Nie znaleziono modelu lub adresu — sprawdź nazwę modelu (Ollama: `ollama list`) i czy adres bazowy kończy się na /v1."
            : res.status === 429
              ? "Limit zapytań dostawcy modelu — odczekaj chwilę."
              : res.status === 400 && this.opts.jsonMode
                ? "Dostawca mógł odrzucić response_format=json_object — wyłącz „Tryb JSON” w ustawieniach."
                : undefined;
      throw new UpstreamError(`Dostawca modelu odpowiedział ${res.status}: ${redact(text).slice(0, 300)}`, {
        source: "llm",
        httpStatus: res.status,
        definitive: true,
        hint,
      });
    }
    let json: { choices?: { message?: { content?: string } }[] };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new UpstreamError("Odpowiedź dostawcy modelu nie jest JSON-em zgodnym z API OpenAI.", { source: "llm", definitive: true });
    }
    const content = json.choices?.[0]?.message?.content;
    if (allowEmpty && typeof content === "string") return content;
    if (typeof content !== "string" || !content.trim()) {
      throw new UpstreamError("Model zwrócił pustą odpowiedź.", { source: "llm", definitive: true, hint: "Spróbuj ponownie lub wybierz inny model." });
    }
    return content;
  }
}

/**
 * Deterministyczny „model” dla trybu demo i testów. Nie wywołuje żadnej sieci;
 * zwraca JSON w tym samym formacie co prawdziwy model, więc przechodzi przez tę
 * samą walidację propozycji.
 */
export class DemoProvider implements LlmProvider {
  readonly mode = "demo" as const;
  readonly isLocal = true;
  readonly label = "model demonstracyjny (reguły, bez AI)";

  async ping(): Promise<PingResult> {
    return { sample: "OK", model: "demo", note: "Model demonstracyjny — brak połączenia sieciowego do sprawdzenia." };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "demo", label: "model demonstracyjny" }];
  }

  async complete(ctx: ChatContext): Promise<string> {
    const q = ctx.question.toLowerCase();
    const proposals: unknown[] = [];
    const docRefs = ctx.docs.map((d) => `[${d.ref}]`).join(", ");
    let answer = ctx.docs.length
      ? `Na podstawie dokumentów ${docRefs}: ${ctx.docs.map((d) => `„${d.title}”`).join(", ")}.`
      : "Nie znalazłem pasujących dokumentów w kolekcjach przypisanych do projektu.";
    if (ctx.tasks.length) answer += `\n\nAktualne zadania: ${ctx.tasks.slice(0, 5).map((t) => `[T${t.workItemId}] ${t.title} (${t.stage?.name ?? "-"})`).join("; ")}.`;

    const defaultLevel = ctx.meta.importanceLevels.find((l) => l.isDefault) ?? ctx.meta.importanceLevels[0];
    const updateMatch = q.match(/(?:#|t)(\d{1,9})\b/);
    if (/(zmie[nń]|zaktualizuj|przesu[nń]|edytuj)/.test(q) && updateMatch) {
      const id = Number(updateMatch[1]);
      const task = ctx.tasks.find((t) => t.workItemId === id);
      const inProgress = ctx.meta.stages.find((s) => /toku|progress/i.test(s.name)) ?? ctx.meta.stages[1];
      if (task && inProgress) {
        proposals.push({
          type: "update",
          workItemId: id,
          changes: { stageId: inProgress.id },
          descriptionParts: {
            summary: task.description || task.title,
            technicalNotes: ctx.docs[0] ? `Powiązana dokumentacja: ${ctx.docs[0].title}.` : undefined,
            sourceRefs: [...(ctx.docs[0] ? [ctx.docs[0].ref] : []), `T${id}`],
          },
          rationale: `Prośba użytkownika; kontekst ${ctx.docs[0] ? `[${ctx.docs[0].ref}]` : "brak dokumentów"}.`,
        });
        answer += `\n\nProponuję przenieść [T${id}] do etapu „${inProgress.name}”.`;
      }
    } else if (/(dodaj|utw[oó]rz|zaplanuj|stw[oó]rz|zaproponuj)/.test(q)) {
      const doc = ctx.docs[0];
      const category = ctx.meta.categories.find((c) => /program/i.test(c.name)) ?? ctx.meta.categories[0];
      const board = ctx.meta.boards.find((b) => b.isDefault) ?? ctx.meta.boards[0];
      const topic = doc ? doc.title : "nowe zadanie";
      proposals.push({
        type: "create",
        title: `Ostrzeżenie o niskim poziomie oleju`.slice(0, 120),
        summary: `Gracz otrzymuje ostrzeżenie, gdy poziom oleju w latarni spada poniżej 20% (na podstawie: „${topic}”).`,
        acceptanceCriteria: ["Ostrzeżenie dźwiękowe i wizualne poniżej 20% oleju", "Ostrzeżenie znika po uzupełnieniu oleju"],
        sourceRefs: doc ? [doc.ref] : [],
        categoryId: category?.id,
        importanceLevelId: defaultLevel?.id,
        boardId: board?.id,
        estimatedCost: 2,
        isStory: false,
        rationale: doc ? `Wymaganie opisane w [${doc.ref}].` : "Prośba użytkownika.",
      });
      if (/(dwa|2|kilka)/.test(q)) {
        proposals.push({
          type: "create",
          title: "Sygnał dźwiękowy nadciągającego sztormu",
          summary: "Dźwięk sztormu narasta 30 s przed jego rozpoczęciem.",
          acceptanceCriteria: ["Sygnał startuje 30 s przed sztormem", "Głośność narasta liniowo"],
          sourceRefs: ctx.docs.filter((d) => /audio/i.test(d.title)).map((d) => d.ref),
          categoryId: ctx.meta.categories.find((c) => /audio/i.test(c.name))?.id ?? category?.id,
          importanceLevelId: defaultLevel?.id,
          boardId: board?.id,
          estimatedCost: 1,
          isStory: false,
          rationale: "Wymaganie z wytycznych audio.",
        });
      }
      answer += `\n\nPrzygotowałem ${proposals.length === 1 ? "propozycję zadania" : `${proposals.length} propozycje zadań`} — sprawdź podgląd i zatwierdź lub odrzuć.`;
    }
    return JSON.stringify({ answer, proposals });
  }
}

export function assertProviderConfigured(p: LlmProvider | null): LlmProvider {
  if (!p) throw new AppError("Dostawca modelu nie jest skonfigurowany.", { status: 400, code: "llm_not_configured", source: "llm" });
  return p;
}
