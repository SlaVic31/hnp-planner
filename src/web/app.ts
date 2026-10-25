// Interfejs przeglądarkowy HnP Planner. Cała treść z serwera trafia do DOM przez textContent (bez innerHTML).

type Mode = "demo" | "mcp" | "api" | "openai" | "openai-responses" | "anthropic";

interface Session {
  csrfToken: string;
  demo: boolean;
  modes: { outline: Mode; hacknplan: Mode; llm: Mode };
  llm: { label: string; isLocal: boolean };
  projects: { id: string; name: string; hacknplanProjectId: number; outlineCollectionIds: string[] }[];
}

interface ApiErrorBody {
  error?: { message?: string; hint?: string; code?: string; source?: string };
}

interface Source {
  type: "outline" | "hacknplan";
  ref: string;
  title: string;
  url: string;
  cited: boolean;
}

interface Warning {
  source: string;
  message: string;
  hint?: string;
}

interface Proposal {
  id: string;
  projectId: string;
  kind: "create" | "update";
  workItemId: number | null;
  payload: Record<string, unknown>;
  display: { fields: { field: string; label: string; before?: string; after: string }[]; taskTitle?: string; templateHash?: string };
  rationale: string;
  payloadHash: string;
  status: "pending" | "executing" | "succeeded" | "failed" | "rejected" | "stale" | "outcome_unknown";
  result: { workItemId?: number; url?: string; title?: string; reconciled?: boolean } | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: Source[];
  meta: { warnings?: Warning[]; rejected?: { index: number; reason: string }[]; error?: boolean; model?: string };
  createdAt: string;
  proposals?: Proposal[];
}

interface Task {
  workItemId: number;
  title: string;
  url: string;
  category: { name: string } | null;
  stage: { name: string } | null;
  importanceLevel: { name: string } | null;
  board: { name: string } | null;
  estimatedCost: number | null;
  dueDate: string | null;
  updateDate: string | null;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const STATUS_LABEL: Record<Proposal["status"], string> = {
  pending: "oczekuje na decyzję",
  executing: "wykonywanie…",
  succeeded: "wykonana",
  failed: "nieudana",
  rejected: "odrzucona",
  stale: "nieaktualna",
  outcome_unknown: "wynik nieznany",
};

const ACTION_LABEL: Record<string, string> = {
  chat: "Zapytanie w czacie",
  propose_create: "Propozycja: nowe zadanie",
  propose_update: "Propozycja: edycja zadania",
  proposal_rejected_by_validation: "Propozycja odrzucona przez walidację",
  approve: "Zatwierdzenie",
  reject: "Odrzucenie",
  execute_create: "Utworzenie zadania",
  execute_update: "Edycja zadania",
  stale_detected: "Wykryto nieaktualną edycję",
  reconcile: "Weryfikacja w HacknPlan",
  requeue: "Ponowna propozycja",
  recover: "Odzyskanie po restarcie",
  settings_update: "Zmiana ustawień",
  secret_update: "Zmiana sekretu",
};

let session: Session;
let projectId = "";
let conversationId: string | null = null;

// ---------- pomocnicze ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (typeof v === "boolean") {
      if (v) el.setAttribute(k, "");
    } else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function safeLink(url: string, text: string, cls = ""): HTMLElement {
  // Linkujemy tylko adresy http(s) — chroni przed javascript: w danych z zewnątrz.
  if (!/^https?:\/\//i.test(url)) return h("span", { class: cls }, text);
  return h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: cls }, text);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = session?.csrfToken ?? "";
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError("Brak połączenia z lokalnym serwerem aplikacji.", "Sprawdź, czy proces `npm start` nadal działa w terminalu.");
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const e = (data as ApiErrorBody).error;
    throw new ApiError(e?.message ?? `Błąd HTTP ${res.status}`, e?.hint, res.status);
  }
  return data as T;
}

function errorBox(e: unknown, cls = "alert alert-error"): HTMLElement {
  const err = e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e));
  return h("div", { class: cls, role: "alert" }, err.message, err.hint ? h("span", { class: "hint" }, `Co zrobić: ${err.hint}`) : null);
}

function showGlobalError(e: unknown | null): void {
  const box = $("global-error");
  box.replaceChildren();
  if (!e) {
    box.hidden = true;
    return;
  }
  const inner = errorBox(e);
  box.append(...Array.from(inner.childNodes));
  box.hidden = false;
}

