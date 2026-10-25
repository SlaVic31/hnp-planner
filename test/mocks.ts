// Deterministyczne atrapy usług zewnętrznych do testów (bez sieci poza 127.0.0.1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

// ---------------- Outline MCP (prawdziwy protokół MCP przez SDK, transport Streamable HTTP) ----------------

export interface MockDoc {
  id: string;
  title: string;
  collectionId: string;
  text: string;
}

export const MCP_DOCS: MockDoc[] = [
  { id: "d-light", title: "Mechanika światła", collectionId: "col-a", text: "Latarnia zużywa olej. Ostrzeżenie poniżej 20% oleju." },
  { id: "d-storm", title: "Sztorm", collectionId: "col-b", text: "Sztorm co 3-5 nocy; wiatr gasi pochodnie." },
  { id: "d-secret", title: "Poufne wynagrodzenia", collectionId: "col-secret", text: "olej sztorm latarnia — nie powinno trafić do modelu" },
];

export interface McpMock {
  url: string;
  calls: { tool: string; args: Record<string, unknown> }[];
  authHeaders: string[];
  /** Gdy true, list_documents ignoruje filtr kolekcji (symuluje „przeciekający” serwer). */
  leakyScope: boolean;
  stop(): Promise<void>;
}

export async function startMcpMock(opts: { token: string; withWriteTool?: boolean; withoutFetch?: boolean }): Promise<McpMock> {
  const state: McpMock = { url: "", calls: [], authHeaders: [], leakyScope: false, stop: async () => undefined };
  const base = "https://outline.example";
  const buildServer = () => {
    const server = new McpServer({ name: "outline-mock", version: "1.0.0" });
    const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const present = (d: MockDoc) => ({ id: d.id, title: d.title, url: `${base}/doc/${d.id}`, collectionId: d.collectionId });
    server.registerTool(
      "list_documents",
      { annotations: ro, inputSchema: { query: z.string().optional(), collectionId: z.string().optional(), limit: z.number().optional() } },
      async (args) => {
        state.calls.push({ tool: "list_documents", args });
        const q = (args.query ?? "").toLowerCase();
        const words = q.split(/\s+/).filter((w) => w.length > 3);
        const docs = MCP_DOCS.filter((d) => state.leakyScope || !args.collectionId || d.collectionId === args.collectionId).filter(
          (d) => !q || words.some((w) => `${d.title} ${d.text}`.toLowerCase().includes(w)),
        );
        if (!docs.length) return { content: [{ type: "text", text: "[]" }] };
        return { content: docs.map((d) => ({ type: "text" as const, text: JSON.stringify({ document: present(d), context: `<b>${d.title}</b>` }) })) };
      },
    );
    if (!opts.withoutFetch) {
      server.registerTool("fetch", { annotations: ro, inputSchema: { resource: z.enum(["document", "collection"]), id: z.string() } }, async (args) => {
        state.calls.push({ tool: "fetch", args });
        const d = MCP_DOCS.find((x) => x.id === args.id);
        if (!d) return { content: [{ type: "text", text: "Resource not found" }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ document: present(d) }) }, { type: "text", text: d.text }] };
      });
    }
    server.registerTool("list_collections", { annotations: ro, inputSchema: { offset: z.number().optional(), limit: z.number().optional() } }, async (args) => {
      state.calls.push({ tool: "list_collections", args });
      return {
        content: ["col-a", "col-b", "col-secret"].map((id) => ({ type: "text" as const, text: JSON.stringify({ id, name: `Kolekcja ${id}`, url: `${base}/collection/${id}` }) })),
      };
    });
    if (opts.withWriteTool) {
      server.registerTool("create_document", { annotations: { readOnlyHint: false }, inputSchema: { title: z.string() } }, async (args) => {
        state.calls.push({ tool: "create_document", args });
        return { content: [{ type: "text", text: "created" }] };
      });
    }
    return server;
  };

  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    state.authHeaders.push(String(req.headers.authorization ?? ""));
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // Tryb bezstanowy: nowy serwer i transport dla każdego żądania.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = createServer(app);
  const url = await listen(http);
  state.url = `${url}/mcp`;
  state.stop = () => close(http);
  return state;
}

// ---------------- HacknPlan REST v0 ----------------

