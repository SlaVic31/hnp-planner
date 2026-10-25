import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UpstreamError } from "../src/server/errors.js";
import { RestHacknPlan } from "../src/server/hacknplan/rest.js";
import { OpenAiCompatibleProvider, type ChatContext } from "../src/server/llm.js";
import { McpOutlineSource } from "../src/server/outline/mcp.js";
import { ScopedOutline } from "../src/server/outline/scoped.js";
import { HP_PROJECT, type HpMock, type LlmMock, type McpMock, startHacknPlanMock, startLlmMock, startMcpMock } from "./mocks.js";

const project = { id: "gra", name: "Gra", hacknplanProjectId: HP_PROJECT, outlineCollectionIds: ["col-a", "col-b"] };

describe("Outline przez MCP (SDK, Streamable HTTP)", () => {
  let mcp: McpMock;
  beforeAll(async () => {
    mcp = await startMcpMock({ token: "outline-secret-token", withWriteTool: true });
  });
  afterAll(async () => mcp.stop());

  it("łączy się, dynamicznie odczytuje narzędzia i blokuje narzędzia zapisu", async () => {
    const src = new McpOutlineSource({ url: mcp.url, token: "outline-secret-token", timeoutMs: 5000 });
    const st = await src.status();
    expect(st.connected).toBe(true);
    expect(st.serverName).toBe("outline-mock");
    expect(st.tools.find((t) => t.name === "list_documents")?.allowed).toBe(true);
    expect(st.blockedWriteTools).toContain("create_document");
    expect(st.missingCapabilities).toEqual([]);
    expect(mcp.authHeaders.every((h) => h === "Bearer outline-secret-token")).toBe(true);
    await src.close();
  });

  it("wyszukuje i pobiera dokumenty wyłącznie z kolekcji projektu (fail closed)", async () => {
    const src = new McpOutlineSource({ url: mcp.url, token: "outline-secret-token", timeoutMs: 5000 });
    const scoped = new ScopedOutline(src, project);
    mcp.leakyScope = true; // serwer zwraca też dokumenty spoza filtra
    const refs = await scoped.search("latarnia olej sztorm", 10);
    mcp.leakyScope = false;
    expect(refs.map((r) => r.id).sort()).toEqual(["d-light", "d-storm"]);
    const doc = await scoped.getDocument("d-light");
    expect(doc.text).toContain("olej");
    expect(doc.url).toBe("https://outline.example/doc/d-light");
    await expect(scoped.getDocument("d-secret")).rejects.toThrow(/nie należy do kolekcji/);
    expect(mcp.calls.some((c) => c.tool === "create_document")).toBe(false);
    await src.close();
  });

  it("zwraca czytelny błąd przy złym tokenie (401)", async () => {
    const src = new McpOutlineSource({ url: mcp.url, token: "zly-token-123", timeoutMs: 5000 });
    const err = await src.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).toMatch(/uwierzytelnienie/);
    expect((err as UpstreamError).opts.hint).toMatch(/klucz API Outline/);
    expect((err as Error).message).not.toContain("zly-token-123");
  });

  it("zgłasza brak wymaganego narzędzia fetch (np. zbyt wąski zakres klucza)", async () => {
    const m = await startMcpMock({ token: "t0ken-abc", withoutFetch: true });
    const src = new McpOutlineSource({ url: m.url, token: "t0ken-abc", timeoutMs: 5000 });
    const st = await src.status();
    expect(st.missingCapabilities.join(" ")).toMatch(/fetch/);
    await expect(src.getDocument("d-light")).rejects.toThrow(/nie udostępnia narzędzia „fetch”/);
    await src.close();
    await m.stop();
  });

  it("zgłasza błąd połączenia przy nieosiągalnym serwerze", async () => {
    const src = new McpOutlineSource({ url: "http://127.0.0.1:9/mcp", token: "x-token-123", timeoutMs: 2000 });
    await expect(src.status()).rejects.toThrow(/Nie udało się połączyć z Outline MCP/);
  });
});

