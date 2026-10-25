import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/server/config.js";
import { DEFAULT_DESCRIPTION_TEMPLATE, SAMPLE_PARTS, TemplateError, parseTemplate, renderDescription, validateTemplate } from "../src/server/template.js";
import { type Harness, liveConfig, startHarness } from "./harness.js";
import { HP_PROJECT, type HpMock, type LlmMock, type McpMock, startHacknPlanMock, startLlmMock, startMcpMock } from "./mocks.js";

const ctx = { title: "Tytuł", project: "Gra", date: "2026-10-24" };
const empty = { summary: "", acceptanceCriteria: [], technicalNotes: "", sources: [] };

describe("renderowanie szablonu opisu", () => {
  it("domyślny szablon: sekcje z danymi, linki źródeł, deterministycznie", () => {
    const a = renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, SAMPLE_PARTS, ctx);
    const b = renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, SAMPLE_PARTS, ctx);
    expect(a).toBe(b);
    expect(a).toContain("## Kryteria akceptacji\n- Ostrzeżenie dźwiękowe");
    expect(a).toContain("## Źródła\n- [Dokument projektowy: Latarnik](https://outline.example/doc/latarnik-gdd)");
    expect(a).not.toMatch(/\n{3,}/);
  });

  it("puste pola ukrywają sekcje; sekcja odwrócona działa dla pustych", () => {
    const t = "{{summary}}{{#sources}}\nŹródła:\n{{sources}}{{/sources}}{{^sources}}\nBrak źródeł.{{/sources}}{{! komentarz }}";
    expect(renderDescription(t, { ...empty, summary: "X" }, ctx)).toBe("X\nBrak źródeł.");
    expect(renderDescription(DEFAULT_DESCRIPTION_TEMPLATE, empty, ctx)).toBe("");
  });

  it("pola kontekstu: title, project, date", () => {
    expect(renderDescription("{{title}} / {{project}} / {{date}}", empty, ctx)).toBe("Tytuł / Gra / 2026-10-24");
  });

  it("wartości nie są ponownie interpretowane jako znaczniki", () => {
    const out = renderDescription("{{summary}}", { ...empty, summary: "{{title}} {{#sources}}x{{/sources}}" }, ctx);
    expect(out).toBe("{{title}} {{#sources}}x{{/sources}}");
  });

  it("bezpieczne linki: nawiasy w tytule usuwane, nie-http bez linku", () => {
    const out = renderDescription("{{sources}}", { ...empty, sources: [{ ref: "D1", title: "A ] (b) [x", url: "javascript:alert(1)" }, { ref: "D2", title: "Ok", url: "https://x.example/a b(c)" }] }, ctx);
    expect(out).toBe("- A  (b) x\n- [Ok](https://x.example/a%20b%28c%29)");
  });

  it("walidacja: nieznane pole, niezamknięta i źle zamknięta sekcja, niedomknięty znacznik", () => {
    expect(validateTemplate("{{assignee}}")).toMatch(/Nieznane pole „assignee”/);
    expect(validateTemplate("{{#sources}}x")).toMatch(/Niezamknięta sekcja/);
    expect(validateTemplate("{{#sources}}x{{/summary}}")).toMatch(/zamknięta jako/);
    expect(validateTemplate("{{/sources}}")).toMatch(/bez otwarcia/);
    expect(validateTemplate("{{summary")).toMatch(/Niedomknięty/);
    expect(validateTemplate("   ")).toMatch(/pusty/);
    expect(validateTemplate(DEFAULT_DESCRIPTION_TEMPLATE)).toBeNull();
    expect(() => parseTemplate("x".repeat(10001))).toThrow(TemplateError);
  });
});