export interface HpRequest {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

export interface HpMock {
  url: string;
  requests: HpRequest[];
  items: Map<number, Record<string, unknown>>;
  /** Kolejka awarii dla następnych żądań zapisu: "network" zrywa połączenie, liczba = kod HTTP. */
  failNextWrite: (number | "network" | "network-after-commit")[];
  /** Opóźnienie odpowiedzi POST (ms) — do testów współbieżności. */
  createDelayMs: number;
  writes(): HpRequest[];
  stop(): Promise<void>;
}

export const HP_PROJECT = 555;

export async function startHacknPlanMock(opts: { apiKey: string }): Promise<HpMock> {
  const items = new Map<number, Record<string, unknown>>();
  const cat = (id: number, name: string) => ({ projectId: HP_PROJECT, categoryId: id, name });
  const stage = (id: number, name: string) => ({ projectId: HP_PROJECT, stageId: id, name, status: "created" });
  const level = (id: number, name: string, isDefault = false) => ({ projectId: HP_PROJECT, importanceLevelId: id, name, isDefault });
  const board = (id: number, name: string) => ({ projectId: HP_PROJECT, boardId: id, name, isDefault: id === 7 });
  const meta = {
    categories: [cat(1, "Programowanie"), cat(2, "Grafika")],
    stages: [stage(1, "Do zrobienia"), stage(2, "W toku")],
    importancelevels: [level(1, "Pilne"), level(3, "Normalny", true)],
    boards: [board(7, "Sprint 1")],
  };
  const mk = (id: number, title: string, updateDate: string) => ({
    projectId: HP_PROJECT,
    workItemId: id,
    title,
    description: "opis",
    isStory: false,
    category: meta.categories[0],
    stage: meta.stages[0],
    importanceLevel: meta.importancelevels[1],
    board: meta.boards[0],
    estimatedCost: 2,
    updateDate,
    creationDate: "2026-01-01T00:00:00Z",
  });
  items.set(11, mk(11, "Cykl dnia i nocy", "2026-10-01T10:00:00Z"));
  items.set(12, mk(12, "Zużycie oleju", "2026-10-02T10:00:00Z"));
  let nextId = 100;

  const state: HpMock = {
    url: "",
    requests: [],
    items,
    failNextWrite: [],
    createDelayMs: 0,
    writes: () => state.requests.filter((r) => r.method !== "GET"),
    stop: async () => undefined,
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const u = new URL(req.url ?? "/", "http://x");
    const path = u.pathname.replace(/^\/v0/, "");
    const r: HpRequest = { method: req.method ?? "GET", path: `${path}${u.search}`, auth: String(req.headers.authorization ?? ""), body };
    state.requests.push(r);
    if (r.auth !== `ApiKey ${opts.apiKey}`) return send(res, 401, { message: "Unauthorized" });
    const m = path.match(/^\/projects\/(\d+)\/(\w+)(?:\/(\d+))?$/);
    if (!m) return send(res, 404, { message: "not found" });
    const [, pid, coll, wid] = m;
    if (Number(pid) !== HP_PROJECT) return send(res, 403, { message: "Forbidden" });

    if (r.method !== "GET") {
      const fail = state.failNextWrite.shift();
      if (fail === "network") {
        req.socket.destroy();
        return;
      }
      if (typeof fail === "number") return send(res, fail, { message: `simulated ${fail}` });
      if (fail === "network-after-commit") {
        // Zapis się wykonuje, ale odpowiedź ginie.
        if (r.method === "POST" && coll === "workitems") {
          const id = nextId++;
          items.set(id, { ...mk(id, String(body?.title), new Date().toISOString()), creationDate: new Date().toISOString() });
        }
        req.socket.destroy();
        return;
      }
    }

    if (coll === "workitems" && !wid) {
      if (r.method === "GET") {
        const term = u.searchParams.get("searchTerms")?.toLowerCase();
        const list = [...items.values()].filter((w) => !term || String(w.title).toLowerCase().includes(term));
        return send(res, 200, { totalCount: list.length, offset: 0, limit: 100, items: list });
      }
      if (r.method === "POST") {
        if (!body?.title || body.importanceLevelId === undefined) return send(res, 400, { message: "Invalid values object." });
        if (state.createDelayMs) await new Promise((x) => setTimeout(x, state.createDelayMs));
        const id = nextId++;
        const w = { ...mk(id, String(body.title), new Date().toISOString()), description: body.description ?? "", creationDate: new Date().toISOString() };
        items.set(id, w);
        return send(res, 200, w);
      }
    }
    if (coll === "workitems" && wid) {
      const w = items.get(Number(wid));
      if (!w) return send(res, 404, { message: "NotFound" });
      if (r.method === "GET") return send(res, 200, w);
      if (r.method === "PATCH") {
        const next = { ...w, updateDate: new Date(Date.now() + 1000).toISOString() } as Record<string, unknown>;
        for (const [k, v] of Object.entries(body ?? {})) {
          if (k === "stageId") next.stage = meta.stages.find((s) => s.stageId === v);
          else if (k === "categoryId") next.category = meta.categories.find((s) => s.categoryId === v);
          else next[k] = v;
        }
        items.set(Number(wid), next);
        return send(res, 200, {});
      }
    }
    if (r.method === "GET" && coll && coll in meta) return send(res, 200, meta[coll as keyof typeof meta]);
    return send(res, 404, { message: "not found" });
  };

  const http = createServer((req, res) => void handler(req, res));
  const url = await listen(http);
  state.url = `${url}/v0`;
  state.stop = () => close(http);
  return state;
}

// ---------------- Dostawca zgodny z OpenAI ----------------

export interface LlmMock {
  url: string;
  requests: { auth: string; body: Record<string, unknown> }[];
  /** Kolejka odpowiedzi: string = treść wiadomości modelu, number = kod błędu HTTP. */
  replies: (string | number)[];
  stop(): Promise<void>;
}

export async function startLlmMock(opts: { apiKey?: string } = {}): Promise<LlmMock> {
  const state: LlmMock = { url: "", requests: [], replies: [], stop: async () => undefined };
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    state.requests.push({ auth: String(req.headers.authorization ?? ""), body });
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end("{}");
      return;
    }
    if (opts.apiKey && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    const next = state.replies.shift() ?? JSON.stringify({ answer: "brak", proposals: [] });
    if (typeof next === "number") {
      res.writeHead(next, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `error ${next}` } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: next } }] }));
  });
  state.url = `${await listen(http)}/v1`;
  state.stop = () => close(http);
  return state;
}

