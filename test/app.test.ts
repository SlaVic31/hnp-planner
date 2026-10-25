import { statSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/server/db.js";
import { ProposalService } from "../src/server/proposals.js";
import { type Harness, liveConfig, startHarness } from "./harness.js";
import { HP_PROJECT, type HpMock, type LlmMock, type McpMock, startHacknPlanMock, startLlmMock, startMcpMock } from "./mocks.js";

interface ProposalBody {
  id: string;
  status: string;
  payloadHash: string;
  kind: string;
  workItemId: number | null;
  payload: Record<string, unknown>;
  result: { workItemId?: number; url?: string } | null;
  error: string | null;
}
interface ChatBody {
  conversationId: string;
  assistant: {
    id: string;
    content: string;
    sources: { type: string; ref: string; url: string; cited: boolean; title: string }[];
    meta: { warnings?: { source: string; message: string; hint?: string }[]; rejected?: { reason: string }[]; error?: boolean };
    proposals: ProposalBody[];
  };
}

const OUTLINE_TOKEN = "ol_api_TESTTOKEN1234567890";
const HP_KEY = "hp-live-key-abcdef123";
const LLM_KEY = "sk-llm-key-zyxwv98765";

const reply = (answer: string, proposals: unknown[] = []) => JSON.stringify({ answer, proposals });
const createProp = (title: string, extra: Record<string, unknown> = {}) => ({ type: "create", title, description: "Z dokumentu [D1]", categoryId: 1, estimatedCost: 3, rationale: "test", ...extra });

let mcp: McpMock;
let hp: HpMock;
let llm: LlmMock;
let app: Harness;

beforeAll(async () => {
  mcp = await startMcpMock({ token: OUTLINE_TOKEN, withWriteTool: true });
  llm = await startLlmMock({ apiKey: LLM_KEY });
});
afterAll(async () => {
  await mcp.stop();
  await llm.stop();
});
beforeEach(async () => {
  hp = await startHacknPlanMock({ apiKey: HP_KEY });
  app = await startHarness({
    config: liveConfig({ mcp: mcp.url, hp: hp.url, llm: llm.url }),
    secrets: { outlineToken: OUTLINE_TOKEN, hacknplanApiKey: HP_KEY, llmApiKey: LLM_KEY },
  });
});
afterEach(async () => {
  await app.stop();
  await hp.stop();
});

async function ask(message: string, conversationId?: string) {
  const r = await app.post<ChatBody>("/api/projects/gra/chat", { message, conversationId });
  expect(r.status).toBe(200);
  return r.body;
}

describe("czat ugruntowany w źródłach (tryb połączony z atrapami)", () => {
  it("odpowiada z linkami do dokumentów Outline i zadań HacknPlan, z zachowaniem zakresu", async () => {
    llm.replies.push(reply("Ostrzeżenie poniżej 20% oleju [D1]. Powiązane: [T12]."));
    const r = await ask("Co mówi dokumentacja o oleju w latarni?");
    const outline = r.assistant.sources.filter((s) => s.type === "outline");
    expect(outline.length).toBeGreaterThan(0);
    expect(outline.every((s) => s.url.startsWith("https://outline.example/doc/"))).toBe(true);
    expect(outline.find((s) => s.ref === "D1")?.cited).toBe(true);
    expect(r.assistant.sources.find((s) => s.ref === "T12")?.url).toContain(`/p/${HP_PROJECT}/`);
    // Dokument spoza kolekcji projektu nie trafia do kontekstu modelu.
    const sent = JSON.stringify(llm.requests.at(-1)!.body);
    expect(sent).not.toContain("Poufne wynagrodzenia");
    expect(sent).toContain("Zużycie oleju");
    // Klient MCP wywołuje wyłącznie narzędzia tylko-do-odczytu, zawsze z filtrem kolekcji.
    expect(mcp.calls.some((c) => c.tool === "create_document")).toBe(false);
    expect(mcp.calls.filter((c) => c.tool === "list_documents").every((c) => ["col-a", "col-b"].includes(String(c.args.collectionId)))).toBe(true);
    // Czat nie zapisuje niczego w HacknPlan.
    expect(hp.writes()).toHaveLength(0);
  });

  it("propozycje modelu są tylko zapisywane jako oczekujące — bez zapisu do HacknPlan", async () => {
    llm.replies.push(reply("Proponuję zadanie.", [createProp("Ostrzeżenie o oleju")]));
    const r = await ask("Dodaj zadanie o ostrzeżeniu");
    expect(r.assistant.proposals).toHaveLength(1);
    expect(r.assistant.proposals[0]!.status).toBe("pending");
    expect(r.assistant.proposals[0]!.payload.importanceLevelId).toBe(3); // domyślny priorytet projektu
    expect(hp.writes()).toHaveLength(0);
  });

  it("odrzuca niepoprawne propozycje: nieznane pola, obce ID, zadania spoza projektu, duplikaty tytułów", async () => {
    llm.replies.push(
      reply("…", [
        createProp("Pole nieznane", { assigneeEmail: "x@y" }),
        createProp("Zła kategoria", { categoryId: 999 }),
        { type: "update", workItemId: 4242, changes: { title: "x" } },
        createProp("Zużycie oleju"),
        { type: "update", workItemId: 11, changes: { title: "Cykl dnia i nocy" } },
        { type: "delete", workItemId: 11 },
        createProp("Poprawna"),
      ]),
    );
    const r = await ask("zaplanuj");
    expect(r.assistant.proposals.map((p) => p.payload.title)).toEqual(["Poprawna"]);
    const reasons = (r.assistant.meta.rejected ?? []).map((x) => x.reason).join("\n");
    expect(reasons).toMatch(/Niedozwolone pola: assigneeEmail/);
    expect(reasons).toMatch(/Kategoria #999 nie istnieje/);
    expect(reasons).toMatch(/#4242 nie należy do bieżących zadań/);
    expect(reasons).toMatch(/już istnieje \(#12\)/);
    expect(reasons).toMatch(/nie zmienia żadnego pola/);
    expect(hp.writes()).toHaveLength(0);
  });

  it("niepoprawny JSON z modelu → odpowiedź tekstowa z ostrzeżeniem, bez propozycji", async () => {
    llm.replies.push("Zwykły tekst bez JSON-a");
    const r = await ask("pytanie o sztorm");
    expect(r.assistant.content).toBe("Zwykły tekst bez JSON-a");
    expect(r.assistant.meta.warnings?.some((w) => /poprawnego JSON/.test(w.message))).toBe(true);
    expect(r.assistant.proposals).toHaveLength(0);
  });

  it("błąd dostawcy modelu jest zapisany jako komunikat z podpowiedzią", async () => {
    llm.replies.push(500);
    const r = await ask("pytanie");
    expect(r.assistant.meta.error).toBe(true);
    expect(r.assistant.meta.warnings?.[0]?.source).toBe("llm");
    expect(r.assistant.meta.warnings?.[0]?.message).toMatch(/500/);
  });

  it("awaria Outline nie blokuje odpowiedzi opartej o zadania (ostrzeżenie)", async () => {
    const cfg = { ...app.ctx.state.config, outline: { ...app.ctx.state.config.outline, mcpUrl: "http://127.0.0.1:9/mcp" } };
    const res = await fetch(`${app.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken },
      body: JSON.stringify({ config: cfg }),
    });
    expect(res.status).toBe(200);
    llm.replies.push(reply("Zadania: [T11]"));
    const r = await ask("Jakie mamy zadania?");
    expect(r.assistant.meta.error).toBeUndefined();
    expect(r.assistant.meta.warnings?.some((w) => w.source === "outline")).toBe(true);
  });
});

describe("zatwierdzanie propozycji", () => {
  async function pendingCreate(title = "Nowe zadanie A") {
    llm.replies.push(reply("ok", [createProp(title)]));
    const r = await ask("dodaj");
    return r.assistant.proposals[0]!;
  }

  it("zapis następuje dopiero po zatwierdzeniu dokładnie tej treści", async () => {
    const p = await pendingCreate();
    expect(hp.writes()).toHaveLength(0);
    const r = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect(r.body.result?.workItemId).toBeGreaterThanOrEqual(100);
    const writes = hp.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("POST");
    expect(writes[0]!.path).toBe(`/projects/${HP_PROJECT}/workitems`);
    expect(writes[0]!.body).toEqual(p.payload);
  });

  it("odrzuca zatwierdzenie z innym hashem (treść inna niż wyświetlona)", async () => {
    const p = await pendingCreate();
    const r = await app.post(`/api/proposals/${p.id}/approve`, { payloadHash: "0".repeat(64) });
    expect(r.status).toBe(409);
    expect(hp.writes()).toHaveLength(0);
  });

  it("nie pozwala wstrzyknąć własnej treści zapisu w żądaniu zatwierdzenia", async () => {
    const p = await pendingCreate();
    const r = await app.post(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash, payload: { title: "podmienione" } });
    expect(r.status).toBe(400);
    expect(hp.writes()).toHaveLength(0);
  });

  it("brak endpointów zapisu poza zatwierdzeniem propozycji", async () => {
    for (const path of [`/api/projects/gra/tasks`, `/api/hacknplan/workitems`, `/api/projects/gra/workitems`]) {
      const r = await app.post(path, { title: "x", importanceLevelId: 3 });
      expect(r.status).toBe(404);
    }
    expect(hp.writes()).toHaveLength(0);
  });

  it("ponowne zatwierdzenie nie tworzy duplikatu", async () => {
    const p = await pendingCreate();
    const a = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    const b = await app.post<{ error: { code: string } }>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("already_decided");
    expect(hp.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });

  it("równoczesne zatwierdzenia wykonują zapis tylko raz", async () => {
    const p = await pendingCreate();
    hp.createDelayMs = 300;
    const results = await Promise.all(Array.from({ length: 5 }, () => app.post(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(hp.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });

  it("odrzucona propozycja nie może zostać zatwierdzona", async () => {
    const p = await pendingCreate();
    expect((await app.post(`/api/proposals/${p.id}/reject`, { payloadHash: p.payloadHash })).status).toBe(200);
    expect((await app.post(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash })).status).toBe(409);
    expect(hp.writes()).toHaveLength(0);
  });

  it("zmiana treści propozycji w bazie poza aplikacją blokuje wykonanie (integralność)", async () => {
    const p = await pendingCreate();
    app.db.prepare(`UPDATE proposals SET payload_json = ? WHERE id = ?`).run(JSON.stringify({ ...p.payload, title: "Podmienione w bazie" }), p.id);
    const r = await app.post<{ error: { code: string } }>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("integrity_error");
    expect(hp.writes()).toHaveLength(0);
  });

  it("zmiana projektu HacknPlan w konfiguracji blokuje starsze propozycje", async () => {
    const p = await pendingCreate();
    const cfg = structuredClone(app.ctx.state.config);
    cfg.projects[0]!.hacknplanProjectId = 999;
    const put = await fetch(`${app.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken },
      body: JSON.stringify({ config: cfg }),
    });
    expect(put.status).toBe(200);
    const r = await app.post<{ error: { code: string } }>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("project_scope_changed");
    expect(hp.writes()).toHaveLength(0);
  });

  it("błąd 400 z HacknPlan → nieudana (wiadomo, że nic nie zapisano)", async () => {
    const p = await pendingCreate();
    hp.failNextWrite.push(400);
    const r = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.body.status).toBe("failed");
    expect(r.body.error).toMatch(/400/);
  });

  it("zerwane połączenie → wynik nieznany, bez automatycznego ponawiania; weryfikacja znajduje zadanie", async () => {
    const p = await pendingCreate("Zadanie z zagubioną odpowiedzią");
    hp.failNextWrite.push("network-after-commit");
    const r = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.body.status).toBe("outcome_unknown");
    expect(hp.writes().filter((w) => w.method === "POST")).toHaveLength(1);
    // Ponowienie bez weryfikacji jest zablokowane.
    const rq = await app.post<{ error: { code: string } }>(`/api/proposals/${p.id}/requeue`, { confirmNotCreated: false });
    expect(rq.status).toBe(409);
    const rec = await app.post<{ found: boolean; proposal: ProposalBody }>(`/api/proposals/${p.id}/reconcile`, {});
    expect(rec.body.found).toBe(true);
    expect(rec.body.proposal.status).toBe("succeeded");
    expect(hp.writes().filter((w) => w.method === "POST")).toHaveLength(1);
  });

  it("wynik nieznany i brak zadania → ponowienie tylko jako NOWA propozycja wymagająca zatwierdzenia", async () => {
    const p = await pendingCreate("Zadanie bez odpowiedzi");
    hp.failNextWrite.push("network");
    expect((await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash })).body.status).toBe("outcome_unknown");
    const rec = await app.post<{ found: boolean }>(`/api/proposals/${p.id}/reconcile`, {});
    expect(rec.body.found).toBe(false);
    const rq = await app.post<ProposalBody>(`/api/proposals/${p.id}/requeue`, { confirmNotCreated: true });
    expect(rq.status).toBe(200);
    expect(rq.body.status).toBe("pending");
    expect(rq.body.id).not.toBe(p.id);
    expect(hp.writes().filter((w) => w.method === "POST")).toHaveLength(1); // wciąż tylko pierwsza próba
    const ok = await app.post<ProposalBody>(`/api/proposals/${rq.body.id}/approve`, { payloadHash: rq.body.payloadHash });
    expect(ok.body.status).toBe("succeeded");
    expect((await app.get<ProposalBody>(`/api/projects/gra/proposals`)).body).toBeDefined();
  });

  it("zatwierdzenie zbiorcze pokazuje częściowy wynik", async () => {
    llm.replies.push(reply("ok", [createProp("Pierwsze"), createProp("Drugie"), createProp("Trzecie")]));
    const r = await ask("dodaj trzy");
    const [a, b, c] = r.assistant.proposals;
    hp.failNextWrite.push(400 as const);
    // pierwsze żądanie zapisu nieudane, kolejne poprawne
    const res = await app.post<{ succeeded: number; failed: number; results: { id: string; ok: boolean; proposal?: ProposalBody }[] }>("/api/proposals/approve-batch", {
      items: [a, b, c].map((p) => ({ id: p!.id, payloadHash: p!.payloadHash })),
    });
    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0]!.proposal?.status).toBe("failed");
    expect(res.body.results[1]!.proposal?.status).toBe("succeeded");
  });
});

