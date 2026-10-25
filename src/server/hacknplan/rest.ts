import { AppError, UpstreamError, errorMessage, redact } from "../errors.js";
import type { CreateWorkItemBody, HacknPlanApi, Named, PatchWorkItemBody, ProjectMeta, WorkItem } from "./types.js";

export interface RestOptions {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

/**
 * Klient publicznego API HacknPlan v0 (https://api.hacknplan.com/v0).
 * Uwierzytelnienie: nagłówek `Authorization: ApiKey <klucz>`.
 * Wymagane zakresy klucza: Projects Read, Work Items Read, Work Items Write.
 */
export class RestHacknPlan implements HacknPlanApi {
  readonly mode = "api" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RestOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.opts.apiKey) {
      throw new AppError("Brak klucza API HacknPlan. Ustaw go w Ustawieniach lub w zmiennej HNP_HACKNPLAN_API_KEY.", {
        status: 400,
        code: "hacknplan_no_key",
        source: "hacknplan",
      });
    }
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `ApiKey ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      // Brak odpowiedzi: nie wiadomo, czy serwer wykonał zapis.
      throw new UpstreamError(`Brak odpowiedzi od HacknPlan (${method} ${path}): ${errorMessage(e)}`, {
        source: "hacknplan",
        definitive: false,
        hint: "Sprawdź połączenie sieciowe. Jeśli to był zapis, sprawdź w HacknPlan, czy zmiana się wykonała, zanim spróbujesz ponownie.",
      });
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const definitive = res.status >= 400 && res.status < 500;
      throw new UpstreamError(`HacknPlan odpowiedział ${res.status} na ${method} ${path}${text ? `: ${redact(text).slice(0, 300)}` : ""}`, {
        source: "hacknplan",
        httpStatus: res.status,
        definitive,
        hint: hintForStatus(res.status),
      });
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError(`HacknPlan zwrócił odpowiedź, która nie jest JSON-em (${method} ${path}).`, {
        source: "hacknplan",
        httpStatus: res.status,
        definitive: true,
      });
    }
  }

  async listWorkItems(projectId: number, opts: { limit: number; searchTerms?: string }) {
    const items: WorkItem[] = [];
    let totalCount = 0;
    for (let offset = 0; items.length < opts.limit; offset += 100) {
      const q = new URLSearchParams({
        offset: String(offset),
        limit: String(Math.min(100, opts.limit - items.length)),
        sortField: "updatedate",
        sortMode: "desc",
      });
      if (opts.searchTerms) q.set("searchTerms", opts.searchTerms);
      const page = (await this.request("GET", `/projects/${projectId}/workitems?${q}`)) as Json | null;
      const pageItems = Array.isArray(page?.items) ? (page.items as Json[]) : [];
      totalCount = typeof page?.totalCount === "number" ? page.totalCount : pageItems.length;
      items.push(...pageItems.map(toWorkItem));
      if (pageItems.length === 0 || items.length >= totalCount) break;
    }
    return { items, totalCount };
  }

  async getWorkItem(projectId: number, workItemId: number): Promise<WorkItem> {
    return toWorkItem((await this.request("GET", `/projects/${projectId}/workitems/${workItemId}`)) as Json);
  }

  async createWorkItem(projectId: number, body: CreateWorkItemBody): Promise<WorkItem> {
    const res = (await this.request("POST", `/projects/${projectId}/workitems`, body)) as Json | null;
    if (!res || typeof res.workItemId !== "number") {
      throw new UpstreamError("HacknPlan potwierdził utworzenie, ale nie zwrócił identyfikatora zadania.", {
        source: "hacknplan",
        definitive: false,
        hint: "Sprawdź w HacknPlan, czy zadanie powstało.",
      });
    }
    return toWorkItem(res);
  }

  async patchWorkItem(projectId: number, workItemId: number, body: PatchWorkItemBody): Promise<void> {
    await this.request("PATCH", `/projects/${projectId}/workitems/${workItemId}`, body);
  }

  async getMeta(projectId: number): Promise<ProjectMeta> {
    const [categories, stages, importanceLevels, boards] = (await Promise.all([
      this.request("GET", `/projects/${projectId}/categories`),
      this.request("GET", `/projects/${projectId}/stages`),
      this.request("GET", `/projects/${projectId}/importancelevels`),
      this.request("GET", `/projects/${projectId}/boards?includeClosed=false`),
    ])) as Json[][];
    return {
      categories: (categories ?? []).map((c) => ({ id: num(c.categoryId), name: str(c.name) })),
      stages: (stages ?? []).map((s) => ({ id: num(s.stageId), name: str(s.name), status: optStr(s.status) })),
      importanceLevels: (importanceLevels ?? []).map((l) => ({ id: num(l.importanceLevelId), name: str(l.name), isDefault: l.isDefault === true })),
      boards: (boards ?? []).map((b) => ({ id: num(b.boardId), name: str(b.name), isDefault: b.isDefault === true, closed: !!b.closingDate })),
    };
  }
}

function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 400:
      return "HacknPlan odrzucił dane (np. nieistniejąca kategoria lub tablica). Nic nie zostało zapisane.";
    case 401:
      return "Klucz API HacknPlan jest nieprawidłowy lub odwołany.";
    case 403:
      return "Klucz API nie ma wymaganego zakresu (Projects Read, Work Items Read/Write) albo użytkownik nie ma uprawnień w projekcie.";
    case 404:
      return "Projekt lub zadanie nie istnieje albo nie masz do niego dostępu — sprawdź identyfikator projektu HacknPlan.";
    case 429:
      return "Przekroczono limit zapytań HacknPlan — odczekaj chwilę.";
    default:
      return status >= 500 ? "Błąd po stronie HacknPlan. Jeśli to był zapis, sprawdź stan zadania przed ponowieniem." : undefined;
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : v == null ? undefined : String(v));
const optNamed = (v: unknown, idKey: string): Named | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Json;
  return typeof o[idKey] === "number" ? { id: o[idKey] as number, name: str(o.name) } : null;
};

export function toWorkItem(o: Json): WorkItem {
  const stage = optNamed(o.stage, "stageId");
  return {
    workItemId: num(o.workItemId),
    projectId: num(o.projectId),
    title: str(o.title),
    description: str(o.description),
    isStory: o.isStory === true,
    category: optNamed(o.category, "categoryId"),
    stage: stage ? { ...stage, status: optStr((o.stage as Json).status) } : null,
    importanceLevel: optNamed(o.importanceLevel, "importanceLevelId"),
    board: optNamed(o.board, "boardId"),
    estimatedCost: typeof o.estimatedCost === "number" ? o.estimatedCost : null,
    startDate: optStr(o.startDate) ?? null,
    dueDate: optStr(o.dueDate) ?? null,
    updateDate: optStr(o.updateDate) ?? null,
    creationDate: optStr(o.creationDate) ?? null,
    closingDate: optStr(o.closingDate) ?? null,
    assignedUsers: Array.isArray(o.assignedUsers)
      ? (o.assignedUsers as Json[]).map((u) => str((u.user as Json | undefined)?.name ?? (u.user as Json | undefined)?.username ?? ""))
      : [],
  };
}
