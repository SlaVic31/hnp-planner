export interface Named {
  id: number;
  name: string;
}

export interface WorkItem {
  workItemId: number;
  projectId: number;
  title: string;
  description: string;
  isStory: boolean;
  category: Named | null;
  stage: (Named & { status?: string }) | null;
  importanceLevel: Named | null;
  board: Named | null;
  estimatedCost: number | null;
  startDate: string | null;
  dueDate: string | null;
  updateDate: string | null;
  creationDate: string | null;
  closingDate: string | null;
  assignedUsers: string[];
}

export interface ProjectMeta {
  categories: Named[];
  stages: (Named & { status?: string })[];
  importanceLevels: (Named & { isDefault?: boolean })[];
  boards: (Named & { isDefault?: boolean; closed?: boolean })[];
}

/** Pola zapisywalne — podzbiór createWorkItemValues / patchWorkItemValues z API v0. */
export interface CreateWorkItemBody {
  title: string;
  description?: string;
  isStory: boolean;
  categoryId?: number;
  estimatedCost: number;
  importanceLevelId: number;
  boardId?: number;
  startDate?: string;
  dueDate?: string;
}

export interface PatchWorkItemBody {
  title?: string;
  description?: string;
  categoryId?: number;
  estimatedCost?: number;
  importanceLevelId?: number;
  boardId?: number;
  stageId?: number;
  startDate?: string;
  dueDate?: string;
}

export interface HacknPlanApi {
  readonly mode: "demo" | "api";
  listWorkItems(projectId: number, opts: { limit: number; searchTerms?: string }): Promise<{ items: WorkItem[]; totalCount: number }>;
  getWorkItem(projectId: number, workItemId: number): Promise<WorkItem>;
  createWorkItem(projectId: number, body: CreateWorkItemBody): Promise<WorkItem>;
  patchWorkItem(projectId: number, workItemId: number, body: PatchWorkItemBody): Promise<void>;
  getMeta(projectId: number): Promise<ProjectMeta>;
}