describe("HacknPlan REST v0", () => {
  let hp: HpMock;
  beforeAll(async () => {
    hp = await startHacknPlanMock({ apiKey: "hp-key-123456" });
  });
  afterAll(async () => hp.stop());

  it("używa nagłówka Authorization: ApiKey i czyta zadania oraz metadane", async () => {
    const api = new RestHacknPlan({ baseUrl: hp.url, apiKey: "hp-key-123456", timeoutMs: 3000 });
    const { items } = await api.listWorkItems(HP_PROJECT, { limit: 50 });
    expect(items.map((i) => i.workItemId).sort()).toEqual([11, 12]);
    const meta = await api.getMeta(HP_PROJECT);
    expect(meta.importanceLevels.find((l) => l.isDefault)?.id).toBe(3);
    expect(hp.requests.every((r) => r.auth === "ApiKey hp-key-123456")).toBe(true);
  });

  it("mapuje 401 i 403 na błędy jednoznaczne z podpowiedzią", async () => {
    const bad = new RestHacknPlan({ baseUrl: hp.url, apiKey: "wrong-key-999", timeoutMs: 3000 });
    const e = (await bad.getMeta(HP_PROJECT).catch((x: unknown) => x)) as UpstreamError;
    expect(e.upstream.httpStatus).toBe(401);
    expect(e.upstream.definitive).toBe(true);
    expect(e.opts.hint).toMatch(/nieprawidłowy lub odwołany/);
    const other = new RestHacknPlan({ baseUrl: hp.url, apiKey: "hp-key-123456", timeoutMs: 3000 });
    const e2 = (await other.getMeta(999).catch((x: unknown) => x)) as UpstreamError;
    expect(e2.upstream.httpStatus).toBe(403);
  });

  it("zerwane połączenie przy zapisie to wynik niejednoznaczny", async () => {
    const api = new RestHacknPlan({ baseUrl: hp.url, apiKey: "hp-key-123456", timeoutMs: 3000 });
    hp.failNextWrite.push("network");
    const e = (await api.createWorkItem(HP_PROJECT, { title: "x", isStory: false, estimatedCost: 0, importanceLevelId: 3 }).catch((x: unknown) => x)) as UpstreamError;
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e.upstream.definitive).toBe(false);
  });

  it("brak klucza zgłaszany przed wysłaniem żądania", async () => {
    const api = new RestHacknPlan({ baseUrl: hp.url, apiKey: undefined, timeoutMs: 3000 });
    const before = hp.requests.length;
    await expect(api.getMeta(HP_PROJECT)).rejects.toThrow(/Brak klucza API HacknPlan/);
    expect(hp.requests.length).toBe(before);
  });
});

describe("Dostawca modelu zgodny z OpenAI", () => {
  let llm: LlmMock;
  beforeAll(async () => {
    llm = await startLlmMock({ apiKey: "sk-test-abcdefgh" });
  });
  afterAll(async () => llm.stop());

  const ctx: ChatContext = {
    projectName: "Gra",
    docs: [{ id: "d", title: "Doc", url: "https://x", collectionId: "c", text: "treść", ref: "D1" }],
    tasks: [],
    meta: { categories: [], stages: [], importanceLevels: [], boards: [] },
    history: [],
    question: "pytanie",
    today: "2026-10-24",
  };

  it("wysyła kontekst, model i response_format; zwraca treść", async () => {
    llm.replies.push(JSON.stringify({ answer: "ok [D1]", proposals: [] }));
    const p = new OpenAiCompatibleProvider({ baseUrl: llm.url, model: "m1", apiKey: "sk-test-abcdefgh", jsonMode: true, temperature: 0.1, timeoutMs: 3000 });
    expect(p.isLocal).toBe(true);
    const out = await p.complete(ctx);
    expect(out).toContain("ok [D1]");
    const req = llm.requests.at(-1)!;
    expect(req.body.model).toBe("m1");
    expect(req.body.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(req.body.messages)).toContain("[D1] Doc");
  });

  it("401 → podpowiedź o kluczu, bez ujawniania klucza", async () => {
    const p = new OpenAiCompatibleProvider({ baseUrl: llm.url, model: "m1", apiKey: "sk-wrong-zzzzzzzz", jsonMode: false, temperature: 0, timeoutMs: 3000 });
    const e = (await p.complete(ctx).catch((x: unknown) => x)) as UpstreamError;
    expect(e.upstream.httpStatus).toBe(401);
    expect(e.opts.hint).toMatch(/Klucz API dostawcy/);
    expect(e.message).not.toContain("sk-wrong");
  });

  it("niedostępny lokalny serwer → wskazówka dla Ollamy", async () => {
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: undefined, jsonMode: true, temperature: 0, timeoutMs: 2000 });
    const e = (await p.complete(ctx).catch((x: unknown) => x)) as UpstreamError;
    expect(e.opts.hint).toMatch(/ollama serve/);
  });

  it("zdalny adres jest oznaczany jako niezlokalizowany", () => {
    const p = new OpenAiCompatibleProvider({ baseUrl: "https://api.openai.com/v1", model: "gpt", apiKey: "k", jsonMode: true, temperature: 0, timeoutMs: 1000 });
    expect(p.isLocal).toBe(false);
  });
});