describe("edycja zadań i wykrywanie nieaktualnych zmian", () => {
  async function pendingUpdate() {
    llm.replies.push(reply("Przenieś [T12]", [{ type: "update", workItemId: 12, changes: { stageId: 2, estimatedCost: 5 }, rationale: "r" }]));
    const r = await ask("Zmień #12");
    return r.assistant.proposals[0]!;
  }

  it("zapisuje tylko zmienione pola przez PATCH po sprawdzeniu aktualności", async () => {
    const p = await pendingUpdate();
    expect(p.kind).toBe("update");
    const r = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.body.status).toBe("succeeded");
    const w = hp.writes();
    expect(w).toHaveLength(1);
    expect(w[0]!.method).toBe("PATCH");
    expect(w[0]!.path).toBe(`/projects/${HP_PROJECT}/workitems/12`);
    expect(w[0]!.body).toEqual({ stageId: 2, estimatedCost: 5 });
  });

  it("zadanie zmienione w międzyczasie → propozycja nieaktualna, brak zapisu", async () => {
    const p = await pendingUpdate();
    const item = hp.items.get(12)!;
    hp.items.set(12, { ...item, title: "Zmienione przez kogoś", updateDate: "2026-10-23T00:00:00Z" });
    const r = await app.post<ProposalBody>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(r.body.status).toBe("stale");
    expect(r.body.error).toMatch(/zmieniło się/);
    expect(hp.writes()).toHaveLength(0);
  });
});

