import type { AppConfig, ProjectConfig } from "./config.js";
import { type Db, newId, now, recordOperation } from "./db.js";
import { AppError, errorMessage } from "./errors.js";
import type { HacknPlanApi, ProjectMeta, WorkItem } from "./hacknplan/types.js";
import type { ChatContext, ChatTurn, LlmProvider } from "./llm.js";
import { ScopedOutline } from "./outline/scoped.js";
import type { OutlineDoc, OutlineSource } from "./outline/types.js";
import type { ProposalService, ProposalView, RejectedProposal } from "./proposals.js";

export interface Source {
  type: "outline" | "hacknplan";
  ref: string;
  title: string;
  url: string;
  cited: boolean;
}

export interface Warning {
  source: "outline" | "hacknplan" | "llm" | "app";
  message: string;
  hint?: string;
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  meta: { warnings?: Warning[]; rejected?: RejectedProposal[]; error?: boolean; model?: string; modes?: Record<string, string> };
  createdAt: string;
  proposals?: ProposalView[];
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  sources_json: string;
  meta_json: string;
  created_at: string;
}

const toMessage = (r: MessageRow): MessageView => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  sources: JSON.parse(r.sources_json) as Source[],
  meta: JSON.parse(r.meta_json) as MessageView["meta"],
  createdAt: r.created_at,
});

export function parseModelOutput(text: string): { answer: string; proposals: unknown[]; warning?: string } {
  const attempt = (s: string) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  let obj = attempt(text.trim());
  if (obj === undefined) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) obj = attempt(fenced[1]);
  }
  if (obj === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) obj = attempt(text.slice(start, end + 1));
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { answer: text.trim(), proposals: [], warning: "Model nie zwrócił poprawnego JSON-a — ewentualne propozycje zadań zostały pominięte." };
  }
  const o = obj as { answer?: unknown; proposals?: unknown };
  const answer = typeof o.answer === "string" ? o.answer : "";
  const proposals = Array.isArray(o.proposals) ? o.proposals : [];
  const warning = !answer ? "Model zwrócił JSON bez pola „answer”." : o.proposals !== undefined && !Array.isArray(o.proposals) ? "Pole „proposals” nie jest listą — pominięto." : undefined;
  return { answer: answer || "(model nie podał treści odpowiedzi)", proposals, warning };
}

export interface ChatDeps {
  db: Db;
  config(): AppConfig;
  outline(): OutlineSource;
  hacknplan(): HacknPlanApi;
  llm(): LlmProvider;
  proposals: ProposalService;
  taskUrl(projectId: number, workItemId: number): string;
}

export class ChatService {
  constructor(private readonly d: ChatDeps) {}

  project(projectId: string): ProjectConfig {
    const p = this.d.config().projects.find((x) => x.id === projectId);
    if (!p) throw new AppError(`Nieznany projekt „${projectId}”. Skonfiguruj go w Ustawieniach.`, { status: 404, code: "project_not_found" });
    return p;
  }

  listConversations(projectId: string) {
    return this.d.db.prepare(`SELECT id, project_id AS projectId, title, created_at AS createdAt FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).all(projectId);
  }

  messages(conversationId: string): MessageView[] {
    const rows = this.d.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`).all(conversationId) as MessageRow[];
    return rows.map((r) => {
      const m = toMessage(r);
      if (m.role === "assistant") m.proposals = this.d.proposals.listForMessage(m.id);
      return m;
    });
  }

