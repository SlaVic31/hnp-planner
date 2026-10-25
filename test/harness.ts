import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppContext } from "../src/server/app.js";
import { type AppConfig, ConfigSchema, type DataPaths, type SecretName, SecretStore, ensureDataDir, resolveDataPaths, saveConfig } from "../src/server/config.js";
import { type Db, openDb } from "../src/server/db.js";
import { HP_PROJECT, close, listen } from "./mocks.js";

export interface Harness {
  base: string;
  ctx: AppContext;
  db: Db;
  paths: DataPaths;
  secrets: SecretStore;
  get<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  stop(): Promise<void>;
}

export function liveConfig(urls: { mcp?: string; hp?: string; llm?: string }, extra: Partial<AppConfig> = {}): AppConfig {
  return ConfigSchema.parse({
    outline: urls.mcp ? { mode: "mcp", mcpUrl: urls.mcp, timeoutMs: 5000 } : { mode: "demo" },
    hacknplan: urls.hp ? { mode: "api", baseUrl: urls.hp, timeoutMs: 3000 } : { mode: "demo" },
    llm: urls.llm ? { mode: "openai", baseUrl: urls.llm, model: "test-model", timeoutMs: 3000 } : { mode: "demo" },
    projects: [{ id: "gra", name: "Gra", hacknplanProjectId: HP_PROJECT, outlineCollectionIds: ["col-a", "col-b"] }],
    ...extra,
  });
}

export async function startHarness(opts: {
  config: AppConfig;
  secrets?: Partial<Record<SecretName, string>>;
  dir?: string;
  demo?: boolean;
}): Promise<Harness> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "hnp-test-"));
  const paths = resolveDataPaths({ demo: !!opts.demo, dir });
  ensureDataDir(paths);
  saveConfig(paths, opts.config);
  const secrets = new SecretStore(paths);
  for (const [k, v] of Object.entries(opts.secrets ?? {})) secrets.set(k as SecretName, v);
  const db = openDb(paths.dbFile);
  const ctx = createApp({ db, config: opts.config, paths, secrets, demo: !!opts.demo, port: 1, staticDir: join(dir, "no-static") });
  const server = createServer(ctx.app);
  const base = await listen(server);
  ctx.setPort(Number(new URL(base).port));

  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: method === "GET" ? headers : { "Content-Type": "application/json", Origin: base, "X-CSRF-Token": ctx.csrfToken, ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return {
    base,
    ctx,
    db,
    paths,
    secrets,
    get: (p) => call("GET", p),
    post: (p, b, h) => call("POST", p, b, h),
    async stop() {
      await ctx.close();
      await close(server);
      db.close();
    },
  };
}
