import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MAX_TEMPLATE_LENGTH, validateTemplate } from "./template.js";

/** Adres nasłuchu jest stały — aplikacja nigdy nie nasłuchuje poza pętlą zwrotną. */
export const BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

export const ProjectSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Identyfikator projektu: małe litery, cyfry i myślniki (maks. 40 znaków)"),
    name: z.string().trim().min(1).max(100),
    hacknplanProjectId: z.number().int().positive(),
    outlineCollectionIds: z.array(z.string().trim().min(1).max(100)).max(50),
    /**
     * Szablon opisu zadań (Markdown) dla tego projektu. Brak pola = szablon domyślny,
     * dzięki czemu konfiguracje sprzed wprowadzenia szablonów wczytują się bez zmian.
     */
    descriptionTemplate: z
      .string()
      .max(MAX_TEMPLATE_LENGTH)
      .superRefine((t, ctx) => {
        const err = validateTemplate(t);
        if (err) ctx.addIssue({ code: "custom", message: `Szablon opisu: ${err}` });
      })
      .optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectSchema>;

export const ConfigSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
    outline: z
      .object({
        mode: z.enum(["demo", "mcp"]).default("demo"),
        /** Pełny adres punktu MCP, np. https://twoj-zespol.getoutline.com/mcp */
        mcpUrl: z.string().default(""),
        timeoutMs: z.number().int().min(1000).max(120000).default(20000),
        maxDocuments: z.number().int().min(1).max(10).default(4),
        maxCharsPerDocument: z.number().int().min(500).max(50000).default(6000),
      })
      .strict()
      .prefault({}),
    hacknplan: z
      .object({
        mode: z.enum(["demo", "api"]).default("demo"),
        baseUrl: z.string().default("https://api.hacknplan.com/v0"),
        /** Szablon linku do zadania w aplikacji webowej; {projectId} i {workItemId} są podstawiane. */
        webUrlTemplate: z.string().default("https://app.hacknplan.com/p/{projectId}/kanban?taskId={workItemId}"),
        timeoutMs: z.number().int().min(1000).max(120000).default(20000),
        maxTasksInContext: z.number().int().min(5).max(200).default(60),
      })
      .strict()
      .prefault({}),
    llm: z
      .object({
        /**
         * demo — model regułowy; openai — DOWOLNY serwer zgodny z OpenAI Chat Completions
         * (Ollama, LM Studio, vLLM…; nazwa zachowana dla zgodności wstecz);
         * openai-responses — oficjalne OpenAI Responses API (klucz API);
         * anthropic — oficjalne Anthropic Messages API (klucz API).
         */
        mode: z.enum(["demo", "openai", "openai-responses", "anthropic"]).default("demo"),
        /** Adres bazowy API zgodnego z OpenAI, np. http://127.0.0.1:11434/v1 (Ollama). */
        baseUrl: z.string().default("http://127.0.0.1:11434/v1"),
        model: z.string().default("llama3.1:8b"),
        jsonMode: z.boolean().default(true),
        temperature: z.number().min(0).max(2).default(0.2),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
        openaiResponses: z
          .object({
            baseUrl: z.string().default("https://api.openai.com/v1"),
            model: z.string().default("gpt-6-astra"),
          })
          .strict()
          .prefault({}),
        anthropic: z
          .object({
            baseUrl: z.string().default("https://api.anthropic.com"),
            model: z.string().default("claude-opus-5-5"),
            /** Poziom wysiłku (output_config.effort); brak = domyślny dla modelu. */
            effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    projects: z.array(ProjectSchema).max(50).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    cfg.projects.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["projects", i, "id"], message: "Zduplikowany identyfikator projektu" });
      ids.add(p.id);
    });
    if (cfg.outline.mode === "mcp") {
      if (!isHttpUrl(cfg.outline.mcpUrl)) {
        ctx.addIssue({ code: "custom", path: ["outline", "mcpUrl"], message: "Podaj adres http(s) serwera MCP Outline (zwykle https://<zespół>.getoutline.com/mcp)" });
      }
      cfg.projects.forEach((p, i) => {
        if (p.outlineCollectionIds.length === 0) {
          ctx.addIssue({ code: "custom", path: ["projects", i, "outlineCollectionIds"], message: "W trybie MCP każdy projekt musi mieć co najmniej jedną kolekcję Outline" });
        }
      });
    }
    if (cfg.hacknplan.mode === "api" && !isHttpUrl(cfg.hacknplan.baseUrl)) {
      ctx.addIssue({ code: "custom", path: ["hacknplan", "baseUrl"], message: "Nieprawidłowy adres API HacknPlan" });
    }
    if (cfg.llm.mode === "openai") {
      if (!isHttpUrl(cfg.llm.baseUrl)) ctx.addIssue({ code: "custom", path: ["llm", "baseUrl"], message: "Nieprawidłowy adres bazowy dostawcy modelu" });
      if (!cfg.llm.model.trim()) ctx.addIssue({ code: "custom", path: ["llm", "model"], message: "Podaj nazwę modelu" });
    }
    for (const [mode, key] of [["openai-responses", "openaiResponses"], ["anthropic", "anthropic"]] as const) {
      if (cfg.llm.mode !== mode) continue;
      const sub = cfg.llm[key];
      if (!isHttpUrl(sub.baseUrl)) ctx.addIssue({ code: "custom", path: ["llm", key, "baseUrl"], message: "Nieprawidłowy adres API dostawcy" });
      if (!sub.model.trim()) ctx.addIssue({ code: "custom", path: ["llm", key, "model"], message: "Podaj identyfikator modelu" });
    }
  });