describe("trwałość i odzyskiwanie", () => {
  it("rozmowy, propozycje i historia operacji przetrwają ponowne otwarcie bazy", async () => {
    llm.replies.push(reply("ok", [createProp("Trwałe zadanie")]));
    const r = await ask("dodaj trwałe");
    const p = r.assistant.proposals[0]!;
    await app.post(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    const file = app.paths.dbFile;
    await app.stop();
    const db = openDb(file);
    const conv = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`).get(r.conversationId) as { n: number };
    expect(conv.n).toBe(2);
    const prop = db.prepare(`SELECT status FROM proposals WHERE id = ?`).get(p.id) as { status: string };
    expect(prop.status).toBe("succeeded");
    const ops = db.prepare(`SELECT action FROM operations WHERE proposal_id = ? ORDER BY id`).all(p.id) as { action: string }[];
    expect(ops.map((o) => o.action)).toEqual(["propose_create", "approve", "execute_create"]);
    db.close();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // ponowne uruchomienie na tych samych danych
    app = await startHarness({ config: liveConfig({ mcp: mcp.url, hp: hp.url, llm: llm.url }), dir: app.paths.dir, secrets: { hacknplanApiKey: HP_KEY } });
    const msgs = await app.get<unknown[]>(`/api/projects/gra/conversations/${r.conversationId}/messages`);
    expect(msgs.body).toHaveLength(2);
  });

  it("propozycje przerwane w trakcie wykonania są po restarcie oznaczane jako „wynik nieznany” i nie są ponawiane", async () => {
    llm.replies.push(reply("ok", [createProp("Przerwane")]));
    const p = (await ask("dodaj")).assistant.proposals[0]!;
    app.db.prepare(`UPDATE proposals SET status = 'executing' WHERE id = ?`).run(p.id);
    const svc = new ProposalService(app.db, { getProject: () => undefined, hacknplan: () => app.ctx.state.integrations.hacknplan, taskUrl: () => "" });
    expect(svc.recoverInterrupted()).toBe(1);
    expect(svc.get(p.id).status).toBe("outcome_unknown");
    expect(hp.writes()).toHaveLength(0);
  });
});

describe("bezpieczeństwo lokalnego API", () => {
  it("odrzuca zapisy bez tokenu CSRF, z obcego Origin, z innym Content-Type lub Host", async () => {
    llm.replies.push(reply("ok", [createProp("CSRF")]));
    const p = (await ask("dodaj")).assistant.proposals[0]!;
    const url = `${app.base}/api/proposals/${p.id}/approve`;
    const body = JSON.stringify({ payloadHash: p.payloadHash });
    const noToken = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: app.base }, body });
    expect(noToken.status).toBe(403);
    const evil = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-CSRF-Token": app.ctx.csrfToken }, body });
    expect(evil.status).toBe(403);
    const crossSite = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "X-CSRF-Token": app.ctx.csrfToken }, body });
    expect(crossSite.status).toBe(403);
    const form = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken }, body: "payloadHash=x" });
    expect(form.status).toBe(415);
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(hp.writes()).toHaveLength(0);
  });

  it("nie zwraca sekretów w ustawieniach ani w błędach; pliki mają uprawnienia 0600", async () => {
    const s = await app.get<Record<string, unknown>>("/api/settings");
    const text = JSON.stringify(s.body);
    for (const secret of [OUTLINE_TOKEN, HP_KEY, LLM_KEY]) expect(text).not.toContain(secret);
    expect((s.body.secrets as Record<string, { set: boolean }>).hacknplanApiKey!.set).toBe(true);
    const session = await app.get("/api/session");
    for (const secret of [OUTLINE_TOKEN, HP_KEY, LLM_KEY]) expect(JSON.stringify(session.body)).not.toContain(secret);
    if (process.platform !== "win32") {
      expect(statSync(app.paths.secretsFile).mode & 0o777).toBe(0o600);
      expect(statSync(app.paths.configFile).mode & 0o777).toBe(0o600);
      expect(statSync(app.paths.dir).mode & 0o777).toBe(0o700);
    }
  });

  it("odrzuca nieprawidłową konfigurację z czytelnym komunikatem", async () => {
    const cfg = structuredClone(app.ctx.state.config) as unknown as Record<string, unknown>;
    (cfg.projects as { outlineCollectionIds: string[] }[])[0]!.outlineCollectionIds = [];
    const r = await fetch(`${app.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken },
      body: JSON.stringify({ config: cfg }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/co najmniej jedną kolekcję/);
  });
});
