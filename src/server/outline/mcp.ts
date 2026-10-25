import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { AppError, UpstreamError, errorMessage } from "../errors.js";
import type { OutlineCollection, OutlineDoc, OutlineDocRef, OutlineSource, OutlineStatus, OutlineToolInfo } from "./types.js";

/**
 * Narzędzia oficjalnego serwera MCP Outline, z których korzystamy (tylko odczyt).
 * Lista pochodzi z kodu Outline (server/mcp/tools/*.ts). Każde narzędzie musi
 * dodatkowo deklarować `annotations.readOnlyHint === true` w odpowiedzi tools/list.
 */
const READ_TOOLS = ["list_documents", "fetch", "list_collections", "list_collection_documents"] as const;
type ReadTool = (typeof READ_TOOLS)[number];

interface ListedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

interface TextContent {
  type: string;
  text?: string;
}

export interface McpOutlineOptions {
  url: string;
  token: string | undefined;
  timeoutMs: number;
}

/**
 * Klient Outline przez oficjalny protokół MCP (transport Streamable HTTP, SDK
 * @modelcontextprotocol/sdk). Uwierzytelnienie: nagłówek `Authorization: Bearer <klucz API>`.
 */
export class McpOutlineSource implements OutlineSource {
  readonly mode = "mcp" as const;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: ListedTool[] = [];

  constructor(private readonly opts: McpOutlineOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.opts.token) {
        throw new AppError("Brak klucza API Outline. Ustaw go w Ustawieniach lub w zmiennej HNP_OUTLINE_TOKEN.", {
          status: 400,
          code: "outline_no_token",
          source: "outline",
        });
      }
      const client = new Client({ name: "hnp-planner", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
        requestInit: { headers: { Authorization: `Bearer ${this.opts.token}` } },
      });
      try {
        await client.connect(transport, { timeout: this.opts.timeoutMs });
        const tools: ListedTool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.timeoutMs });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        this.tools = tools;
        this.client = client;
        this.transport = transport;
        return client;
      } catch (e) {
        await client.close().catch(() => undefined);
        throw mapMcpError(e, "połączenie z serwerem MCP");
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private allowedTool(name: ReadTool): boolean {
    const t = this.tools.find((x) => x.name === name);
    return !!t && t.annotations?.readOnlyHint === true;
  }

  /** Jedyna ścieżka wywołań narzędzi — dopuszcza wyłącznie znane narzędzia tylko-do-odczytu. */
  private async callReadTool(name: ReadTool, args: Record<string, unknown>): Promise<TextContent[]> {
    const client = await this.connect();
    if (!this.allowedTool(name)) {
      throw new AppError(
        `Serwer MCP Outline nie udostępnia narzędzia „${name}” jako tylko-do-odczytu. Sprawdź, czy klucz API ma zakres odczytu dokumentów i kolekcji (np. „read”).`,
        { status: 502, code: "outline_missing_tool", source: "outline" },
      );
    }
    let res;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout: this.opts.timeoutMs });
    } catch (e) {
      // Po błędzie transportu wymuszamy ponowne połączenie przy następnym wywołaniu.
      await this.close();
      throw mapMcpError(e, `narzędzie ${name}`);
    }
    const content = (res.content ?? []) as TextContent[];
    if (res.isError) {
      const msg = content.map((c) => c.text ?? "").join(" ").slice(0, 300);
      throw new UpstreamError(`Outline zwrócił błąd narzędzia ${name}: ${msg || "brak szczegółów"}`, {
        source: "outline",
        definitive: true,
        hint: /not ?found|404/i.test(msg) ? "Dokument lub kolekcja nie istnieje albo brak do niej dostępu." : undefined,
      });
    }
    return content;
  }

  async search(query: string, collectionId: string, limit: number): Promise<OutlineDocRef[]> {
    const args: Record<string, unknown> = { collectionId, limit };
    if (query.trim()) args.query = query.trim().slice(0, 200);
    const content = await this.callReadTool("list_documents", args);
    const out: OutlineDocRef[] = [];
    for (const item of parseJsonItems(content)) {
      const doc = (item as { document?: Record<string, unknown> }).document;
      if (!doc || typeof doc.id !== "string") continue;
      out.push({
        id: doc.id,
        title: String(doc.title ?? "(bez tytułu)"),
        url: String(doc.url ?? ""),
        collectionId: typeof doc.collectionId === "string" ? doc.collectionId : null,
        snippet: stripTags(String((item as { context?: unknown }).context ?? "")).slice(0, 300) || undefined,
      });
    }
    return out;
  }

  async getDocument(id: string): Promise<OutlineDoc> {
    const content = await this.callReadTool("fetch", { resource: "document", id });
    const [metaPart, ...rest] = content.filter((c) => c.type === "text");
    let meta: Record<string, unknown> = {};
    try {
      meta = (JSON.parse(metaPart?.text ?? "{}") as { document?: Record<string, unknown> }).document ?? {};
    } catch {
      throw new UpstreamError("Nieoczekiwany format odpowiedzi narzędzia fetch z Outline.", { source: "outline", definitive: true });
    }
    if (typeof meta.id !== "string") {
      throw new UpstreamError("Odpowiedź Outline nie zawiera identyfikatora dokumentu.", { source: "outline", definitive: true });
    }
    return {
      id: meta.id,
      title: String(meta.title ?? "(bez tytułu)"),
      url: String(meta.url ?? ""),
      collectionId: typeof meta.collectionId === "string" ? meta.collectionId : null,
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
      text: rest.map((r) => r.text ?? "").join("\n"),
    };
  }

  async listCollections(): Promise<OutlineCollection[]> {
    const out: OutlineCollection[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const content = await this.callReadTool("list_collections", { offset, limit: 100 });
      const items = parseJsonItems(content);
      for (const c of items) {
        const col = c as Record<string, unknown>;
        if (typeof col.id === "string") out.push({ id: col.id, name: String(col.name ?? col.id), url: typeof col.url === "string" ? col.url : undefined });
      }
      if (items.length < 100) break;
    }
    return out;
  }

  async status(): Promise<OutlineStatus> {
    const client = await this.connect();
    const info = client.getServerVersion();
    const tools: OutlineToolInfo[] = this.tools.map((t) => ({
      name: t.name,
      readOnlyHint: t.annotations?.readOnlyHint ?? null,
      allowed: (READ_TOOLS as readonly string[]).includes(t.name) && t.annotations?.readOnlyHint === true,
    }));
    const missing = (["list_documents", "fetch"] as const).filter((n) => !this.allowedTool(n));
    return {
      mode: "mcp",
      connected: true,
      serverName: info?.name,
      serverVersion: info?.version,
      protocolVersion: this.transport?.protocolVersion,
      tools,
      blockedWriteTools: tools.filter((t) => t.readOnlyHint !== true).map((t) => t.name),
      missingCapabilities: missing.map((m) => `Brak narzędzia ${m} (wymagany zakres odczytu dokumentów)`),
    };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transport = null;
    this.tools = [];
    if (c) await c.close().catch(() => undefined);
  }
}