export type AppConfig = z.infer<typeof ConfigSchema>;

export const SECRET_NAMES = ["outlineToken", "hacknplanApiKey", "llmApiKey", "openaiApiKey", "anthropicApiKey"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Partial<Record<SecretName, string>>;

const SECRET_ENV: Record<SecretName, string> = {
  outlineToken: "HNP_OUTLINE_TOKEN",
  hacknplanApiKey: "HNP_HACKNPLAN_API_KEY",
  llmApiKey: "HNP_LLM_API_KEY",
  openaiApiKey: "HNP_OPENAI_API_KEY",
  anthropicApiKey: "HNP_ANTHROPIC_API_KEY",
};

const SecretsSchema = z
  .object({
    outlineToken: z.string().optional(),
    hacknplanApiKey: z.string().optional(),
    llmApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),
    anthropicApiKey: z.string().optional(),
  })
  .strict();

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Czy model działa na tym komputerze: pętla zwrotna lub host Dockera (host.docker.internal),
 * czyli maszyna, na której działa kontener. Dane nie opuszczają wtedy komputera.
 */
export function isLocalModelUrl(value: string): boolean {
  if (isLoopbackUrl(value)) return true;
  try {
    return new URL(value).hostname === "host.docker.internal";
  } catch {
    return false;
  }
}

/** Czy adres wskazuje na tę maszynę (ważne dla oceny prywatności modelu). */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

export interface DataPaths {
  dir: string;
  configFile: string;
  secretsFile: string;
  dbFile: string;
}

export function resolveDataPaths(opts: { demo: boolean; dir?: string }): DataPaths {
  const dir = opts.dir ?? process.env.HNP_PLANNER_HOME ?? join(homedir(), ".hnp-planner");
  return {
    dir,
    configFile: join(dir, opts.demo ? "config.demo.json" : "config.json"),
    secretsFile: join(dir, "secrets.json"),
    dbFile: join(dir, opts.demo ? "demo.sqlite" : "data.sqlite"),
  };
}