// ---------------- Oficjalne API dostawców (atrapy formatów Anthropic Messages i OpenAI Responses) ----------------

export interface ProviderMock {
  url: string;
  requests: { path: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  /** Kolejka odpowiedzi: string = tekst modelu, number = kod błędu HTTP, { refusal: kategoria }. */
  replies: (string | number | { refusal: string })[];
  stop(): Promise<void>;
}

async function startProviderMock(kind: "anthropic" | "openai", apiKey: string): Promise<ProviderMock> {
  const state: ProviderMock = { url: "", requests: [], replies: [], stop: async () => undefined };
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    const path = new URL(req.url ?? "/", "http://x").pathname;
    state.requests.push({ path, method: req.method ?? "GET", headers, body });
    const json = (status: number, b: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(b));
    // Aktualne SDK Anthropic wysyła klucz jako „Authorization: Bearer”; starsze jako „x-api-key” — akceptujemy oba.
    const authOk = headers.authorization === `Bearer ${apiKey}` || (kind === "anthropic" && headers["x-api-key"] === apiKey);
    if (!authOk) return json(401, kind === "anthropic" ? { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } : { error: { message: "Incorrect API key", type: "invalid_request_error" } });
    if (req.method === "GET" && path === "/v1/models") {
      return kind === "anthropic"
        ? json(200, { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-opus-5-5" })
        : json(200, { object: "list", data: [{ id: "gpt-6-astra", object: "model", created: 1, owned_by: "openai" }, { id: "gpt-6.1-sol", object: "model", created: 1, owned_by: "openai" }] });
    }
    const next = state.replies.shift() ?? "OK";
    if (typeof next === "number") return json(next, { type: "error", error: { type: "api_error", message: `simulated ${next}` } });
    const model = String(body.model ?? "m");
    if (kind === "anthropic" && path === "/v1/messages") {
      if (typeof next === "object") {
        return json(200, { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: next.refusal, explanation: null }, usage: { input_tokens: 1, output_tokens: 0 } });
      }
      return json(200, { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: next }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (kind === "openai" && path === "/v1/responses") {
      return json(200, {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model,
        output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: String(next), annotations: [] }] }],
      });
    }
    json(404, { error: { message: "not found" } });
  });
  state.url = await listen(http);
  state.stop = () => close(http);
  return state;
}

export const startAnthropicMock = (apiKey: string) => startProviderMock("anthropic", apiKey);
export const startOpenAiMock = (apiKey: string) => startProviderMock("openai", apiKey);