function parseJsonItems(content: TextContent[]): unknown[] {
  const out: unknown[] = [];
  for (const c of content) {
    if (c.type !== "text" || !c.text) continue;
    try {
      const v = JSON.parse(c.text) as unknown;
      if (Array.isArray(v)) out.push(...v);
      else out.push(v);
    } catch {
      /* fragmenty niebędące JSON-em pomijamy */
    }
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function mapMcpError(e: unknown, what: string): AppError {
  if (e instanceof AppError) return e;
  const code =
    e instanceof StreamableHTTPError ? e.code : e instanceof UnauthorizedError ? 401 : undefined;
  if (code === 401 || code === 403 || e instanceof UnauthorizedError) {
    return new UpstreamError(`Outline odrzucił uwierzytelnienie (${code ?? 401}) podczas: ${what}.`, {
      source: "outline",
      httpStatus: code,
      definitive: true,
      hint: "Sprawdź klucz API Outline (nagłówek Bearer), czy MCP jest włączone w Settings → AI oraz czy klucz nie wygasł.",
    });
  }
  if (code === 404) {
    return new UpstreamError(`Serwer nie udostępnia punktu MCP pod podanym adresem (404).`, {
      source: "outline",
      httpStatus: 404,
      definitive: true,
      hint: "Adres powinien kończyć się na /mcp, np. https://twoj-zespol.getoutline.com/mcp.",
    });
  }
  if (e instanceof McpError) {
    return new UpstreamError(`Błąd protokołu MCP (${e.code}) podczas: ${what}: ${errorMessage(e)}`, {
      source: "outline",
      definitive: false,
      hint: e.code === -32001 ? "Przekroczono czas oczekiwania — zwiększ outline.timeoutMs lub sprawdź sieć." : undefined,
    });
  }
  return new UpstreamError(`Nie udało się połączyć z Outline MCP podczas: ${what}: ${errorMessage(e)}`, {
    source: "outline",
    definitive: false,
    hint: "Sprawdź adres serwera MCP i połączenie sieciowe.",
  });
}