/** Tworzy katalog danych z uprawnieniami 0700 i zaostrza je, jeśli są zbyt szerokie. */
export function ensureDataDir(paths: DataPaths): string[] {
  const warnings: string[] = [];
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  warnings.push(...tightenPermissions(paths.dir, 0o700));
  for (const f of [paths.configFile, paths.secretsFile, paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`]) {
    if (existsSync(f)) warnings.push(...tightenPermissions(f, 0o600));
  }
  return warnings;
}

export function tightenPermissions(path: string, mode: number): string[] {
  if (process.platform === "win32") return [];
  const current = statSync(path).mode & 0o777;
  if ((current & ~mode) !== 0) {
    chmodSync(path, mode);
    return [`Zaostrzono uprawnienia ${path} z ${current.toString(8)} na ${mode.toString(8)}`];
  }
  return [];
}

/** Zapis atomowy z uprawnieniami 0600 (plik tymczasowy + rename). */
export function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function demoConfig(): AppConfig {
  return ConfigSchema.parse({
    projects: [
      {
        id: "latarnik",
        name: "Latarnik (demo)",
        hacknplanProjectId: 1000,
        outlineCollectionIds: ["col-design", "col-tech"],
      },
    ],
  });
}

export function loadConfig(paths: DataPaths, opts: { demo: boolean }): AppConfig {
  if (opts.demo) {
    // Tryb demo zawsze wymusza fikcyjne integracje, niezależnie od zawartości pliku.
    const base = existsSync(paths.configFile) ? parseConfigFile(paths.configFile) : demoConfig();
    const forced = { ...base, outline: { ...base.outline, mode: "demo" as const }, hacknplan: { ...base.hacknplan, mode: "demo" as const }, llm: { ...base.llm, mode: "demo" as const } };
    if (!existsSync(paths.configFile)) saveConfig(paths, forced);
    return forced;
  }
  if (!existsSync(paths.configFile)) {
    const cfg = demoConfig();
    saveConfig(paths, cfg);
    return cfg;
  }
  return parseConfigFile(paths.configFile);
}

function parseConfigFile(file: string): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Nie można odczytać pliku konfiguracji ${file}: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Nieprawidłowa konfiguracja w ${file}:\n${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export function saveConfig(paths: DataPaths, cfg: AppConfig): void {
  writePrivateFile(paths.configFile, JSON.stringify(cfg, null, 2) + "\n");
}

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join(".") || "(całość)"}: ${i.message}`).join("\n");
}

export class SecretStore {
  private fileSecrets: Secrets = {};

  constructor(private readonly paths: DataPaths) {
    if (existsSync(paths.secretsFile)) {
      const parsed = SecretsSchema.safeParse(JSON.parse(readFileSync(paths.secretsFile, "utf8")));
      if (!parsed.success) throw new Error(`Nieprawidłowy plik sekretów ${paths.secretsFile}`);
      this.fileSecrets = parsed.data;
    }
  }

  get(name: SecretName): string | undefined {
    const env = process.env[SECRET_ENV[name]];
    if (env && env.trim()) return env.trim();
    const v = this.fileSecrets[name];
    return v && v.trim() ? v : undefined;
  }

  source(name: SecretName): "env" | "file" | null {
    if (process.env[SECRET_ENV[name]]?.trim()) return "env";
    return this.fileSecrets[name]?.trim() ? "file" : null;
  }

  set(name: SecretName, value: string | null): void {
    const next = { ...this.fileSecrets };
    if (value === null || value.trim() === "") delete next[name];
    else next[name] = value.trim();
    writePrivateFile(this.paths.secretsFile, JSON.stringify(next, null, 2) + "\n");
    this.fileSecrets = next;
  }

  /** Wszystkie znane wartości sekretów — do maskowania w komunikatach błędów i logach. */
  values(): string[] {
    return SECRET_NAMES.map((n) => this.get(n)).filter((v): v is string => !!v && v.length >= 4);
  }

  status(): Record<SecretName, { set: boolean; source: "env" | "file" | null; envVar: string }> {
    const out = {} as Record<SecretName, { set: boolean; source: "env" | "file" | null; envVar: string }>;
    for (const n of SECRET_NAMES) out[n] = { set: !!this.get(n), source: this.source(n), envVar: SECRET_ENV[n] };
    return out;
  }
}
