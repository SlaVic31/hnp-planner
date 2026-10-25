import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProjectConfig } from "./config.js";
import { type Db, newId, now, recordOperation } from "./db.js";
import { AppError, UpstreamError, errorMessage } from "./errors.js";
import type { CreateWorkItemBody, HacknPlanApi, PatchWorkItemBody, ProjectMeta, WorkItem } from "./hacknplan/types.js";
import { DEFAULT_DESCRIPTION_TEMPLATE, type DescriptionSource, DescriptionPartsInput, TemplateError, renderDescription, templateHash } from "./template.js";

export type ProposalStatus = "pending" | "executing" | "succeeded" | "failed" | "rejected" | "stale" | "outcome_unknown";

const dateSchema = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s)), "Nieprawidłowa data (oczekiwano RRRR-MM-DD)")
  .transform((s) => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s).toISOString());
const id = z.number().int().positive();
const cost = z.number().min(0).max(10000);
const title = z.string().trim().min(1, "Tytuł nie może być pusty").max(200, "Tytuł może mieć maks. 200 znaków");
const description = z.string().max(20000, "Opis może mieć maks. 20000 znaków");

/** Dozwolone pola propozycji utworzenia — nieznane pola powodują odrzucenie propozycji. */
export const CreatePayloadSchema = z
  .object({
    title,
    description: description.optional(),
    categoryId: id.optional(),
    importanceLevelId: id.optional(),
    boardId: id.optional(),
    estimatedCost: cost.optional(),
    isStory: z.boolean().optional(),
    startDate: dateSchema.optional(),
    dueDate: dateSchema.optional(),
  })
  .strict();

export const UpdateChangesSchema = z
  .object({
    title: title.optional(),
    description: description.optional(),
    categoryId: id.optional(),
    stageId: id.optional(),
    importanceLevelId: id.optional(),
    boardId: id.optional(),
    estimatedCost: cost.optional(),
    startDate: dateSchema.optional(),
    dueDate: dateSchema.optional(),
  })
  .strict()
  .refine((c) => Object.keys(c).length > 0, "Edycja musi zmieniać co najmniej jedno pole");

const RawProposalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), rationale: z.string().max(2000).optional() }).passthrough(),
  z
    .object({
      type: z.literal("update"),
      workItemId: z.coerce.number().int().positive(),
      changes: z.record(z.string(), z.unknown()),
      /** Opcjonalnie: nowy opis budowany z części według szablonu projektu. */
      descriptionParts: z.record(z.string(), z.unknown()).optional(),
      rationale: z.string().max(2000).optional(),
    })
    .passthrough(),
]);

type UpdateField = keyof z.infer<typeof UpdateChangesSchema>;

export const FIELD_LABELS: Record<string, string> = {
  title: "Tytuł",
  description: "Opis",
  categoryId: "Kategoria",
  stageId: "Etap",
  importanceLevelId: "Priorytet",
  boardId: "Tablica",
  estimatedCost: "Szacowany koszt",
  isStory: "Historyjka (story)",
  startDate: "Data rozpoczęcia",
  dueDate: "Termin",
};

export interface ProposalView {
  id: string;
  projectId: string;
  hacknplanProjectId: number;
  conversationId: string | null;
  messageId: string | null;
  kind: "create" | "update";
  workItemId: number | null;
  payload: Record<string, unknown>;
  base: { updateDate: string | null; before: Record<string, unknown> } | null;
  display: { fields: { field: string; label: string; before?: string; after: string }[]; taskTitle?: string; templateHash?: string };
  rationale: string;
  payloadHash: string;
  status: ProposalStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
}

interface ProposalRow {
  id: string;
  project_id: string;
  hacknplan_project_id: number;
  conversation_id: string | null;
  message_id: string | null;
  kind: "create" | "update";
  work_item_id: number | null;
  payload_json: string;
  base_json: string | null;
  display_json: string;
  rationale: string;
  payload_hash: string;
  status: ProposalStatus;
  result_json: string | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  finished_at: string | null;
}

