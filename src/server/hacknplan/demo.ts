import type { Db } from "../db.js";
import { AppError, UpstreamError } from "../errors.js";
import type { CreateWorkItemBody, HacknPlanApi, ProjectMeta, PatchWorkItemBody, WorkItem } from "./types.js";

export const DEMO_META: ProjectMeta = {
  categories: [
    { id: 1, name: "Programowanie" },
    { id: 2, name: "Grafika" },
    { id: 3, name: "Projekt gry" },
    { id: 4, name: "Audio" },
    { id: 5, name: "Błąd" },
  ],
  stages: [
    { id: 1, name: "Do zrobienia", status: "created" },
    { id: 2, name: "W toku", status: "started" },
    { id: 3, name: "Testy", status: "started" },
    { id: 4, name: "Zrobione", status: "completed" },
  ],
  importanceLevels: [
    { id: 1, name: "Pilne" },
    { id: 2, name: "Wysoki" },
    { id: 3, name: "Normalny", isDefault: true },
    { id: 4, name: "Niski" },
  ],
  boards: [
    { id: 10, name: "Sprint 7", isDefault: true },
    { id: 11, name: "Backlog" },
  ],
};

function seed(projectId: number): WorkItem[] {
  const base = (id: number, title: string, catId: number, stageId: number, boardId: number, desc: string, cost: number, updated: string): WorkItem => ({
    workItemId: id,
    projectId,
    title,
    description: desc,
    isStory: false,
    category: DEMO_META.categories.find((c) => c.id === catId) ?? null,
    stage: DEMO_META.stages.find((s) => s.id === stageId) ?? null,
    importanceLevel: DEMO_META.importanceLevels[2] ?? null,
    board: DEMO_META.boards.find((b) => b.id === boardId) ?? null,
    estimatedCost: cost,
    startDate: null,
    dueDate: null,
    updateDate: updated,
    creationDate: "2026-09-01T08:00:00.000Z",
    closingDate: null,
    assignedUsers: [],
  });
  return [
    base(101, "Cykl dnia i nocy", 1, 2, 10, "Przejście dzień/noc z płynną zmianą oświetlenia.", 5, "2026-10-20T10:00:00.000Z"),
    base(102, "Model latarni", 2, 4, 10, "Model 3D latarni z animowaną soczewką.", 8, "2026-10-12T10:00:00.000Z"),
    base(103, "Zużycie oleju w latarni", 1, 1, 10, "Olej zużywa się w nocy; brak oleju gasi światło.", 3, "2026-10-18T10:00:00.000Z"),
    base(104, "Automatyczny zapis o świcie", 1, 1, 11, "Zapis JSON z wersją schematu.", 3, "2026-10-15T10:00:00.000Z"),
  ];
}

/**
 * Fikcyjny HacknPlan dla trybu demo. Dane trzyma w lokalnej bazie SQLite;
 * nigdy nie łączy się z prawdziwym serwisem.
 */
export class DemoHacknPlan implements HacknPlanApi {
  readonly mode = "demo" as const;

  constructor(private readonly db: Db) {}