const fmtDate = (s: string | null | undefined): string => (s ? new Date(s).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—");

// ---------- nagłówek / sesja ----------

function modeBadge(label: string, mode: Mode): HTMLElement {
  const live = mode !== "demo";
  return h("span", { class: `badge ${live ? "badge-live" : "badge-demo"}`, title: live ? "Połączono z prawdziwą usługą" : "Dane fikcyjne (demo)" }, `${label}: ${live ? "POŁĄCZONO" : "DEMO"}`);
}

function renderHeader(): void {
  const b = $("mode-badges");
  b.replaceChildren(
    modeBadge("Outline", session.modes.outline),
    modeBadge("HacknPlan", session.modes.hacknplan),
    modeBadge("Model", session.modes.llm),
    session.modes.llm === "demo"
      ? h("span", { class: "badge badge-local" }, "bez AI")
      : session.llm.isLocal
        ? h("span", { class: "badge badge-local", title: session.llm.label }, "model lokalny")
        : h("span", { class: "badge badge-remote", title: session.llm.label }, "model zdalny — dane wysyłane"),
  );
  $("demo-banner").hidden = !(session.demo || (session.modes.outline === "demo" && session.modes.hacknplan === "demo"));
  const sel = $<HTMLSelectElement>("project-select");
  sel.replaceChildren(...session.projects.map((p) => h("option", { value: p.id }, `${p.name} (HacknPlan #${p.hacknplanProjectId})`)));
  if (!session.projects.some((p) => p.id === projectId)) projectId = session.projects[0]?.id ?? "";
  sel.value = projectId;
  $("chat-privacy").textContent =
    session.modes.llm === "demo"
      ? "Model demonstracyjny (reguły) — nic nie opuszcza komputera."
      : session.llm.isLocal
        ? `Model lokalny: ${session.llm.label}`
        : `Uwaga: fragmenty dokumentów i zadań trafią do zdalnego dostawcy (${session.llm.label}).`;
}

async function loadSession(): Promise<void> {
  session = await api<Session>("GET", "/api/session");
  renderHeader();
}

// ---------- karty propozycji ----------

function proposalCard(p: Proposal, onChange: () => void): HTMLElement {
  const card = h("div", { class: `proposal st-${p.status}`, "data-proposal-id": p.id });
  const kind = p.kind === "create" ? "Nowe zadanie" : `Edycja zadania #${p.workItemId}${p.display.taskTitle ? ` „${p.display.taskTitle}”` : ""}`;
  card.append(
    h(
      "div",
      { class: "proposal-head" },
      h("span", { class: "proposal-kind" }, kind),
      h("span", { class: `status status-${p.status}` }, STATUS_LABEL[p.status]),
      h("span", { class: "muted small" }, fmtDate(p.createdAt)),
    ),
  );
  const table = h("table", { class: "fields" });
  for (const f of p.display.fields) {
    const td = h("td", {});
    if (f.before !== undefined) td.append(h("span", { class: "before" }, f.before), " → ");
    td.append(h("span", { class: p.kind === "update" ? "after" : "" }, f.after));
    table.append(h("tr", {}, h("th", {}, f.label), td));
  }
  card.append(table);
  if (p.rationale) card.append(h("div", { class: "small muted" }, `Uzasadnienie modelu: ${p.rationale}`));
  card.append(
    h(
      "div",
      { class: "hash", title: "Skrót treści propozycji przechowywanej na serwerze. Zatwierdzenie wykonuje dokładnie tę treść." },
      `sha256: ${p.payloadHash.slice(0, 16)}…${p.display.templateHash ? ` · opis z szablonu ${p.display.templateHash}` : ""}`,
    ),
  );

  const status = h("div", {});
  const actions = h("div", { class: "proposal-actions" });
  const run = async (btn: HTMLButtonElement, fn: () => Promise<unknown>) => {
    actions.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    btn.textContent = "Trwa…";
    status.replaceChildren();
    try {
      await fn();
      onChange();
    } catch (e) {
      status.replaceChildren(errorBox(e));
      onChange();
    }
  };

  if (p.status === "pending") {
    const approve = h("button", { class: "btn btn-approve btn-small", type: "button" }, p.kind === "create" ? "Zatwierdź i utwórz w HacknPlan" : "Zatwierdź i zapisz w HacknPlan") as HTMLButtonElement;
    approve.addEventListener("click", () => void run(approve, () => api("POST", `/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash })));
    const reject = h("button", { class: "btn btn-reject btn-small", type: "button" }, "Odrzuć") as HTMLButtonElement;
    reject.addEventListener("click", () => void run(reject, () => api("POST", `/api/proposals/${p.id}/reject`, { payloadHash: p.payloadHash })));
    actions.append(approve, reject);
  }
  if (p.status === "succeeded" && p.result?.workItemId) {
    actions.append(h("span", { class: "small" }, "Zadanie: "), safeLink(p.result.url ?? "", `#${p.result.workItemId} ${p.result.title ?? ""}`), p.result.reconciled ? h("span", { class: "muted small" }, " (potwierdzone weryfikacją)") : "");
  }
  if (p.error) status.append(h("div", { class: p.status === "outcome_unknown" ? "alert alert-warn" : "alert alert-error" }, p.error));
  if (p.status === "outcome_unknown") {
    const check = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Sprawdź w HacknPlan") as HTMLButtonElement;
    check.addEventListener("click", () =>
      void run(check, async () => {
        const r = await api<{ found: boolean; message: string }>("POST", `/api/proposals/${p.id}/reconcile`);
        if (!r.found) {
          // Pokazujemy wynik weryfikacji i dopiero wtedy opcję ponowienia.
          window.setTimeout(() => {
            const host = document.querySelector(`[data-proposal-id="${p.id}"]`);
            if (!host) return;
            const confirmBtn = h("button", { class: "btn btn-reject btn-small", type: "button" }, "Potwierdzam: zadanie nie powstało — utwórz nową propozycję") as HTMLButtonElement;
            confirmBtn.addEventListener("click", () => void run(confirmBtn, () => api("POST", `/api/proposals/${p.id}/requeue`, { confirmNotCreated: true })));
            host.append(h("div", { class: "alert alert-info" }, r.message), h("div", { class: "proposal-actions" }, confirmBtn));
          }, 50);
        }
      }),
    );
    actions.append(check);
  }
  if (p.status === "failed") {
    const again = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Utwórz nową propozycję z tą treścią") as HTMLButtonElement;
    again.addEventListener("click", () => void run(again, () => api("POST", `/api/proposals/${p.id}/requeue`, { confirmNotCreated: false })));
    actions.append(again);
  }
  card.append(status, actions);
  return card;
}

// ---------- czat ----------

function renderAnswerText(text: string, sources: Source[]): HTMLElement {
  const wrap = h("div", { class: "msg-text" });
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const parts = text.split(/(\[(?:D\d+|T\d+)\])/g);
  for (const part of parts) {
    const m = part.match(/^\[((?:D|T)\d+)\]$/);
    const src = m ? byRef.get(m[1]!) : undefined;
    if (src) wrap.append(safeLink(src.url, part, "ref"));
    else wrap.append(part);
  }
  return wrap;
}

function renderMessage(m: Message, onChange: () => void): HTMLElement {
  if (m.role === "user") return h("div", { class: "msg msg-user" }, h("div", { class: "msg-text" }, m.content));
  const el = h("div", { class: `msg msg-assistant${m.meta.error ? " msg-error" : ""}` }, renderAnswerText(m.content, m.sources));
  for (const w of m.meta.warnings ?? []) {
    el.append(h("div", { class: "alert alert-warn" }, `[${w.source}] ${w.message}`, w.hint ? h("span", { class: "hint" }, `Co zrobić: ${w.hint}`) : null));
  }
  if (m.sources.length) {
    const s = h("div", { class: "sources" }, h("span", { class: "small muted" }, "Źródła:"));
    for (const src of m.sources) {
      const a = safeLink(src.url, "", `source${src.cited ? " cited" : ""}`);
      a.append(h("span", { class: "kind" }, src.type === "outline" ? `Outline ${src.ref}` : `HacknPlan ${src.ref}`), src.title);
      a.title = src.cited ? "Cytowane w odpowiedzi" : "Użyte w kontekście";
      s.append(a);
    }
    el.append(s);
  }
  for (const r of m.meta.rejected ?? []) {
    el.append(h("div", { class: "alert alert-info small" }, `Propozycja ${r.index + 1} odrzucona przez walidację: ${r.reason}`));
  }
  const props = m.proposals ?? [];
  for (const p of props) el.append(proposalCard(p, onChange));
  const pending = props.filter((p) => p.status === "pending");
  if (pending.length > 1) {
    const result = h("div", {});
    const all = h("button", { class: "btn btn-approve btn-small", type: "button" }, `Zatwierdź wszystkie oczekujące (${pending.length})`) as HTMLButtonElement;
    all.addEventListener("click", async () => {
      all.disabled = true;
      try {
        const r = await api<{ succeeded: number; failed: number; results: { id: string; ok: boolean; error?: string }[] }>("POST", "/api/proposals/approve-batch", {
          items: pending.map((p) => ({ id: p.id, payloadHash: p.payloadHash })),
        });
        onChange();
        window.setTimeout(() => showGlobalError(r.failed ? new ApiError(`Wykonano ${r.succeeded} z ${r.results.length} propozycji. Nieudane: ${r.failed} — szczegóły na kartach propozycji.`) : null), 100);
      } catch (e) {
        result.replaceChildren(errorBox(e));
        all.disabled = false;
      }
    });
    el.append(h("div", { class: "batch-bar" }, all, h("span", { class: "small muted" }, "Każda propozycja jest wykonywana osobno; wynik częściowy jest pokazany na kartach.")), result);
  }
  el.append(h("div", { class: "msg-meta" }, `${fmtDate(m.createdAt)}${m.meta.model ? ` · ${m.meta.model}` : ""}`));
  return el;
}

async function loadConversations(): Promise<void> {
  const list = $("conversation-list");
  try {
    const convs = await api<{ id: string; title: string; createdAt: string }[]>("GET", `/api/projects/${projectId}/conversations`);
    list.replaceChildren(
      ...convs.map((c) => {
        const b = h("button", { type: "button", class: c.id === conversationId ? "active" : "", title: fmtDate(c.createdAt) }, c.title);
        b.addEventListener("click", () => {
          conversationId = c.id;
          void loadConversations();
          void loadMessages();
        });
        return h("li", {}, b);
      }),
    );
  } catch (e) {
    list.replaceChildren(h("li", {}, errorBox(e)));
  }
}

function emptyChat(): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("p", {}, "Zadaj pytanie o dokumentację projektu lub poproś o zaplanowanie pracy."),
    h("p", { class: "small" }, "Przykłady: „Co mówi dokumentacja o sztormie?”, „Dodaj zadanie na ostrzeżenie o niskim poziomie oleju”, „Zmień #103 — przenieś do etapu W toku”."),
    h("p", { class: "small" }, "Model może jedynie proponować zmiany. Zapis w HacknPlan następuje dopiero po Twoim zatwierdzeniu konkretnej propozycji."),
  );
}

async function loadMessages(): Promise<void> {
  const box = $("messages");
  if (!conversationId) {
    box.replaceChildren(emptyChat());
    return;
  }
  try {
    const msgs = await api<Message[]>("GET", `/api/projects/${projectId}/conversations/${conversationId}/messages`);
    box.replaceChildren(...msgs.map((m) => renderMessage(m, () => void refreshAfterProposal())));
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.replaceChildren(errorBox(e));
  }
}

async function refreshAfterProposal(): Promise<void> {
  await Promise.all([loadMessages(), updatePendingCount()]);
  if (!$("tab-proposals").hidden) await loadProposals();
}

async function sendMessage(ev: Event): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const btn = $<HTMLButtonElement>("chat-send");
  btn.disabled = true;
  const box = $("messages");
  if (!conversationId) box.replaceChildren();
  box.append(h("div", { class: "msg msg-user" }, h("div", { class: "msg-text" }, text)), h("div", { class: "typing", id: "typing" }, "Szukam w Outline i HacknPlan, pytam model…"));
  box.scrollTop = box.scrollHeight;
  try {
    const r = await api<{ conversationId: string }>("POST", `/api/projects/${projectId}/chat`, { conversationId, message: text });
    input.value = "";
    conversationId = r.conversationId;
    showGlobalError(null);
    await Promise.all([loadConversations(), loadMessages(), updatePendingCount()]);
  } catch (e) {
    document.getElementById("typing")?.remove();
    box.append(errorBox(e));
  } finally {
    btn.disabled = false;
  }
}

// ---------- zadania ----------

async function loadTasks(): Promise<void> {
  const c = $("tasks-container");
  c.replaceChildren(h("p", { class: "muted" }, "Wczytywanie zadań…"));
  const q = $<HTMLInputElement>("task-search").value.trim();
  try {
    const r = await api<{ totalCount: number; items: Task[] }>("GET", `/api/projects/${projectId}/tasks${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    $("task-count").textContent = `Pokazano ${r.items.length} z ${r.totalCount}`;
    if (!r.items.length) {
      c.replaceChildren(h("p", { class: "muted" }, "Brak zadań."));
      return;
    }
    const demo = session.modes.hacknplan === "demo";
    const table = h(
      "table",
      { class: "data" },
      h("thead", {}, h("tr", {}, ...["#", "Tytuł", "Kategoria", "Etap", "Priorytet", "Tablica", "Koszt", "Termin", "Zmieniono", ...(demo ? [""] : [])].map((t) => h("th", {}, t)))),
    );
    const tbody = h("tbody", {});
    for (const t of r.items) {
      const row = h(
        "tr",
        {},
        h("td", {}, String(t.workItemId)),
        h("td", {}, safeLink(t.url, t.title)),
        h("td", {}, t.category?.name ?? "—"),
        h("td", {}, t.stage?.name ?? "—"),
        h("td", {}, t.importanceLevel?.name ?? "—"),
        h("td", {}, t.board?.name ?? "—"),
        h("td", {}, t.estimatedCost === null ? "—" : String(t.estimatedCost)),
        h("td", {}, t.dueDate ? t.dueDate.slice(0, 10) : "—"),
        h("td", {}, fmtDate(t.updateDate)),
      );
      if (demo) {
        const b = h("button", { class: "btn btn-secondary btn-small", type: "button", title: "Demo: symuluje zmianę przez innego użytkownika, aby pokazać wykrywanie nieaktualnych propozycji edycji" }, "Symuluj zmianę") as HTMLButtonElement;
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            await api("POST", `/api/demo/projects/${projectId}/tasks/${t.workItemId}/simulate-change`);
            await loadTasks();
          } catch (e) {
            showGlobalError(e);
          }
        });
        row.append(h("td", {}, b));
      }
      tbody.append(row);
    }
    table.append(tbody);
    c.replaceChildren(table);
  } catch (e) {
    $("task-count").textContent = "";
    c.replaceChildren(errorBox(e));
  }
}

// ---------- propozycje ----------

async function updatePendingCount(): Promise<void> {
  try {
    const list = await api<Proposal[]>("GET", `/api/projects/${projectId}/proposals?status=pending`);
    const el = $("pending-count");
    el.textContent = String(list.length);
    el.hidden = list.length === 0;
  } catch {
    /* licznik jest pomocniczy */
  }
}

async function loadProposals(): Promise<void> {
  const c = $("proposals-container");
  const status = $<HTMLSelectElement>("proposal-filter").value;
  try {
    const list = await api<Proposal[]>("GET", `/api/projects/${projectId}/proposals${status ? `?status=${status}` : ""}`);
    c.replaceChildren(...(list.length ? list.map((p) => proposalCard(p, () => void Promise.all([loadProposals(), updatePendingCount(), loadMessages()]))) : [h("p", { class: "muted" }, "Brak propozycji.")]));
  } catch (e) {
    c.replaceChildren(errorBox(e));
  }
}

// ---------- historia ----------

async function loadHistory(): Promise<void> {
  const c = $("history-container");
  try {
    const ops = await api<{ id: number; proposalId: string | null; action: string; outcome: string; detail: Record<string, unknown>; createdAt: string }[]>("GET", `/api/projects/${projectId}/operations`);
    if (!ops.length) {
      c.replaceChildren(h("p", { class: "muted" }, "Brak operacji."));
      return;
    }
    const tbody = h("tbody", {});
    for (const o of ops) {
      const detail = Object.entries(o.detail)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(", ");
      tbody.append(
        h("tr", {}, h("td", {}, fmtDate(o.createdAt)), h("td", {}, ACTION_LABEL[o.action] ?? o.action), h("td", {}, o.outcome), h("td", { class: "small" }, detail), h("td", { class: "hash" }, o.proposalId ? o.proposalId.slice(0, 8) : "")),
      );
    }
    c.replaceChildren(h("table", { class: "data" }, h("thead", {}, h("tr", {}, ...["Czas", "Operacja", "Wynik", "Szczegóły", "Propozycja"].map((t) => h("th", {}, t)))), tbody));
  } catch (e) {
    c.replaceChildren(errorBox(e));
  }
}

// ---------- ustawienia ----------

interface Settings {
  config: {
    port: number;
    outline: { mode: "demo" | "mcp"; mcpUrl: string; timeoutMs: number; maxDocuments: number; maxCharsPerDocument: number };
    hacknplan: { mode: "demo" | "api"; baseUrl: string; webUrlTemplate: string; timeoutMs: number; maxTasksInContext: number };
    llm: {
      mode: LlmMode;
      baseUrl: string;
      model: string;
      jsonMode: boolean;
      temperature: number;
      timeoutMs: number;
      openaiResponses: { baseUrl: string; model: string };
      anthropic: { baseUrl: string; model: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };
    };
    projects: { id: string; name: string; hacknplanProjectId: number; outlineCollectionIds: string[]; descriptionTemplate?: string }[];
  };
  secrets: Record<"outlineToken" | "hacknplanApiKey" | "llmApiKey" | "openaiApiKey" | "anthropicApiKey", { set: boolean; source: "env" | "file" | null; envVar: string }>;
  demo: boolean;
  paths: { dir: string; config: string; secrets: string; db: string };
}

type LlmMode = "demo" | "openai" | "openai-responses" | "anthropic";

const isLocalHost = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "host.docker.internal";
  } catch {
    return false;
  }
};

interface TemplateHelp {
  fields: Record<string, string>;
  defaultTemplate: string;
}
let templateHelp: TemplateHelp | null = null;

/** Edytor szablonu opisu zadań projektu: pomoc, walidacja i podgląd renderowania po stronie serwera. */
function templateEditor(p: Settings["config"]["projects"][number], help: TemplateHelp): HTMLElement {
  const area = h("textarea", { rows: "12", class: "template-area", spellcheck: "false", "aria-label": "Szablon opisu zadania (Markdown)" }) as HTMLTextAreaElement;
  area.value = p.descriptionTemplate ?? help.defaultTemplate;
  const status = h("div", { class: "small muted" });
  const preview = h("pre", { class: "template-preview", "aria-label": "Podgląd opisu" });
  let timer = 0;
  const refresh = async () => {
    try {
      const r = await api<{ ok: boolean; error?: string; rendered?: string; templateHash?: string }>("POST", "/api/template/preview", { template: area.value, projectName: p.name });
      if (r.ok) {
        status.className = "small ok-text";
        status.textContent = `Szablon poprawny (wersja ${r.templateHash}). Podgląd na przykładowych danych:`;
        preview.textContent = r.rendered ?? "";
      } else {
        status.className = "small err-text";
        status.textContent = `Błąd szablonu: ${r.error}`;
        preview.textContent = "";
      }
    } catch (e) {
      status.replaceChildren(errorBox(e));
    }
  };
  area.addEventListener("input", () => {
    p.descriptionTemplate = area.value;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 300);
  });
  const reset = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Przywróć domyślny") as HTMLButtonElement;
  reset.addEventListener("click", () => {
    area.value = help.defaultTemplate;
    delete p.descriptionTemplate;
    void refresh();
  });
  const helpList = h(
    "ul",
    { class: "small template-help" },
    ...Object.entries(help.fields).map(([k, v]) => h("li", {}, h("code", {}, `{{${k}}}`), ` — ${v}`)),
    h("li", {}, h("code", {}, "{{#pole}}…{{/pole}}"), " — sekcja tylko, gdy pole niepuste; ", h("code", {}, "{{^pole}}…{{/pole}}"), " — tylko, gdy puste; ", h("code", {}, "{{! komentarz}}")),
  );
  void refresh();
  return h(
    "section",
    { class: "template-editor", "aria-label": "Szablon opisu zadań" },
    h("h4", {}, "Szablon opisu zadań (Markdown)"),
    h("p", { class: "small muted" }, "Opis nowych propozycji jest składany według tego szablonu przed zapisaniem i zatwierdzeniem. Zmiana szablonu nie zmienia istniejących propozycji ani zadań."),
    helpList,
    area,
    h("div", { class: "proposal-actions" }, reset),
    status,
    preview,
  );
}

function field(label: string, input: HTMLElement, help?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), input, help ? h("span", { class: "help" }, help) : null);
}

function input(value: string | number, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = h("input", { type: "text", ...attrs }) as HTMLInputElement;
  el.value = String(value);
  return el;
}

function select(value: string, options: [string, string][]): HTMLSelectElement {
  const el = h("select", {}, ...options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  el.value = value;
  return el;
}

function secretField(name: keyof Settings["secrets"], label: string, s: Settings, help: string): HTMLElement {
  const st = s.secrets[name];
  const inp = h("input", { type: "password", autocomplete: "off", placeholder: st.set ? "•••••• (ustawiony)" : "nie ustawiono", "aria-label": label }) as HTMLInputElement;
  const msg = h("span", { class: "help" }, st.source === "env" ? `Ustawiony przez zmienną środowiskową ${st.envVar} (ma pierwszeństwo).` : st.set ? "Zapisany w pliku sekretów (0600)." : `Możesz też użyć zmiennej ${st.envVar}.`);
  const save = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Zapisz") as HTMLButtonElement;
  const clear = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Usuń") as HTMLButtonElement;
  const act = async (value: string | null) => {
    try {
      await api("PUT", `/api/secrets/${name}`, { value });
      inp.value = "";
      await renderSettings(value ? `Zapisano: ${label}` : `Usunięto: ${label}`);
    } catch (e) {
      msg.replaceChildren(errorBox(e));
    }
  };
  save.addEventListener("click", () => void act(inp.value.trim() || null));
  clear.addEventListener("click", () => void act(null));
  return h("div", { class: "field" }, h("span", {}, `${label} ${st.set ? "✓" : "✗"}`), h("div", { class: "secret-row" }, inp, save, clear), msg, h("span", { class: "help" }, help));
}

async function renderSettings(notice?: string): Promise<void> {
  const c = $("settings-container");
  let s: Settings;
  try {
    s = await api<Settings>("GET", "/api/settings");
  } catch (e) {
    c.replaceChildren(errorBox(e));
    return;
  }
  const cfg = structuredClone(s.config);
  const locked = s.demo;

  // Outline
  const oMode = select(cfg.outline.mode, [
    ["demo", "Demo (dokumenty fikcyjne)"],
    ["mcp", "Outline MCP (prawdziwy serwer)"],
  ]);
  const oUrl = input(cfg.outline.mcpUrl, { placeholder: "https://twoj-zespol.getoutline.com/mcp" });
  const oStatus = h("div", { class: "status-line muted" }, "");
  const testOutline = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Sprawdź połączenia") as HTMLButtonElement;
  testOutline.addEventListener("click", async () => {
    testOutline.disabled = true;
    oStatus.replaceChildren("Sprawdzanie…");
    try {
      const st = await api<{
        outline: { ok: boolean; mode: string; error?: string; hint?: string; serverName?: string; serverVersion?: string; protocolVersion?: string; tools?: { name: string; allowed: boolean }[]; blockedWriteTools?: string[]; missingCapabilities?: string[] };
        hacknplan: { ok: boolean; mode: string; error?: string; hint?: string; categories?: number; boards?: number };
        llm: { label: string; note: string };
      }>("GET", "/api/status");
      const o = st.outline;
      const hp = st.hacknplan;
      oStatus.replaceChildren(
        h(
          "div",
          { class: o.ok ? "alert alert-ok" : "alert alert-error" },
          o.ok
            ? `Outline (${o.mode}): połączono — ${o.serverName ?? ""} ${o.serverVersion ?? ""}${o.protocolVersion ? `, protokół MCP ${o.protocolVersion}` : ""}. Narzędzia używane: ${(o.tools ?? []).filter((t) => t.allowed).map((t) => t.name).join(", ") || "brak"}.`
            : `Outline: ${o.error ?? (o.missingCapabilities ?? []).join("; ")}`,
          o.hint ? h("span", { class: "hint" }, `Co zrobić: ${o.hint}`) : null,
          o.blockedWriteTools?.length ? h("span", { class: "hint" }, `Wykryte narzędzia zapisu (zablokowane przez aplikację): ${o.blockedWriteTools.join(", ")}. Zalecany klucz tylko do odczytu.`) : null,
        ),
        h(
          "div",
          { class: hp.ok ? "alert alert-ok" : "alert alert-error" },
          hp.ok ? `HacknPlan (${hp.mode}): połączono — ${hp.categories} kategorii, ${hp.boards} tablic.` : `HacknPlan: ${hp.error}`,
          hp.hint ? h("span", { class: "hint" }, `Co zrobić: ${hp.hint}`) : null,
        ),
        h("div", { class: "alert alert-info" }, `Model: ${st.llm.label}. ${st.llm.note}`),
      );
    } catch (e) {
      oStatus.replaceChildren(errorBox(e));
    } finally {
      testOutline.disabled = false;
    }
  });

  // HacknPlan
  const hMode = select(cfg.hacknplan.mode, [
    ["demo", "Demo (zadania fikcyjne, lokalnie)"],
    ["api", "HacknPlan API v0 (prawdziwe zadania)"],
  ]);
  const hBase = input(cfg.hacknplan.baseUrl);
  const hWeb = input(cfg.hacknplan.webUrlTemplate);
  const hMax = input(cfg.hacknplan.maxTasksInContext, { type: "number", min: "5", max: "200" });

  // Model
  const lMode = select(cfg.llm.mode, [
    ["demo", "Demo (reguły, bez AI)"],
    ["openai", "Model lokalny / własny endpoint (zgodny z OpenAI Chat Completions)"],
    ["openai-responses", "OpenAI API (Responses) — klucz API"],
    ["anthropic", "Anthropic Claude API (Messages) — klucz API"],
  ]);
  // Zgodny z OpenAI (Ollama, LM Studio, vLLM, własny endpoint)
  const lBase = input(cfg.llm.baseUrl, { placeholder: "http://127.0.0.1:11434/v1" });
  const lModel = input(cfg.llm.model, { placeholder: "llama3.1:8b", list: "llm-models" });
  const lJson = h("input", { type: "checkbox" }) as HTMLInputElement;
  lJson.checked = cfg.llm.jsonMode;
  const lTemp = input(cfg.llm.temperature, { type: "number", step: "0.1", min: "0", max: "2" });
  // OpenAI Responses
  const oaBase = input(cfg.llm.openaiResponses.baseUrl);
  const oaModel = input(cfg.llm.openaiResponses.model, { placeholder: "gpt-6-astra", list: "llm-models" });
  // Anthropic
  const anBase = input(cfg.llm.anthropic.baseUrl);
  const anModel = input(cfg.llm.anthropic.model, { placeholder: "claude-opus-5-5", list: "llm-models" });
  const anEffort = select(cfg.llm.anthropic.effort ?? "", [
    ["", "domyślny dla modelu"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ]);
  const lTimeout = input(cfg.llm.timeoutMs, { type: "number", min: "1000" });
  const modelList = h("datalist", { id: "llm-models" });
  const privacy = h("div", { class: "alert alert-info small" });
  const groups = {
    openai: h(
      "div",
      {},
      field("Adres bazowy (zgodny z OpenAI)", lBase, "Ollama natywnie: http://127.0.0.1:11434/v1 · z Dockera: http://host.docker.internal:11434/v1 · własny endpoint: jego adres /v1"),
      field("Model", lModel),
      h("label", { class: "field" }, h("span", {}, h("span", {}, lJson), " Tryb JSON (response_format)")),
      field("Temperatura", lTemp),
      secretField("llmApiKey", "Klucz API (opcjonalny)", s, "Niepotrzebny dla Ollamy; dla własnego endpointu wysyłany jako Bearer."),
    ),
    "openai-responses": h(
      "div",
      {},
      field("Adres API", oaBase, "Oficjalnie: https://api.openai.com/v1"),
      field("Model", oaModel, "Wybierz z listy dostępnej dla Twojego klucza („Pobierz listę modeli”)."),
      secretField("openaiApiKey", "Klucz API OpenAI", s, "Klucz z platform.openai.com — rozliczany według zużycia API (nie subskrypcja ChatGPT)."),
      h("div", { class: "alert alert-info small" }, "Logowanie kontem ChatGPT (bez klucza API) nie jest jeszcze zaimplementowane — OpenAI udostępnia je w wersji preview; czeka na decyzję."),
    ),
    anthropic: h(
      "div",
      {},
      field("Adres API", anBase, "Oficjalnie: https://api.anthropic.com"),
      field("Model", anModel, "Np. claude-opus-5-5; pełna lista: „Pobierz listę modeli”."),
      field("Poziom wysiłku (effort)", anEffort, "Niższy = taniej i szybciej."),
      secretField("anthropicApiKey", "Klucz API Anthropic", s, "Klucz z platform.claude.com (Claude Console)."),
      h("div", { class: "alert alert-info small" }, "Tylko klucz API: Anthropic nie pozwala aplikacjom zewnętrznym na logowanie subskrypcją Claude (Free/Pro/Max)."),
    ),
  } as const;
  const updatePrivacy = () => {
    const mode = lMode.value as LlmMode;
    for (const [k, el] of Object.entries(groups)) el.hidden = k !== mode;
    const local = mode === "demo" || (mode === "openai" && isLocalHost(lBase.value));
    privacy.className = `alert small ${local ? "alert-info" : "alert-warn"}`;
    privacy.textContent =
      mode === "demo"
        ? "Model demo działa lokalnie i nie wysyła danych."
        : local
          ? "Model lokalny (ten komputer lub host Dockera): treść dokumentów i zadań nie opuszcza komputera."
          : "Model zdalny: fragmenty dokumentów Outline, lista zadań HacknPlan i Twoje pytania zostaną wysłane do tego dostawcy.";
  };
  lBase.addEventListener("input", updatePrivacy);
  lMode.addEventListener("change", updatePrivacy);
  updatePrivacy();

  const llmResult = h("div", { class: "provider-test" });
  const savedNote = () => (lMode.value !== cfg.llm.mode ? "Najpierw zapisz ustawienia — test używa zapisanej konfiguracji. " : "");
  const listBtn = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Pobierz listę modeli") as HTMLButtonElement;
  listBtn.addEventListener("click", async () => {
    listBtn.disabled = true;
    try {
      const r = await api<{ models: { id: string; label?: string }[] }>("GET", "/api/llm/models");
      modelList.replaceChildren(...r.models.map((m) => h("option", { value: m.id }, m.label ?? m.id)));
      llmResult.replaceChildren(h("div", { class: "alert alert-ok small" }, `${savedNote()}Dostępnych modeli: ${r.models.length}. Wybierz z podpowiedzi w polu „Model”.`));
    } catch (e) {
      llmResult.replaceChildren(errorBox(e));
    } finally {
      listBtn.disabled = false;
    }
  });
  const testBtn = h("button", { class: "btn btn-secondary btn-small", type: "button", title: "Wysyła jedno krótkie, neutralne zapytanie bez danych projektu. Może wiązać się z opłatami za API." }, "Testuj połączenie z modelem") as HTMLButtonElement;
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    llmResult.replaceChildren(h("div", { class: "small muted" }, "Wysyłam neutralne mini-zapytanie…"));
    try {
      const r = await api<{ sample: string; model: string; note?: string; ms: number; label: string }>("POST", "/api/llm/test");
      llmResult.replaceChildren(
        h("div", { class: "alert alert-ok small" }, `${savedNote()}Model odpowiedział (${r.label}, ${r.model}, ${r.ms} ms): „${r.sample || "—"}”.`, r.note ? h("span", { class: "hint" }, r.note) : null),
      );
    } catch (e) {
      llmResult.replaceChildren(errorBox(e));
    } finally {
      testBtn.disabled = false;
    }
  });

  // Projekty
  templateHelp ??= await api<TemplateHelp>("GET", "/api/template/help").catch(() => null);
  const projectsBox = h("div", {});
  let collectionsCache: { id: string; name: string }[] | null = null;
  const renderProjects = () => {
    projectsBox.replaceChildren();
    cfg.projects.forEach((p, idx) => {
      const pid = input(p.id);
      const pname = input(p.name);
      const phid = input(p.hacknplanProjectId, { type: "number", min: "1" });
      const pcols = input(p.outlineCollectionIds.join(", "), { placeholder: "id-kolekcji-1, id-kolekcji-2" });
      pid.addEventListener("input", () => (p.id = pid.value.trim()));
      pname.addEventListener("input", () => (p.name = pname.value));
      phid.addEventListener("input", () => (p.hacknplanProjectId = Number(phid.value)));
      pcols.addEventListener("input", () => (p.outlineCollectionIds = pcols.value.split(",").map((x) => x.trim()).filter(Boolean)));
      const picker = h("div", { class: "collections-picker" });
      const pick = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "Wybierz z listy kolekcji Outline") as HTMLButtonElement;
      pick.addEventListener("click", async () => {
        pick.disabled = true;
        try {
          collectionsCache ??= await api<{ id: string; name: string }[]>("GET", "/api/outline/collections");
          picker.replaceChildren(
            h("span", { class: "help" }, "Zaznacz kolekcje, z których asystent może czytać dokumenty dla tego projektu (zakres egzekwowany po stronie serwera):"),
            ...collectionsCache.map((col) => {
              const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
              cb.checked = p.outlineCollectionIds.includes(col.id);
              cb.addEventListener("change", () => {
                p.outlineCollectionIds = cb.checked ? [...new Set([...p.outlineCollectionIds, col.id])] : p.outlineCollectionIds.filter((x) => x !== col.id);
                pcols.value = p.outlineCollectionIds.join(", ");
              });
              return h("label", {}, cb, ` ${col.name} `, h("code", {}, col.id));
            }),
          );
        } catch (e) {
          picker.replaceChildren(errorBox(e));
        } finally {
          pick.disabled = false;
        }
      });
      const remove = h("button", { class: "btn btn-reject btn-small", type: "button" }, "Usuń projekt") as HTMLButtonElement;
      remove.addEventListener("click", () => {
        cfg.projects.splice(idx, 1);
        renderProjects();
      });
      projectsBox.append(
        h(
          "div",
          { class: "project-card" },
          field("Identyfikator (lokalny)", pid, "Małe litery, cyfry, myślniki."),
          field("Nazwa", pname),
          field("ID projektu HacknPlan", phid, "Liczba z adresu projektu w HacknPlan. Wszystkie odczyty i zapisy są ograniczone do tego projektu."),
          field("Kolekcje Outline (ID, po przecinku)", pcols),
          h("div", { class: "proposal-actions" }, pick, remove),
          picker,
          templateHelp ? templateEditor(p, templateHelp) : h("div", { class: "small muted" }, "Nie udało się wczytać pomocy szablonu."),
        ),
      );
    });
    const add = h("button", { class: "btn btn-secondary btn-small", type: "button" }, "+ Dodaj projekt") as HTMLButtonElement;
    add.addEventListener("click", () => {
      cfg.projects.push({ id: `projekt-${cfg.projects.length + 1}`, name: "Nowy projekt", hacknplanProjectId: 1, outlineCollectionIds: [] });
      renderProjects();
    });
    projectsBox.append(add);
  };
  renderProjects();

  const saveMsg = h("div", {});
  const save = h("button", { class: "btn btn-primary", type: "button" }, "Zapisz ustawienia") as HTMLButtonElement;
  save.addEventListener("click", async () => {
    cfg.outline.mode = oMode.value as "demo" | "mcp";
    cfg.outline.mcpUrl = oUrl.value.trim();
    cfg.hacknplan.mode = hMode.value as "demo" | "api";
    cfg.hacknplan.baseUrl = hBase.value.trim();
    cfg.hacknplan.webUrlTemplate = hWeb.value.trim();
    cfg.hacknplan.maxTasksInContext = Number(hMax.value);
    cfg.llm.mode = lMode.value as LlmMode;
    cfg.llm.baseUrl = lBase.value.trim();
    cfg.llm.model = lModel.value.trim();
    cfg.llm.jsonMode = lJson.checked;
    cfg.llm.temperature = Number(lTemp.value);
    cfg.llm.timeoutMs = Number(lTimeout.value);
    cfg.llm.openaiResponses = { baseUrl: oaBase.value.trim(), model: oaModel.value.trim() };
    cfg.llm.anthropic = { baseUrl: anBase.value.trim(), model: anModel.value.trim(), ...(anEffort.value ? { effort: anEffort.value as "low" } : {}) };
    save.disabled = true;
    try {
      await api("PUT", "/api/settings", { config: cfg });
      await loadSession();
      await renderSettings("Zapisano ustawienia.");
      void reloadProjectViews();
    } catch (e) {
      saveMsg.replaceChildren(errorBox(e));
      save.disabled = false;
    }
  });

  c.replaceChildren(
    notice ? h("div", { class: "alert alert-ok" }, notice) : "",
    locked ? h("div", { class: "alert alert-warn" }, "Aplikacja działa z flagą --demo: integracje są zablokowane w trybie demo. Uruchom `npm start`, aby skonfigurować prawdziwe usługi.") : "",
    h(
      "div",
      { class: "settings-grid" },
      h(
        "div",
        { class: "card" },
        h("h3", {}, "Outline (MCP, tylko odczyt)"),
        field("Tryb", oMode),
        field("Adres serwera MCP", oUrl, "Transport: Streamable HTTP. Zwykle https://<zespół>.getoutline.com/mcp lub https://<twoja-domena>/mcp."),
        secretField("outlineToken", "Klucz API Outline", s, "Wysyłany jako Authorization: Bearer. Zalecany zakres: read (tylko odczyt)."),
        testOutline,
        oStatus,
      ),
      h(
        "div",
        { class: "card" },
        h("h3", {}, "HacknPlan (REST API v0)"),
        field("Tryb", hMode),
        field("Adres API", hBase),
        field("Szablon linku do zadania", hWeb, "Podstawiane: {projectId}, {workItemId}."),
        field("Maks. zadań w kontekście", hMax),
        secretField("hacknplanApiKey", "Klucz API HacknPlan", s, "Wysyłany jako Authorization: ApiKey. Zakresy: Projects Read, Work Items Read, Work Items Write."),
      ),
      h(
        "div",
        { class: "card" },
        h("h3", {}, "Model językowy"),
        field("Dostawca", lMode),
        groups.openai,
        groups["openai-responses"],
        groups.anthropic,
        field("Limit czasu (ms)", lTimeout),
        modelList,
        privacy,
        h("div", { class: "proposal-actions" }, listBtn, testBtn),
        h("p", { class: "small muted" }, "„Sprawdź połączenia” nie łączy się z modelem. Test wysyła jedno neutralne zapytanie bez danych projektu."),
        llmResult,
      ),
      h("div", { class: "card" }, h("h3", {}, "Projekty i zakres kolekcji Outline"), projectsBox),
      h(
        "div",
        { class: "card" },
        h("h3", {}, "Pliki danych"),
        h("div", { class: "small" }, "Katalog: ", h("code", {}, s.paths.dir)),
        h("div", { class: "small" }, "Konfiguracja: ", h("code", {}, s.paths.config)),
        h("div", { class: "small" }, "Sekrety: ", h("code", {}, s.paths.secrets)),
        h("div", { class: "small" }, "Baza SQLite: ", h("code", {}, s.paths.db)),
        h("p", { class: "small muted" }, "Pliki mają uprawnienia 0600 (katalog 0700), ale sekrety są przechowywane jawnym tekstem — nie są szyfrowane. Klucze nigdy nie są zwracane do przeglądarki."),
      ),
    ),
    h("div", { class: "settings-footer" }, save, saveMsg),
  );
}

// ---------- nawigacja ----------

function selectTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  if (name === "tasks") void loadTasks();
  if (name === "proposals") void loadProposals();
  if (name === "history") void loadHistory();
  if (name === "settings") void renderSettings();
}

async function reloadProjectViews(): Promise<void> {
  conversationId = null;
  await Promise.all([loadConversations(), loadMessages(), updatePendingCount()]);
  const active = document.querySelector<HTMLButtonElement>('.tabs button[aria-selected="true"]')?.dataset.tab;
  if (active && active !== "chat" && active !== "settings") selectTab(active);
}

async function init(): Promise<void> {
  try {
    await loadSession();
  } catch (e) {
    showGlobalError(e);
    return;
  }
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab ?? "chat")));
  $("project-select").addEventListener("change", (e) => {
    projectId = (e.target as HTMLSelectElement).value;
    void reloadProjectViews();
  });
  $("chat-form").addEventListener("submit", (e) => void sendMessage(e));
  $("chat-input").addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) $<HTMLFormElement>("chat-form").requestSubmit();
  });
  $("new-conversation").addEventListener("click", () => {
    conversationId = null;
    void loadConversations();
    void loadMessages();
    $("chat-input").focus();
  });
  $("task-refresh").addEventListener("click", () => void loadTasks());
  $("task-search").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void loadTasks();
  });
  $("proposal-refresh").addEventListener("click", () => void loadProposals());
  $("proposal-filter").addEventListener("change", () => void loadProposals());
  $("history-refresh").addEventListener("click", () => void loadHistory());
  if (!session.projects.length) {
    showGlobalError(new ApiError("Brak skonfigurowanych projektów.", "Dodaj projekt w zakładce Ustawienia."));
    selectTab("settings");
    return;
  }
  await reloadProjectViews();
}

void init();
