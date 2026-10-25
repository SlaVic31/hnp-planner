import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, isLocalModelUrl } from "../src/server/config.js";
import { AppError, UpstreamError } from "../src/server/errors.js";
import type { ChatContext } from "../src/server/llm.js";
import { AnthropicProvider, OpenAiResponsesProvider } from "../src/server/providers.js";
import { parsePublicOrigins } from "../src/server/security.js";
import { type Harness, liveConfig, startHarness } from "./harness.js";
import { type HpMock, type McpMock, type ProviderMock, startAnthropicMock, startHacknPlanMock, startMcpMock, startOpenAiMock } from "./mocks.js";

const ANTHROPIC_KEY = "sk-ant-test-key-1234567890";
const OPENAI_KEY = "sk-openai-test-key-1234567890";

const ctx: ChatContext = {
  projectName: "Gra",
  docs: [{ id: "d", title: "Doc", url: "https://x", collectionId: "c", text: "treść dokumentu", ref: "D1" }],
  tasks: [],
  meta: { categories: [], stages: [], importanceLevels: [], boards: [] },
  history: [{ role: "user", content: "wcześniej" }, { role: "assistant", content: "odp" }],
  question: "pytanie",
  today: "2026-10-24",
};

describe("Anthropic Messages API (oficjalne SDK, atrapa)", () => {
  let mock: ProviderMock;
  beforeAll(async () => {
    mock = await startAnthropicMock(ANTHROPIC_KEY);
  });
  afterAll(async () => mock.stop());
  const provider = (model = "claude-opus-5-5", extra: Partial<{ effort: "low"; apiKey: string }> = {}) =>
    new AnthropicProvider({ baseUrl: mock.url, model, apiKey: ANTHROPIC_KEY, timeoutMs: 5000, ...extra });

  it("wysyła system z kontekstem, historię i pytanie; bez temperature; wybrany model bez fallbacku", async () => {
    mock.replies.push('{"answer":"ok [D1]","proposals":[]}');
    const out = await provider().complete(ctx);
    expect(out).toBe('{"answer":"ok [D1]","proposals":[]}');
    const r = mock.requests.at(-1)!;
    expect(r.path).toBe("/v1/messages");
    expect(r.headers.authorization === `Bearer ${ANTHROPIC_KEY}` || r.headers["x-api-key"] === ANTHROPIC_KEY).toBe(true);
    expect(r.headers["anthropic-version"]).toBeTruthy();
    expect(r.headers["anthropic-beta"]).toBeUndefined();
    expect(r.body).not.toHaveProperty("fallbacks");
    expect(r.body.model).toBe("claude-opus-5-5");
    expect(r.body).not.toHaveProperty("temperature");
    expect(String(r.body.system)).toContain("treść dokumentu");
    expect(r.body.messages).toEqual([
      { role: "user", content: "wcześniej" },
      { role: "assistant", content: "odp" },
      { role: "user", content: "pytanie" },
    ]);
  });

  it("zachowuje inny wybrany model i przekazuje ustawiony effort", async () => {
    mock.replies.push("x");
    await provider("claude-haiku-4-5", { effort: "low" }).complete(ctx);
    const r = mock.requests.at(-1)!;
    expect(r.body).not.toHaveProperty("fallbacks");
    expect(r.headers["anthropic-beta"]).toBeUndefined();
    expect(r.body.model).toBe("claude-haiku-4-5");
    expect(r.body.output_config).toEqual({ effort: "low" });
  });

  it("odmowa (refusal) i błędy HTTP mają czytelne komunikaty bez ujawniania klucza", async () => {
    mock.replies.push({ refusal: "cyber" });
    await expect(provider().complete(ctx)).rejects.toThrow(/odmówił.*cyber/);
    mock.replies.push(404);
    const e404 = (await provider().complete(ctx).catch((x: unknown) => x)) as UpstreamError;
    expect(e404.upstream.httpStatus).toBe(404);
    expect(e404.opts.hint).toMatch(/Pobierz listę modeli|pobierz listę modeli/);
    const e401 = (await provider("claude-opus-5-5", { apiKey: "zly-klucz-abcdef" }).complete(ctx).catch((x: unknown) => x)) as UpstreamError;
    expect(e401.upstream.httpStatus).toBe(401);
    expect(e401.opts.hint).toMatch(/Klucz API Anthropic/);
    expect(e401.message).not.toContain("zly-klucz");
  });

  it("test połączenia i lista modeli", async () => {
    mock.replies.push("OK");
    const before = mock.requests.length;
    const p = await provider().ping();
    expect(p.sample).toBe("OK");
    const pingReq = mock.requests[before]!;
    expect(pingReq.body.model).toBe("claude-opus-5-5");
    expect(pingReq.body).not.toHaveProperty("fallbacks");
    expect(pingReq.headers["anthropic-beta"]).toBeUndefined();
    expect(JSON.stringify(pingReq.body.messages)).toContain("Reply with the single word OK.");
    expect(JSON.stringify(pingReq.body)).not.toContain("treść dokumentu");
    const models = await provider().listModels();
    expect(models).toEqual([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]);
  });

  it("brak klucza → błąd przed jakimkolwiek żądaniem", async () => {
    const before = mock.requests.length;
    await expect(new AnthropicProvider({ baseUrl: mock.url, model: "m", apiKey: undefined, timeoutMs: 1000 }).ping()).rejects.toBeInstanceOf(AppError);
    expect(mock.requests.length).toBe(before);
  });
});