function toView(r: ProposalRow): ProposalView {
  return {
    id: r.id,
    projectId: r.project_id,
    hacknplanProjectId: r.hacknplan_project_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    kind: r.kind,
    workItemId: r.work_item_id,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    base: r.base_json ? (JSON.parse(r.base_json) as ProposalView["base"]) : null,
    display: JSON.parse(r.display_json) as ProposalView["display"],
    rationale: r.rationale,
    payloadHash: r.payload_hash,
    status: r.status,
    result: r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
    error: r.error,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    finishedAt: r.finished_at,
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function hashProposal(p: { kind: string; projectId: string; hacknplanProjectId: number; workItemId: number | null; payload: unknown; base: unknown }): string {
  const { kind, projectId, hacknplanProjectId, workItemId, payload, base } = p;
  return createHash("sha256").update(canonical({ kind, projectId, hacknplanProjectId, workItemId, payload, base })).digest("hex");
}

/** Bieżąca wartość pola zadania w postaci porównywalnej z polem propozycji. */
export function currentValue(w: WorkItem, field: string): unknown {
  switch (field) {
    case "title":
      return w.title;
    case "description":
      return w.description;
    case "categoryId":
      return w.category?.id ?? null;
    case "stageId":
      return w.stage?.id ?? null;
    case "importanceLevelId":
      return w.importanceLevel?.id ?? null;
    case "boardId":
      return w.board?.id ?? null;
    case "estimatedCost":
      return w.estimatedCost;
    case "startDate":
      return w.startDate ? w.startDate.slice(0, 10) : null;
    case "dueDate":
      return w.dueDate ? w.dueDate.slice(0, 10) : null;
    default:
      return undefined;
  }
}

function comparable(field: string, v: unknown): unknown {
  if ((field === "dueDate" || field === "startDate") && typeof v === "string") return v.slice(0, 10);
  return v ?? null;
}

function nameOf(meta: ProjectMeta, field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const list =
    field === "categoryId" ? meta.categories : field === "stageId" ? meta.stages : field === "importanceLevelId" ? meta.importanceLevels : field === "boardId" ? meta.boards : null;
  if (list) return `${list.find((x) => x.id === v)?.name ?? "?"} (#${String(v)})`;
  if (field === "dueDate" || field === "startDate") return String(v).slice(0, 10);
  if (typeof v === "boolean") return v ? "tak" : "nie";
  return String(v);
}

function checkIds(meta: ProjectMeta, p: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const check = (field: string, list: { id: number; closed?: boolean }[], label: string) => {
    const v = p[field];
    if (v === undefined) return;
    const found = list.find((x) => x.id === v);
    if (!found) errs.push(`${label} #${String(v)} nie istnieje w projekcie`);
    else if (found.closed) errs.push(`${label} #${String(v)} jest zamknięta`);
  };
  check("categoryId", meta.categories, "Kategoria");
  check("stageId", meta.stages, "Etap");
  check("importanceLevelId", meta.importanceLevels, "Priorytet");
  check("boardId", meta.boards, "Tablica");
  return errs;
}

/** Kontekst propozycji: metadane, zadania i źródła faktycznie przekazane modelowi. */
export interface StoreContext {
  conversationId: string | null;
  messageId: string | null;
  meta: ProjectMeta;
  tasks: WorkItem[];
  /** Źródła (D1…, T123), do których model może się odwołać w sourceRefs. */
  sources?: DescriptionSource[];
  /** Chwila przygotowania propozycji — ustala {{date}} (deterministycznie w obrębie propozycji). */
  now?: Date;
}

const PART_KEYS = ["summary", "acceptanceCriteria", "technicalNotes", "sourceRefs"] as const;

/**
 * Renderuje opis według szablonu projektu. Wynik trafia do payloadu PRZED obliczeniem hasha,
 * więc zatwierdzany jest dokładnie wyświetlony tekst; późniejsza zmiana szablonu nie zmienia propozycji.
 */
function renderParts(project: ProjectConfig, title: string, rawParts: Record<string, unknown>, ctx: StoreContext): { description: string; templateHash: string } {
  const parsed = DescriptionPartsInput.safeParse(dropNulls(rawParts));
  if (!parsed.success) throw new AppError(`Opis: ${zodMsg(parsed.error)}`);
  const parts = parsed.data;
  const known = new Map((ctx.sources ?? []).map((s) => [s.ref, s]));
  const unknownRefs = (parts.sourceRefs ?? []).filter((r) => !known.has(r));
  if (unknownRefs.length) throw new AppError(`Odwołania do źródeł spoza kontekstu: ${unknownRefs.join(", ")} — propozycja musi opierać się na przekazanych dokumentach i zadaniach`);
  const template = project.descriptionTemplate ?? DEFAULT_DESCRIPTION_TEMPLATE;
  try {
    const description = renderDescription(
      template,
      {
        summary: parts.summary ?? "",
        acceptanceCriteria: parts.acceptanceCriteria ?? [],
        technicalNotes: parts.technicalNotes ?? "",
        sources: [...new Set(parts.sourceRefs ?? [])].map((r) => known.get(r)!),
      },
      { title, project: project.name, date: (ctx.now ?? new Date()).toISOString().slice(0, 10) },
    );
    return { description, templateHash: templateHash(template) };
  } catch (e) {
    if (e instanceof TemplateError) throw new AppError(`Szablon opisu: ${e.message}`);
    throw e;
  }
}

export interface RejectedProposal {
  index: number;
  reason: string;
}

export class ProposalService {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      getProject(id: string): ProjectConfig | undefined;
      hacknplan(): HacknPlanApi;
      taskUrl(projectId: number, workItemId: number): string;
    },
  ) {}

  /** Po restarcie: propozycje przerwane w trakcie wykonania mają nieznany wynik — nigdy nie ponawiamy ich automatycznie. */
  recoverInterrupted(): number {
    const rows = this.db.prepare(`SELECT id, project_id FROM proposals WHERE status = 'executing'`).all() as { id: string; project_id: string }[];
    for (const r of rows) {
      this.db
        .prepare(`UPDATE proposals SET status = 'outcome_unknown', error = ?, finished_at = ? WHERE id = ? AND status = 'executing'`)
        .run("Aplikacja została zatrzymana w trakcie zapisu — sprawdź stan w HacknPlan.", now(), r.id);
      recordOperation(this.db, { projectId: r.project_id, proposalId: r.id, action: "recover", outcome: "outcome_unknown" });
    }
    return rows.length;
  }

  /**
   * Waliduje surowe propozycje modelu względem metadanych i zadań projektu
   * i zapisuje poprawne jako oczekujące (pending). Nic nie jest wysyłane do HacknPlan.
   */
  storeFromModel(
    project: ProjectConfig,
    raw: unknown[],
    ctx: StoreContext,
  ): { created: ProposalView[]; rejected: RejectedProposal[] } {
    const created: ProposalView[] = [];
    const rejected: RejectedProposal[] = [];
    raw.slice(0, 10).forEach((item, index) => {
      try {
        created.push(this.storeOne(project, item, ctx));
      } catch (e) {
        rejected.push({ index, reason: errorMessage(e) });
      }
    });
    if (raw.length > 10) rejected.push({ index: 10, reason: `Pominięto ${raw.length - 10} nadmiarowych propozycji (limit 10 na odpowiedź)` });
    for (const r of rejected) {
      recordOperation(this.db, { projectId: project.id, action: "proposal_rejected_by_validation", outcome: "rejected", detail: r });
    }
    return { created, rejected };
  }

  private storeOne(
    project: ProjectConfig,
    item: unknown,
    ctx: StoreContext,
  ): ProposalView {
    const parsedRaw = RawProposalSchema.safeParse(item);
    if (!parsedRaw.success) throw new AppError(`Nieprawidłowa struktura propozycji: ${parsedRaw.error.issues.map((i) => i.message).join("; ")}`);
    const raw = parsedRaw.data;
    const { meta } = ctx;
    let payload: Record<string, unknown>;
    let base: ProposalView["base"] = null;
    let workItemId: number | null = null;
    const fields: ProposalView["display"]["fields"] = [];
    let taskTitle: string | undefined;
    let usedTemplate: string | undefined;

    if (raw.type === "create") {
      const { type: _t, rationale: _r, ...rest } = raw;
      // Części opisu (summary, kryteria, uwagi, źródła) → opis z szablonu projektu.
      const partsRaw: Record<string, unknown> = {};
      for (const k of PART_KEYS) {
        if (k in rest) {
          partsRaw[k] = rest[k];
          delete rest[k];
        }
      }
      if (rest.description !== undefined && rest.description !== null) {
        // Zgodność wstecz: zwykły „description” traktujemy jako summary.
        if (partsRaw.summary !== undefined) throw new AppError("Podaj „summary” albo „description”, nie oba");
        partsRaw.summary = rest.description;
      }
      delete rest.description;
      const titleText = typeof rest.title === "string" ? rest.title : "";
      const rendered = renderParts(project, titleText, partsRaw, ctx);
      if (rendered.description) rest.description = rendered.description;
      usedTemplate = rendered.templateHash;
      const parsed = CreatePayloadSchema.safeParse(dropNulls(rest));
      if (!parsed.success) throw new AppError(zodMsg(parsed.error));
      const p = parsed.data;
      const defaultLevel = meta.importanceLevels.find((l) => l.isDefault) ?? meta.importanceLevels[0];
      const importanceLevelId = p.importanceLevelId ?? defaultLevel?.id;
      if (importanceLevelId === undefined) throw new AppError("Projekt nie ma zdefiniowanych priorytetów — HacknPlan wymaga importanceLevelId");
      payload = { ...p, importanceLevelId, estimatedCost: p.estimatedCost ?? 0, isStory: p.isStory ?? false };
      const errs = checkIds(meta, payload);
      if (errs.length) throw new AppError(errs.join("; "));
      const dup = ctx.tasks.find((t) => t.title.trim().toLowerCase() === p.title.trim().toLowerCase());
      if (dup) throw new AppError(`Zadanie o tytule „${p.title}” już istnieje (#${dup.workItemId}) — pominięto, aby uniknąć duplikatu`);
      for (const [k, v] of Object.entries(payload)) fields.push({ field: k, label: FIELD_LABELS[k] ?? k, after: nameOf(meta, k, v) });
    } else {
      workItemId = raw.workItemId;
      const task = ctx.tasks.find((t) => t.workItemId === workItemId);
      if (!task) throw new AppError(`Zadanie #${workItemId} nie należy do bieżących zadań projektu ${project.name}`);
      if (task.projectId !== project.hacknplanProjectId) throw new AppError(`Zadanie #${workItemId} należy do innego projektu HacknPlan`);
      const changesRaw: Record<string, unknown> = { ...raw.changes };
      if (raw.descriptionParts) {
        if (changesRaw.description !== undefined) throw new AppError("Podaj „descriptionParts” albo „changes.description”, nie oba");
        const titleForRender = typeof changesRaw.title === "string" ? changesRaw.title : task.title;
        const rendered = renderParts(project, titleForRender, raw.descriptionParts, ctx);
        changesRaw.description = rendered.description;
        usedTemplate = rendered.templateHash;
      }
      const parsed = UpdateChangesSchema.safeParse(dropNulls(changesRaw));
      if (!parsed.success) throw new AppError(zodMsg(parsed.error));
      const changes: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed.data)) {
        const cur = currentValue(task, k);
        if (comparable(k, cur) === comparable(k, v)) continue; // brak faktycznej zmiany
        changes[k] = v;
        before[k] = cur ?? null;
      }
      if (Object.keys(changes).length === 0) throw new AppError(`Propozycja edycji #${workItemId} nie zmienia żadnego pola`);
      const errs = checkIds(meta, changes);
      if (errs.length) throw new AppError(errs.join("; "));
      payload = changes;
      base = { updateDate: task.updateDate, before };
      taskTitle = task.title;
      for (const [k, v] of Object.entries(changes)) fields.push({ field: k, label: FIELD_LABELS[k] ?? k, before: nameOf(meta, k, before[k]), after: nameOf(meta, k, v) });
    }

    const view = {
      id: newId(),
      projectId: project.id,
      hacknplanProjectId: project.hacknplanProjectId,
      kind: raw.type,
      workItemId,
      payload,
      base,
    };
    const hash = hashProposal(view);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO proposals (id, project_id, hacknplan_project_id, conversation_id, message_id, kind, work_item_id, payload_json, base_json, display_json, rationale, payload_hash, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(
        view.id,
        project.id,
        project.hacknplanProjectId,
        ctx.conversationId,
        ctx.messageId,
        view.kind,
        workItemId,
        JSON.stringify(payload),
        base ? JSON.stringify(base) : null,
        JSON.stringify({ fields, taskTitle, templateHash: usedTemplate }),
        (raw.rationale ?? "").slice(0, 2000),
        hash,
        ts,
      );
    recordOperation(this.db, { projectId: project.id, proposalId: view.id, action: `propose_${view.kind}`, outcome: "pending", detail: { workItemId } });
    return this.get(view.id);
  }

  get(proposalId: string): ProposalView {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined;
    if (!row) throw new AppError("Nie znaleziono propozycji", { status: 404, code: "proposal_not_found" });
    return toView(row);
  }

  list(projectId: string, opts: { status?: string; limit?: number } = {}): ProposalView[] {
    const rows = (
      opts.status
        ? this.db.prepare(`SELECT * FROM proposals WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, opts.status, opts.limit ?? 200)
        : this.db.prepare(`SELECT * FROM proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, opts.limit ?? 200)
    ) as ProposalRow[];
    return rows.map(toView);
  }

  listForMessage(messageId: string): ProposalView[] {
    return (this.db.prepare(`SELECT * FROM proposals WHERE message_id = ? ORDER BY created_at`).all(messageId) as ProposalRow[]).map(toView);
  }

  reject(proposalId: string, expectedHash: string): ProposalView {
    const p = this.get(proposalId);
    if (p.payloadHash !== expectedHash) throw new AppError("Propozycja różni się od wyświetlonej — odśwież widok.", { status: 409, code: "hash_mismatch" });
    const res = this.db.prepare(`UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`).run(now(), proposalId);
    if (res.changes !== 1) throw new AppError(`Propozycja została już rozpatrzona (status: ${statusLabel(p.status)}).`, { status: 409, code: "already_decided" });
    recordOperation(this.db, { projectId: p.projectId, proposalId, action: "reject", outcome: "rejected" });
    return this.get(proposalId);
  }

  /**
   * Zatwierdza i wykonuje DOKŁADNIE zapisaną na serwerze propozycję.
   * - hash musi odpowiadać treści wyświetlonej użytkownikowi,
   * - przejście pending → executing jest atomowe (drugie zatwierdzenie dostaje 409),
   * - nieudane utworzenie z nieznanym wynikiem NIE jest ponawiane automatycznie.
   */
  async approve(proposalId: string, expectedHash: string): Promise<ProposalView> {
    const claim = this.db.transaction(() => {
      const p = this.get(proposalId);
      if (p.status !== "pending") throw new AppError(`Propozycja została już rozpatrzona (status: ${statusLabel(p.status)}). Nie wykonano jej ponownie.`, { status: 409, code: "already_decided" });
      if (p.payloadHash !== expectedHash) throw new AppError("Propozycja różni się od wyświetlonej — odśwież widok i sprawdź ją ponownie.", { status: 409, code: "hash_mismatch" });
      // Hash weryfikujemy także względem zapisanej treści — wykrywa modyfikację wiersza poza aplikacją.
      if (hashProposal(p) !== p.payloadHash) throw new AppError("Zapisana propozycja jest niespójna (hash) — odrzuć ją.", { status: 409, code: "integrity_error" });
      const project = this.deps.getProject(p.projectId);
      if (!project || project.hacknplanProjectId !== p.hacknplanProjectId) {
        throw new AppError("Projekt propozycji nie jest już skonfigurowany lub zmienił się jego identyfikator HacknPlan — propozycji nie wykonano.", {
          status: 409,
          code: "project_scope_changed",
        });
      }
      const res = this.db.prepare(`UPDATE proposals SET status = 'executing', decided_at = ? WHERE id = ? AND status = 'pending'`).run(now(), proposalId);
      if (res.changes !== 1) throw new AppError("Propozycja jest już wykonywana.", { status: 409, code: "already_decided" });
      recordOperation(this.db, { projectId: p.projectId, proposalId, action: "approve", outcome: "executing" });
      return p;
    });
    const p = claim.immediate();
    return this.execute(p);
  }

  private finish(p: ProposalView, status: ProposalStatus, result: Record<string, unknown> | null, error: string | null, action: string): ProposalView {
    this.db
      .prepare(`UPDATE proposals SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'executing'`)
      .run(status, result ? JSON.stringify(result) : null, error, now(), p.id);
    recordOperation(this.db, { projectId: p.projectId, proposalId: p.id, action, outcome: status, detail: { workItemId: result?.workItemId ?? p.workItemId, error } });
    return this.get(p.id);
  }

  private async execute(p: ProposalView): Promise<ProposalView> {
    const api = this.deps.hacknplan();
    const hp = p.hacknplanProjectId;
    if (p.kind === "create") {
      try {
        const body = p.payload as unknown as CreateWorkItemBody;
        const created = await api.createWorkItem(hp, body);
        return this.finish(p, "succeeded", { workItemId: created.workItemId, url: this.deps.taskUrl(hp, created.workItemId), title: created.title }, null, "execute_create");
      } catch (e) {
        return this.finish(p, failureStatus(e), null, describe(e), "execute_create");
      }
    }
    // Edycja: najpierw sprawdzamy, czy zadanie nie zmieniło się od czasu przygotowania propozycji.
    const workItemId = p.workItemId!;
    let current: WorkItem;
    try {
      current = await api.getWorkItem(hp, workItemId);
    } catch (e) {
      return this.finish(p, "failed", null, `Nie udało się odczytać zadania przed zapisem: ${describe(e)}`, "execute_update");
    }
    if (current.projectId !== hp) return this.finish(p, "failed", null, "Zadanie należy do innego projektu HacknPlan — zapis zablokowany.", "execute_update");
    const conflicts: string[] = [];
    if (p.base?.updateDate && current.updateDate && p.base.updateDate !== current.updateDate) conflicts.push(`zadanie zmodyfikowano ${current.updateDate}`);
    for (const [k, before] of Object.entries(p.base?.before ?? {})) {
      if (comparable(k, currentValue(current, k)) !== comparable(k, before)) conflicts.push(`pole „${FIELD_LABELS[k] ?? k}” ma inną wartość niż w propozycji`);
    }
    if (conflicts.length) {
      return this.finish(p, "stale", { currentUpdateDate: current.updateDate }, `Zadanie zmieniło się od przygotowania propozycji (${conflicts.join("; ")}). Nic nie zapisano — poproś o nową propozycję.`, "stale_detected");
    }
    try {
      await api.patchWorkItem(hp, workItemId, p.payload as PatchWorkItemBody);
    } catch (e) {
      return this.finish(p, failureStatus(e), null, describe(e), "execute_update");
    }
    let after: WorkItem | null = null;
    try {
      after = await api.getWorkItem(hp, workItemId);
    } catch {
      /* zapis się udał; brak odczytu kontrolnego nie zmienia wyniku */
    }
    return this.finish(p, "succeeded", { workItemId, url: this.deps.taskUrl(hp, workItemId), title: after?.title ?? current.title, updateDate: after?.updateDate ?? null }, null, "execute_update");
  }

  /** Zatwierdza wiele propozycji po kolei; zwraca wynik każdej (także częściowe niepowodzenia). */
  async approveMany(items: { id: string; payloadHash: string }[]): Promise<{ id: string; ok: boolean; proposal?: ProposalView; error?: string }[]> {
    const out: { id: string; ok: boolean; proposal?: ProposalView; error?: string }[] = [];
    for (const it of items) {
      try {
        const proposal = await this.approve(it.id, it.payloadHash);
        out.push({ id: it.id, ok: proposal.status === "succeeded", proposal });
      } catch (e) {
        out.push({ id: it.id, ok: false, error: errorMessage(e) });
      }
    }
    return out;
  }

  /**
   * Dla propozycji o nieznanym wyniku: sprawdza w HacknPlan, czy zapis faktycznie nastąpił.
   * Nie wykonuje żadnego zapisu.
   */
  async reconcile(proposalId: string): Promise<{ proposal: ProposalView; found: boolean; message: string }> {
    const p = this.get(proposalId);
    if (p.status !== "outcome_unknown") throw new AppError("Weryfikacja dotyczy tylko propozycji o nieznanym wyniku.", { status: 409, code: "not_unknown" });
    const api = this.deps.hacknplan();
    const hp = p.hacknplanProjectId;
    const set = (status: ProposalStatus, result: Record<string, unknown> | null, error: string | null) => {
      this.db.prepare(`UPDATE proposals SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'outcome_unknown'`).run(status, result ? JSON.stringify(result) : null, error, now(), p.id);
      recordOperation(this.db, { projectId: p.projectId, proposalId: p.id, action: "reconcile", outcome: status, detail: result ?? {} });
    };
    if (p.kind === "create") {
      const titleText = String(p.payload.title);
      const { items } = await api.listWorkItems(hp, { limit: 50, searchTerms: titleText });
      const since = Date.parse(p.decidedAt ?? p.createdAt) - 120_000;
      const match = items.find((w) => w.title.trim() === titleText.trim() && (!w.creationDate || Date.parse(w.creationDate) >= since));
      if (match) {
        set("succeeded", { workItemId: match.workItemId, url: this.deps.taskUrl(hp, match.workItemId), title: match.title, reconciled: true }, null);
        return { proposal: this.get(p.id), found: true, message: `Zadanie istnieje w HacknPlan (#${match.workItemId}) — oznaczono jako wykonane.` };
      }
      return {
        proposal: p,
        found: false,
        message: "Nie znaleziono zadania o tym tytule utworzonego po zatwierdzeniu. Jeśli masz pewność, że nie powstało, możesz utworzyć nową propozycję do ponownego zatwierdzenia.",
      };
    }
    const current = await api.getWorkItem(hp, p.workItemId!);
    const applied = Object.entries(p.payload).every(([k, v]) => comparable(k, currentValue(current, k)) === comparable(k, v));
    if (applied) {
      set("succeeded", { workItemId: current.workItemId, url: this.deps.taskUrl(hp, current.workItemId), title: current.title, reconciled: true }, null);
      return { proposal: this.get(p.id), found: true, message: "Zmiany są widoczne w HacknPlan — oznaczono jako wykonane." };
    }
    set("failed", null, "Weryfikacja: zmiany nie zostały zastosowane w HacknPlan.");
    return { proposal: this.get(p.id), found: false, message: "Zmiany nie zostały zastosowane. Możesz utworzyć nową propozycję do ponownego zatwierdzenia." };
  }

  /**
   * Tworzy NOWĄ oczekującą propozycję z treścią nieudanej/niezweryfikowanej (wymaga ponownego zatwierdzenia).
   * Dla nieznanego wyniku tworzenia wymaga wcześniejszej weryfikacji, która nie znalazła zadania.
   */
  requeue(proposalId: string, opts: { confirmNotCreated: boolean }): ProposalView {
    const p = this.get(proposalId);
    if (!["failed", "stale", "outcome_unknown"].includes(p.status)) throw new AppError("Ponowić można tylko propozycję nieudaną lub o nieznanym wyniku.", { status: 409, code: "not_requeueable" });
    if (p.status === "outcome_unknown" && !opts.confirmNotCreated) {
      throw new AppError("Wynik zapisu jest nieznany. Najpierw zweryfikuj stan w HacknPlan i potwierdź, że zadanie nie powstało.", { status: 409, code: "confirm_required" });
    }
    if (p.status === "stale") throw new AppError("Zadanie zmieniło się — poproś w czacie o nową propozycję opartą na aktualnym stanie.", { status: 409, code: "stale_requeue" });
    const newIdValue = newId();
    const view = { id: newIdValue, projectId: p.projectId, hacknplanProjectId: p.hacknplanProjectId, kind: p.kind, workItemId: p.workItemId, payload: p.payload, base: p.base };
    const hash = hashProposal(view);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO proposals (id, project_id, hacknplan_project_id, conversation_id, message_id, kind, work_item_id, payload_json, base_json, display_json, rationale, payload_hash, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
        )
        .run(newIdValue, p.projectId, p.hacknplanProjectId, p.conversationId, p.messageId, p.kind, p.workItemId, JSON.stringify(p.payload), p.base ? JSON.stringify(p.base) : null, JSON.stringify(p.display), p.rationale, hash, now());
      if (p.status === "outcome_unknown") {
        this.db.prepare(`UPDATE proposals SET status = 'failed', error = ? WHERE id = ? AND status = 'outcome_unknown'`).run(`Użytkownik potwierdził brak zapisu; zastąpiona przez ${newIdValue}`, p.id);
      }
      recordOperation(this.db, { projectId: p.projectId, proposalId: newIdValue, action: "requeue", outcome: "pending", detail: { from: p.id } });
    })();
    return this.get(newIdValue);
  }
}

function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

function zodMsg(e: z.ZodError): string {
  return e.issues
    .map((i) => (i.code === "unrecognized_keys" ? `Niedozwolone pola: ${(i as { keys: string[] }).keys.join(", ")}` : `${i.path.join(".") || "propozycja"}: ${i.message}`))
    .join("; ");
}

function failureStatus(e: unknown): ProposalStatus {
  if (e instanceof UpstreamError) return e.upstream.definitive ? "failed" : "outcome_unknown";
  if (e instanceof AppError) return "failed"; // błąd lokalny przed wysłaniem żądania
  return "outcome_unknown";
}

function describe(e: unknown): string {
  const msg = errorMessage(e);
  const hint = e instanceof AppError ? e.opts.hint : undefined;
  return hint ? `${msg} — ${hint}` : msg;
}

export function statusLabel(s: ProposalStatus): string {
  return (
    {
      pending: "oczekuje",
      executing: "w trakcie wykonania",
      succeeded: "wykonana",
      failed: "nieudana",
      rejected: "odrzucona",
      stale: "nieaktualna",
      outcome_unknown: "wynik nieznany",
    } as const
  )[s];
}

/** Do testów jednostkowych. */
export const _internal = { canonical };
export type { UpdateField };