  private insertMessage(conversationId: string, role: "user" | "assistant", content: string, sources: Source[], meta: MessageView["meta"]): MessageView {
    const id = newId();
    this.d.db
      .prepare(`INSERT INTO messages (id, conversation_id, role, content, sources_json, meta_json, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, conversationId, role, content, JSON.stringify(sources), JSON.stringify(meta), now());
    return toMessage(this.d.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow);
  }

  async ask(projectId: string, conversationId: string | null, question: string): Promise<{ conversationId: string; user: MessageView; assistant: MessageView }> {
    const project = this.project(projectId);
    const q = question.trim();
    if (!q) throw new AppError("Wiadomość jest pusta.", { status: 400, code: "empty_message" });
    if (q.length > 4000) throw new AppError("Wiadomość jest za długa (maks. 4000 znaków).", { status: 400, code: "message_too_long" });

    let convId = conversationId;
    if (convId) {
      const conv = this.d.db.prepare(`SELECT project_id FROM conversations WHERE id = ?`).get(convId) as { project_id: string } | undefined;
      if (!conv) throw new AppError("Nie znaleziono rozmowy.", { status: 404, code: "conversation_not_found" });
      if (conv.project_id !== projectId) throw new AppError("Rozmowa należy do innego projektu.", { status: 403, code: "conversation_scope" });
    } else {
      convId = newId();
      this.d.db.prepare(`INSERT INTO conversations (id, project_id, title, created_at) VALUES (?,?,?,?)`).run(convId, projectId, q.slice(0, 80), now());
    }
    const history: ChatTurn[] = this.messages(convId)
      .filter((m) => !m.meta.error)
      .map((m) => ({ role: m.role, content: m.content }));
    const user = this.insertMessage(convId, "user", q, [], {});

    const cfg = this.d.config();
    const warnings: Warning[] = [];
    const warn = (source: Warning["source"], e: unknown) => {
      warnings.push({ source, message: errorMessage(e), hint: e instanceof AppError ? e.opts.hint : undefined });
    };

    // 1. Dokumenty Outline — wyłącznie z kolekcji przypisanych do projektu.
    const docs: (OutlineDoc & { ref: string })[] = [];
    let outlineOk = true;
    try {
      const scoped = new ScopedOutline(this.d.outline(), project);
      const refs = await scoped.search(q, cfg.outline.maxDocuments);
      for (const r of refs) {
        try {
          const doc = await scoped.getDocument(r.id);
          const text = doc.text.length > cfg.outline.maxCharsPerDocument ? `${doc.text.slice(0, cfg.outline.maxCharsPerDocument)}\n[…dokument skrócony]` : doc.text;
          docs.push({ ...doc, text, ref: `D${docs.length + 1}` });
        } catch (e) {
          warn("outline", e);
        }
      }
      if (project.outlineCollectionIds.length === 0) {
        warnings.push({ source: "outline", message: "Projekt nie ma przypisanych kolekcji Outline — dokumenty nie są używane.", hint: "Dodaj kolekcje w Ustawieniach projektu." });
      }
    } catch (e) {
      outlineOk = false;
      warn("outline", e);
    }

    // 2. Bieżące zadania i metadane HacknPlan dla skonfigurowanego projektu.
    let tasks: WorkItem[] = [];
    let meta: ProjectMeta | null = null;
    let hacknplanOk = true;
    try {
      const api = this.d.hacknplan();
      const [list, m] = await Promise.all([api.listWorkItems(project.hacknplanProjectId, { limit: cfg.hacknplan.maxTasksInContext }), api.getMeta(project.hacknplanProjectId)]);
      tasks = list.items.filter((t) => t.projectId === project.hacknplanProjectId);
      meta = m;
      // Zadania wskazane wprost w pytaniu (#123), których nie ma na liście ostatnich.
      const mentioned = [...q.matchAll(/(?:#|\bT)(\d{1,9})\b/g)].map((x) => Number(x[1])).filter((n) => !tasks.some((t) => t.workItemId === n));
      for (const idNum of [...new Set(mentioned)].slice(0, 5)) {
        try {
          const w = await api.getWorkItem(project.hacknplanProjectId, idNum);
          if (w.projectId === project.hacknplanProjectId) tasks.push(w);
        } catch (e) {
          warn("hacknplan", e);
        }
      }
    } catch (e) {
      hacknplanOk = false;
      warn("hacknplan", e);
    }

    const llm = this.d.llm();
    const modes = { outline: this.d.outline().mode, hacknplan: this.d.hacknplan().mode, llm: llm.mode };
    if (!outlineOk && !hacknplanOk) {
      const assistant = this.insertMessage(convId, "assistant", "Nie udało się pobrać ani dokumentów Outline, ani zadań HacknPlan, więc nie mogę udzielić ugruntowanej odpowiedzi.", [], {
        warnings,
        error: true,
        modes,
      });
      recordOperation(this.d.db, { projectId, action: "chat", outcome: "error", detail: { reason: "no_sources" } });
      return { conversationId: convId, user, assistant };
    }

    const ctx: ChatContext = {
      projectName: project.name,
      docs,
      tasks,
      meta: meta ?? { categories: [], stages: [], importanceLevels: [], boards: [] },
      history,
      question: q,
      today: new Date().toISOString().slice(0, 10),
    };
    let raw: string;
    try {
      raw = await llm.complete(ctx);
    } catch (e) {
      warn("llm", e);
      const assistant = this.insertMessage(convId, "assistant", "Model nie odpowiedział — szczegóły poniżej.", [], { warnings, error: true, model: llm.label, modes });
      recordOperation(this.d.db, { projectId, action: "chat", outcome: "error", detail: { reason: "llm", message: errorMessage(e) } });
      return { conversationId: convId, user, assistant };
    }
    const parsed = parseModelOutput(raw);
    if (parsed.warning) warnings.push({ source: "llm", message: parsed.warning });

    const sources: Source[] = [
      ...docs.map((d) => ({ type: "outline" as const, ref: d.ref, title: d.title, url: d.url, cited: parsed.answer.includes(`[${d.ref}]`) })),
      ...tasks
        .filter((t) => new RegExp(`\\[T${t.workItemId}\\]`).test(parsed.answer))
        .map((t) => ({ type: "hacknplan" as const, ref: `T${t.workItemId}`, title: t.title, url: this.d.taskUrl(project.hacknplanProjectId, t.workItemId), cited: true })),
    ];

    const assistant = this.insertMessage(convId, "assistant", parsed.answer, sources, { warnings, model: llm.label, modes });
    let rejected: RejectedProposal[] = [];
    if (parsed.proposals.length) {
      if (!meta) {
        rejected = parsed.proposals.map((_, index) => ({ index, reason: "Brak metadanych HacknPlan — nie można zweryfikować propozycji." }));
      } else {
        const groundedSources = [
          ...docs.map((d) => ({ ref: d.ref, title: d.title, url: d.url })),
          ...tasks.map((t) => ({ ref: `T${t.workItemId}`, title: `#${t.workItemId} ${t.title}`, url: this.d.taskUrl(project.hacknplanProjectId, t.workItemId) })),
        ];
        rejected = this.d.proposals.storeFromModel(project, parsed.proposals, { conversationId: convId, messageId: assistant.id, meta, tasks, sources: groundedSources }).rejected;
      }
      if (rejected.length) {
        this.d.db.prepare(`UPDATE messages SET meta_json = ? WHERE id = ?`).run(JSON.stringify({ ...assistant.meta, rejected }), assistant.id);
      }
    }
    recordOperation(this.d.db, { projectId, action: "chat", outcome: "ok", detail: { docs: docs.length, tasks: tasks.length, proposals: parsed.proposals.length, rejected: rejected.length } });
    const final = this.messages(convId).find((m) => m.id === assistant.id)!;
    return { conversationId: convId, user, assistant: final };
  }
}