describe("OpenAI Responses API (oficjalne SDK, atrapa)", () => {
  let mock: ProviderMock;
  beforeAll(async () => {
    mock = await startOpenAiMock(OPENAI_KEY);
  });
  afterAll(async () => mock.stop());
  const provider = (apiKey = OPENAI_KEY) => new OpenAiResponsesProvider({ baseUrl: `${mock.url}/v1`, model: "gpt-6-astra", apiKey, timeoutMs: 5000 });

  it("wysyła instructions z kontekstem, input z historią, json_object i store:false", async () => {
    mock.replies.push('{"answer":"a","proposals":[]}');
    expect(await provider().complete(ctx)).toBe('{"answer":"a","proposals":[]}');
    const r = mock.requests.at(-1)!;
    expect(r.path).toBe("/v1/responses");
    expect(r.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(r.body.store).toBe(false);
    expect(r.body.text).toEqual({ format: { type: "json_object" } });
    expect(String(r.body.instructions)).toContain("treść dokumentu");
    expect(r.body.input).toEqual([
      { role: "user", content: "wcześniej" },
      { role: "assistant", content: "odp" },
      { role: "user", content: "pytanie" },
    ]);
  });

  it("ping, lista modeli i błędy", async () => {
    mock.replies.push("OK");
    expect((await provider().ping()).sample).toBe("OK");
    expect((await provider().listModels()).map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    mock.replies.push(429);
    const e = (await provider().complete(ctx).catch((x: unknown) => x)) as UpstreamError;
    expect(e.upstream.httpStatus).toBe(429);
    expect(e.opts.hint).toMatch(/Limit zapytań/);
    const e401 = (await provider("sk-wrong-zzzzzzzzzz").ping().catch((x: unknown) => x)) as UpstreamError;
    expect(e401.upstream.httpStatus).toBe(401);
    expect(e401.message).not.toContain("sk-wrong");
  });
});

describe("konfiguracja dostawców i adresów", () => {
  it("nowe pola mają wartości domyślne; tryb „openai” nadal oznacza endpoint zgodny z OpenAI", () => {
    const c = ConfigSchema.parse({ llm: { mode: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "x" } });
    expect(c.llm.openaiResponses).toEqual({ baseUrl: "https://api.openai.com/v1", model: "gpt-6-astra" });
    expect(c.llm.anthropic.model).toBe("claude-opus-5-5");
    expect(ConfigSchema.safeParse({ llm: { mode: "anthropic", anthropic: { baseUrl: "nie-url", model: "" } } }).success).toBe(false);
  });

  it("host Dockera to model lokalny; adres publiczny nie", () => {
    expect(isLocalModelUrl("http://host.docker.internal:11434/v1")).toBe(true);
    expect(isLocalModelUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalModelUrl("https://api.anthropic.com")).toBe(false);
  });

  it("HNP_PUBLIC_ORIGINS akceptuje wyłącznie http na pętli zwrotnej", () => {
    expect(parsePublicOrigins("http://127.0.0.1:4327, http://localhost:4327")).toEqual(["http://127.0.0.1:4327", "http://localhost:4327"]);
    expect(parsePublicOrigins(undefined)).toEqual([]);
    for (const bad of ["http://192.168.1.10:4317", "https://127.0.0.1:4317", "http://example.com:80", "http://127.0.0.1", "http://0.0.0.0:4317"]) {
      expect(() => parsePublicOrigins(bad)).toThrow(/HNP_PUBLIC_ORIGINS/);
    }
  });
});

describe("aplikacja z dostawcą Anthropic (atrapy, bez płatnych wywołań)", () => {
  let mcp: McpMock;
  let hp: HpMock;
  let anthropic: ProviderMock;
  let app: Harness;
  beforeAll(async () => {
    mcp = await startMcpMock({ token: "tok-123456" });
    anthropic = await startAnthropicMock(ANTHROPIC_KEY);
  });
  afterAll(async () => {
    await mcp.stop();
    await anthropic.stop();
  });
  beforeEach(async () => {
    hp = await startHacknPlanMock({ apiKey: "hp-123456" });
    const config = liveConfig({ mcp: mcp.url, hp: hp.url });
    config.llm = ConfigSchema.parse({ llm: { mode: "anthropic", anthropic: { baseUrl: anthropic.url, model: "claude-opus-5-5" } } }).llm;
    app = await startHarness({ config, secrets: { outlineToken: "tok-123456", hacknplanApiKey: "hp-123456", anthropicApiKey: ANTHROPIC_KEY } });
  });
  afterEach(async () => {
    await app.stop();
    await hp.stop();
  });

  it("czat → propozycja przez Claude; zatwierdzenie nadal wymagane", async () => {
    anthropic.replies.push(JSON.stringify({ answer: "Wg [D1].", proposals: [{ type: "create", title: "Z Claude", summary: "S", sourceRefs: ["D1"] }] }));
    const r = await app.post<{ assistant: { proposals: { status: string }[]; meta: { model?: string } } }>("/api/projects/gra/chat", { message: "olej w latarni — dodaj zadanie" });
    expect(r.body.assistant.meta.model).toMatch(/Anthropic Claude API/);
    expect(r.body.assistant.proposals[0]!.status).toBe("pending");
    expect(hp.writes()).toHaveLength(0);
  });

  it("status nie twierdzi, że model działa; test połączenia jest prawdziwy i zapisany w historii", async () => {
    const st = await app.get<{ llm: { ok: boolean | null; tested: boolean; isLocal: boolean } }>("/api/status");
    expect(st.body.llm.ok).toBeNull();
    expect(st.body.llm.tested).toBe(false);
    expect(st.body.llm.isLocal).toBe(false);
    anthropic.replies.push("OK");
    const before = anthropic.requests.length;
    const t = await app.post<{ ok: boolean; sample: string }>("/api/llm/test", {});
    expect(t.body).toMatchObject({ ok: true, sample: "OK" });
    expect(anthropic.requests.length).toBe(before + 1);
    expect(JSON.stringify(t.body)).not.toContain(ANTHROPIC_KEY);
    const m = await app.get<{ models: { id: string }[] }>("/api/llm/models");
    expect(m.body.models[0]!.id).toBe("claude-opus-5-5");
    // Test modelu jest operacją globalną (bez projektu) — sprawdzamy wpis bezpośrednio w bazie.
    const row = app.db.prepare(`SELECT outcome, detail_json FROM operations WHERE action = 'llm_test'`).get() as { outcome: string; detail_json: string };
    expect(row.outcome).toBe("ok");
    expect(row.detail_json).not.toContain(ANTHROPIC_KEY);
    const settings = await app.get("/api/settings");
    expect(JSON.stringify(settings.body)).not.toContain(ANTHROPIC_KEY);
  });

  it("błąd testu połączenia zwraca podpowiedź", async () => {
    anthropic.replies.push(500);
    const t = await app.post<{ error: { message: string; hint?: string } }>("/api/llm/test", {});
    expect(t.status).toBe(502);
    expect(t.body.error.hint).toMatch(/po stronie dostawcy/);
  });
});

describe("źródła przeglądarki dla portu opublikowanego przez Dockera", () => {
  it("akceptuje Host/Origin portu hosta, odrzuca inne", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const { createApp } = await import("../src/server/app.js");
    const { SecretStore, ensureDataDir, resolveDataPaths, demoConfig } = await import("../src/server/config.js");
    const { openDb } = await import("../src/server/db.js");
    const dir = mkdtempSync(join(tmpdir(), "hnp-origin-"));
    const paths = resolveDataPaths({ demo: true, dir });
    ensureDataDir(paths);
    const db = openDb(paths.dbFile);
    const ctxApp = createApp({ db, config: demoConfig(), paths, secrets: new SecretStore(paths), demo: true, port: 4317, publicOrigins: ["http://127.0.0.1:4327"] });
    const server = createServer(ctxApp.app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const call = (host: string, origin?: string) =>
      new Promise<number>((resolve) => {
        import("node:http").then(({ request }) => {
          const req = request(
            { host: "127.0.0.1", port, path: "/api/template/preview", method: "POST", headers: { Host: host, "Content-Type": "application/json", "X-CSRF-Token": ctxApp.csrfToken, ...(origin ? { Origin: origin } : {}) } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.end(JSON.stringify({ template: "{{summary}}" }));
        });
      });
    expect(await call("127.0.0.1:4327", "http://127.0.0.1:4327")).toBe(200);
    expect(await call("127.0.0.1:4327", "http://127.0.0.1:9999")).toBe(403);
    expect(await call("192.168.1.5:4327", "http://127.0.0.1:4327")).toBe(421);
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
});