describe("zgodność wsteczna konfiguracji", () => {
  const oldConfig = {
    port: 4317,
    outline: { mode: "demo", mcpUrl: "", timeoutMs: 20000, maxDocuments: 4, maxCharsPerDocument: 6000 },
    hacknplan: { mode: "demo", baseUrl: "https://api.hacknplan.com/v0", webUrlTemplate: "https://app.hacknplan.com/p/{projectId}/kanban?taskId={workItemId}", timeoutMs: 20000, maxTasksInContext: 60 },
    llm: { mode: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", jsonMode: true, temperature: 0.2, timeoutMs: 120000 },
    projects: [{ id: "latarnik", name: "Latarnik", hacknplanProjectId: 1000, outlineCollectionIds: ["c"] }],
  };

  it("konfiguracja sprzed szablonów i nowych dostawców wczytuje się bez zmian znaczenia", () => {
    const parsed = ConfigSchema.parse(structuredClone(oldConfig));
    expect(parsed.projects[0]!.descriptionTemplate).toBeUndefined();
    expect(parsed.llm.mode).toBe("openai");
    expect(parsed.llm.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(parsed.llm.model).toBe("llama3.1:8b");
  });

  it("nieprawidłowy szablon w konfiguracji jest odrzucany z czytelnym komunikatem", () => {
    const cfg = structuredClone(oldConfig) as typeof oldConfig & { projects: { descriptionTemplate?: string }[] };
    cfg.projects[0]!.descriptionTemplate = "{{nieznane}}";
    const r = ConfigSchema.safeParse(cfg);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/Szablon opisu: Nieznane pole/);
  });
});

interface Prop {
  id: string;
  status: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  display: { templateHash?: string };
}
interface ChatBody {
  assistant: { proposals: Prop[]; meta: { rejected?: { reason: string }[] } };
}

describe("propozycje z opisem z szablonu (tryb połączony z atrapami)", () => {
  let mcp: McpMock;
  let hp: HpMock;
  let llm: LlmMock;
  let app: Harness;
  beforeAll(async () => {
    mcp = await startMcpMock({ token: "tok-123456" });
    llm = await startLlmMock();
  });
  afterAll(async () => {
    await mcp.stop();
    await llm.stop();
  });
  beforeEach(async () => {
    hp = await startHacknPlanMock({ apiKey: "hp-123456" });
    const config = liveConfig({ mcp: mcp.url, hp: hp.url, llm: llm.url });
    config.projects[0]!.descriptionTemplate = "Cel: {{summary}}\n{{#acceptance_criteria}}\nDoD:\n{{acceptance_criteria}}\n{{/acceptance_criteria}}\n{{#sources}}\nŹródła:\n{{sources}}\n{{/sources}}";
    app = await startHarness({ config, secrets: { outlineToken: "tok-123456", hacknplanApiKey: "hp-123456" } });
  });
  afterEach(async () => {
    await app.stop();
    await hp.stop();
  });

  const ask = async (proposals: unknown[]) => {
    llm.replies.push(JSON.stringify({ answer: "ok [D1]", proposals }));
    const r = await app.post<ChatBody>("/api/projects/gra/chat", { message: "Co z olejem w latarni? dodaj zadanie" });
    expect(r.status).toBe(200);
    return r.body.assistant;
  };

  it("opis jest renderowany przed zapisem i hashem; zatwierdzenie wysyła dokładnie ten tekst", async () => {
    const a = await ask([{ type: "create", title: "Ostrzeżenie o oleju", summary: "Ostrzegaj gracza.", acceptanceCriteria: ["Poniżej 20%"], sourceRefs: ["D1", "T12"] }]);
    const p = a.proposals[0]!;
    expect(p.payload.description).toBe(
      `Cel: Ostrzegaj gracza.\n\nDoD:\n- Poniżej 20%\n\nŹródła:\n- [Mechanika światła](https://outline.example/doc/d-light)\n- [#12 Zużycie oleju](https://app.hacknplan.com/p/${HP_PROJECT}/kanban?taskId=12)`,
    );
    expect(p.display.templateHash).toMatch(/^[a-f0-9]{12}$/);
    const ok = await app.post<Prop>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(ok.body.status).toBe("succeeded");
    expect((hp.writes()[0]!.body as { description: string }).description).toBe(p.payload.description);
  });

  it("zmiana szablonu nie zmienia istniejącej propozycji (hash nadal pasuje, wysyłany stary opis)", async () => {
    const p = (await ask([{ type: "create", title: "Stabilny opis", summary: "Treść A", sourceRefs: ["D1"] }])).proposals[0]!;
    const cfg = structuredClone(app.ctx.state.config);
    cfg.projects[0]!.descriptionTemplate = "NOWY: {{summary}}";
    const put = await fetch(`${app.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken },
      body: JSON.stringify({ config: cfg }),
    });
    expect(put.status).toBe(200);
    const stored = (await app.get<Prop[]>("/api/projects/gra/proposals")).body.find((x) => x.id === p.id)!;
    expect(stored.payload.description).toBe(p.payload.description);
    expect(stored.payloadHash).toBe(p.payloadHash);
    const ok = await app.post<Prop>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(ok.body.status).toBe("succeeded");
    expect((hp.writes()[0]!.body as { description: string }).description.startsWith("Cel: Treść A")).toBe(true);
    // Nowe propozycje używają nowego szablonu.
    const p2 = (await ask([{ type: "create", title: "Po zmianie", summary: "Treść B" }])).proposals[0]!;
    expect(p2.payload.description).toBe("NOWY: Treść B");
  });

  it("odwołania do źródeł spoza kontekstu są odrzucane; zwykły description działa jako summary", async () => {
    const a = await ask([
      { type: "create", title: "Zmyślone źródło", summary: "x", sourceRefs: ["D99"] },
      { type: "create", title: "Stary format", description: "Opis bez części" },
      { type: "create", title: "Oba naraz", summary: "a", description: "b" },
    ]);
    expect(a.proposals.map((p) => p.payload.title)).toEqual(["Stary format"]);
    expect(a.proposals[0]!.payload.description).toBe("Cel: Opis bez części");
    const reasons = (a.meta.rejected ?? []).map((r) => r.reason).join("\n");
    expect(reasons).toMatch(/spoza kontekstu: D99/);
    expect(reasons).toMatch(/„summary” albo „description”/);
  });

  it("edycja z descriptionParts renderuje nowy opis; konflikt z changes.description odrzucony", async () => {
    const a = await ask([
      { type: "update", workItemId: 12, changes: { stageId: 2 }, descriptionParts: { summary: "Nowy cel", sourceRefs: ["D1"] } },
      { type: "update", workItemId: 11, changes: { description: "x" }, descriptionParts: { summary: "y" } },
    ]);
    expect(a.proposals).toHaveLength(1);
    expect(a.proposals[0]!.payload.description).toBe("Cel: Nowy cel\n\nŹródła:\n- [Mechanika światła](https://outline.example/doc/d-light)");
    expect(a.meta.rejected?.[0]?.reason).toMatch(/descriptionParts/);
  });

  it("endpoint podglądu waliduje i renderuje bez zapisu", async () => {
    const bad = await app.post<{ ok: boolean; error?: string }>("/api/template/preview", { template: "{{oops}}" });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/Nieznane pole/);
    const good = await app.post<{ ok: boolean; rendered: string }>("/api/template/preview", { template: "{{summary}}", projectName: "Gra" });
    expect(good.body.rendered).toBe(SAMPLE_PARTS.summary);
    expect(hp.writes()).toHaveLength(0);
  });
});