  private ensureSeeded(projectId: number): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM demo_work_items WHERE project_id = ?`).get(projectId) as { n: number };
    if (row.n > 0) return;
    const ins = this.db.prepare(`INSERT INTO demo_work_items (project_id, work_item_id, json) VALUES (?,?,?)`);
    this.db.transaction(() => {
      for (const w of seed(projectId)) ins.run(projectId, w.workItemId, JSON.stringify(w));
    })();
  }

  private all(projectId: number): WorkItem[] {
    this.ensureSeeded(projectId);
    return (this.db.prepare(`SELECT json FROM demo_work_items WHERE project_id = ?`).all(projectId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as WorkItem,
    );
  }

  async listWorkItems(projectId: number, opts: { limit: number; searchTerms?: string }) {
    let items = this.all(projectId).sort((a, b) => (b.updateDate ?? "").localeCompare(a.updateDate ?? ""));
    if (opts.searchTerms) {
      const t = opts.searchTerms.toLowerCase();
      items = items.filter((w) => w.title.toLowerCase().includes(t) || w.description.toLowerCase().includes(t));
    }
    return { items: items.slice(0, opts.limit), totalCount: items.length };
  }

  async getWorkItem(projectId: number, workItemId: number): Promise<WorkItem> {
    const w = this.all(projectId).find((x) => x.workItemId === workItemId);
    if (!w) {
      throw new UpstreamError(`HacknPlan (demo) odpowiedział 404: zadanie #${workItemId} nie istnieje`, {
        source: "hacknplan",
        httpStatus: 404,
        definitive: true,
      });
    }
    return w;
  }

  async createWorkItem(projectId: number, body: CreateWorkItemBody): Promise<WorkItem> {
    const items = this.all(projectId);
    const id = Math.max(100, ...items.map((w) => w.workItemId)) + 1;
    const ts = new Date().toISOString();
    const w: WorkItem = {
      workItemId: id,
      projectId,
      title: body.title,
      description: body.description ?? "",
      isStory: body.isStory,
      category: DEMO_META.categories.find((c) => c.id === body.categoryId) ?? null,
      stage: DEMO_META.stages[0] ?? null,
      importanceLevel: DEMO_META.importanceLevels.find((l) => l.id === body.importanceLevelId) ?? null,
      board: DEMO_META.boards.find((b) => b.id === body.boardId) ?? null,
      estimatedCost: body.estimatedCost,
      startDate: body.startDate ?? null,
      dueDate: body.dueDate ?? null,
      updateDate: ts,
      creationDate: ts,
      closingDate: null,
      assignedUsers: [],
    };
    this.db.prepare(`INSERT INTO demo_work_items (project_id, work_item_id, json) VALUES (?,?,?)`).run(projectId, id, JSON.stringify(w));
    return w;
  }

  async patchWorkItem(projectId: number, workItemId: number, body: PatchWorkItemBody): Promise<void> {
    const w = await this.getWorkItem(projectId, workItemId);
    const next: WorkItem = { ...w, updateDate: new Date().toISOString() };
    if (body.title !== undefined) next.title = body.title;
    if (body.description !== undefined) next.description = body.description;
    if (body.estimatedCost !== undefined) next.estimatedCost = body.estimatedCost;
    if (body.dueDate !== undefined) next.dueDate = body.dueDate;
    if (body.startDate !== undefined) next.startDate = body.startDate;
    if (body.categoryId !== undefined) next.category = DEMO_META.categories.find((c) => c.id === body.categoryId) ?? null;
    if (body.stageId !== undefined) next.stage = DEMO_META.stages.find((s) => s.id === body.stageId) ?? null;
    if (body.importanceLevelId !== undefined) next.importanceLevel = DEMO_META.importanceLevels.find((l) => l.id === body.importanceLevelId) ?? null;
    if (body.boardId !== undefined) next.board = DEMO_META.boards.find((b) => b.id === body.boardId) ?? null;
    this.db.prepare(`UPDATE demo_work_items SET json = ? WHERE project_id = ? AND work_item_id = ?`).run(JSON.stringify(next), projectId, workItemId);
  }

  async getMeta(_projectId: number): Promise<ProjectMeta> {
    return structuredClone(DEMO_META);
  }

  /** Tylko do demonstracji wykrywania nieaktualnych edycji: symuluje zmianę wprowadzoną przez kogoś innego. */
  touchForDemo(projectId: number, workItemId: number, title: string): void {
    const w = this.all(projectId).find((x) => x.workItemId === workItemId);
    if (!w) throw new AppError("Brak zadania", { status: 404 });
    const next = { ...w, title, updateDate: new Date().toISOString() };
    this.db.prepare(`UPDATE demo_work_items SET json = ? WHERE project_id = ? AND work_item_id = ?`).run(JSON.stringify(next), projectId, workItemId);
  }
}
