import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ChatService } from "./chat.js";
import { type AppConfig, ConfigSchema, type DataPaths, SECRET_NAMES, type SecretName, SecretStore, formatZodError, isLocalModelUrl, saveConfig } from "./config.js";
import { type Db, type OperationRow, recordOperation } from "./db.js";
import { AppError, errorMessage, log, setSecretProvider } from "./errors.js";
import { DemoHacknPlan } from "./hacknplan/demo.js";
import { type Integrations, buildIntegrations, taskUrl } from "./integrations.js";
import { ProposalService } from "./proposals.js";
import { newCsrfToken, securityMiddleware } from "./security.js";
import { DEFAULT_DESCRIPTION_TEMPLATE, SAMPLE_PARTS, TEMPLATE_FIELDS, TemplateError, renderDescription, templateHash, validateTemplate } from "./template.js";

export interface AppOptions {
  db: Db;
  config: AppConfig;
  paths: DataPaths;
  secrets: SecretStore;
  demo: boolean;
  /** Wstrzykiwane w testach (atrapy integracji). */
  overrides?: Partial<Integrations>;
  /** Port, pod którym działa serwer (do weryfikacji Host/Origin). */
  port?: number;
  csrfToken?: string;
  staticDir?: string;
  /** Dodatkowe dozwolone źródła przeglądarki (np. port Dockera opublikowany na hoście). */
  publicOrigins?: string[];
}

export interface AppContext {
  app: express.Express;
  csrfToken: string;
  state: { config: AppConfig; integrations: Integrations; port: number };
  proposals: ProposalService;
  chat: ChatService;
  setPort(port: number): void;
  close(): Promise<void>;
}

const HashBody = z.object({ payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export function createApp(opts: AppOptions): AppContext {
  const csrfToken = opts.csrfToken ?? newCsrfToken();
  const state = {
    config: opts.config,
    integrations: buildIntegrations(opts.config, opts.secrets, opts.db, opts.overrides),
    port: opts.port ?? opts.config.port,
  };
  setSecretProvider(() => opts.secrets.values());

  const getProject = (id: string) => state.config.projects.find((p) => p.id === id);
  const urlFor = (pid: number, wid: number) => taskUrl(state.config, pid, wid);
  const proposals = new ProposalService(opts.db, { getProject, hacknplan: () => state.integrations.hacknplan, taskUrl: urlFor });
  const chat = new ChatService({
    db: opts.db,
    config: () => state.config,
    outline: () => state.integrations.outline,
    hacknplan: () => state.integrations.hacknplan,
    llm: () => state.integrations.llm,
    proposals,
    taskUrl: urlFor,
  });
  const recovered = proposals.recoverInterrupted();
  if (recovered) log.warn(`${recovered} propozycji przerwanych przy poprzednim uruchomieniu oznaczono jako „wynik nieznany”.`);

  const rebuild = async () => {
    const old = state.integrations;
    state.integrations = buildIntegrations(state.config, opts.secrets, opts.db, opts.overrides);
    await old.outline.close().catch(() => undefined);
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(securityMiddleware(() => state.port, csrfToken, opts.publicOrigins ?? []));
  app.use(express.json({ limit: "256kb", type: () => true }));

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve(fn(req, res))
        .then((v) => {
          if (!res.headersSent) res.json(v ?? { ok: true });
        })
        .catch(next);
    };
  const param = (req: Request, name: string): string => String(req.params[name] ?? "");
  const project = (req: Request) => chat.project(param(req, "pid"));
  const body = <T>(schema: z.ZodType<T>, req: Request): T => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) throw new AppError(`Nieprawidłowe dane żądania:\n${formatZodError(r.error)}`, { status: 400, code: "bad_request" });
    return r.data;
  };

  const modes = () => ({
    outline: state.integrations.outline.mode,
    hacknplan: state.integrations.hacknplan.mode,
    llm: state.integrations.llm.mode,
  });

  app.get(
    "/api/session",
    wrap(() => ({
      csrfToken,
      demo: opts.demo,
      modes: modes(),
      llm: { label: state.integrations.llm.label, isLocal: state.integrations.llm.isLocal },
      projects: state.config.projects.map((p) => ({ id: p.id, name: p.name, hacknplanProjectId: p.hacknplanProjectId, outlineCollectionIds: p.outlineCollectionIds })),
    })),
  );

  app.get(
    "/api/status",
    wrap(async () => {
      const withTimeout = <T>(p: Promise<T>, ms = 15000) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new AppError("Przekroczono czas sprawdzania połączenia")), ms))]);
      const describe = (e: unknown) => ({ ok: false, error: errorMessage(e), hint: e instanceof AppError ? e.opts.hint : undefined });
      const firstProject = state.config.projects[0];
      const [outline, hacknplan] = await Promise.all([
        withTimeout(state.integrations.outline.status()).then((s) => ({ ok: s.missingCapabilities.length === 0, ...s }), describe),
        firstProject
          ? withTimeout(state.integrations.hacknplan.getMeta(firstProject.hacknplanProjectId)).then(
              (m) => ({ ok: true, project: firstProject.hacknplanProjectId, categories: m.categories.length, boards: m.boards.length }),
              describe,
            )
          : Promise.resolve({ ok: false, error: "Brak skonfigurowanych projektów", hint: "Dodaj projekt w Ustawieniach." }),
      ]);
      const llm = state.integrations.llm;
      return {
        modes: modes(),
        outline: { mode: state.integrations.outline.mode, ...outline },
        hacknplan: { mode: state.integrations.hacknplan.mode, ...hacknplan },
        llm: {
          mode: llm.mode,
          // Ten status NIE łączy się z modelem — do weryfikacji służy POST /api/llm/test.
          ok: llm.mode === "demo" ? true : null,
          tested: false,
          label: llm.label,
          isLocal: llm.isLocal,
          note:
            (llm.mode === "demo" ? "Model demonstracyjny — odpowiedzi generowane regułami, bez AI." : llm.isLocal ? "Model lokalny — treść nie opuszcza komputera." : "Model zdalny — fragmenty dokumentów i zadań są wysyłane do dostawcy.") +
            (llm.mode === "demo" ? "" : " Połączenie z modelem nie zostało sprawdzone — użyj „Testuj połączenie z modelem”."),
        },
      };
    }),
  );

  // --- Zadania ---
  app.get(
    "/api/projects/:pid/tasks",
    wrap(async (req) => {
      const p = project(req);
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
      const { items, totalCount } = await state.integrations.hacknplan.listWorkItems(p.hacknplanProjectId, { limit: 100, searchTerms: q || undefined });
      return {
        totalCount,
        items: items.filter((t) => t.projectId === p.hacknplanProjectId).map((t) => ({ ...t, url: urlFor(p.hacknplanProjectId, t.workItemId) })),
      };
    }),
  );

  // --- Czat ---
  app.get("/api/projects/:pid/conversations", wrap((req) => chat.listConversations(project(req).id)));
  app.get(
    "/api/projects/:pid/conversations/:cid/messages",
    wrap((req) => {
      const p = project(req);
      const conv = opts.db.prepare(`SELECT project_id FROM conversations WHERE id = ?`).get(param(req, "cid")) as { project_id: string } | undefined;
      if (!conv || conv.project_id !== p.id) throw new AppError("Nie znaleziono rozmowy w tym projekcie.", { status: 404, code: "conversation_not_found" });
      return chat.messages(param(req, "cid"));
    }),
  );
  app.post(
    "/api/projects/:pid/chat",
    wrap(async (req) => {
      const b = body(z.object({ conversationId: z.string().uuid().nullable().optional(), message: z.string().max(4000) }).strict(), req);
      return chat.ask(project(req).id, b.conversationId ?? null, b.message);
    }),
  );

  // --- Propozycje (jedyna ścieżka zapisu do HacknPlan) ---
  app.get(
    "/api/projects/:pid/proposals",
    wrap((req) => proposals.list(project(req).id, { status: typeof req.query.status === "string" ? req.query.status : undefined })),
  );
  app.post(
    "/api/proposals/approve-batch",
    wrap(async (req) => {
      const b = body(z.object({ items: z.array(z.object({ id: z.string().uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(10) }).strict(), req);
      const results = await proposals.approveMany(b.items);
      return { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    }),
  );
  app.post(
    "/api/proposals/:id/approve",
    wrap(async (req) => proposals.approve(param(req, "id"), body(HashBody, req).payloadHash)),
  );
  app.post("/api/proposals/:id/reject", wrap((req) => proposals.reject(param(req, "id"), body(HashBody, req).payloadHash)));
  app.post("/api/proposals/:id/reconcile", wrap(async (req) => proposals.reconcile(param(req, "id"))));
  app.post(
    "/api/proposals/:id/requeue",
    wrap((req) => proposals.requeue(param(req, "id"), body(z.object({ confirmNotCreated: z.boolean().default(false) }).strict(), req))),
  );

  // --- Historia operacji ---
  app.get(
    "/api/projects/:pid/operations",
    wrap((req) => {
      const p = project(req);
      const rows = opts.db.prepare(`SELECT * FROM operations WHERE project_id = ? ORDER BY id DESC LIMIT 300`).all(p.id) as OperationRow[];
      return rows.map((r) => ({ id: r.id, proposalId: r.proposal_id, action: r.action, outcome: r.outcome, detail: JSON.parse(r.detail_json) as unknown, createdAt: r.created_at }));
    }),
  );

  // --- Ustawienia (sekrety nigdy nie są zwracane) ---
  app.get(
    "/api/settings",
    wrap(() => ({
      config: state.config,
      secrets: opts.secrets.status(),
      demo: opts.demo,
      paths: { dir: opts.paths.dir, config: opts.paths.configFile, secrets: opts.paths.secretsFile, db: opts.paths.dbFile },
      llmIsLocal: state.config.llm.mode === "openai" ? isLocalModelUrl(state.config.llm.baseUrl) : state.config.llm.mode === "demo",
    })),
  );
  app.put(
    "/api/settings",
    wrap(async (req) => {
      const parsed = ConfigSchema.safeParse((req.body as { config?: unknown })?.config);
      if (!parsed.success) throw new AppError(`Nieprawidłowa konfiguracja:\n${formatZodError(parsed.error)}`, { status: 400, code: "bad_config" });
      const next = parsed.data;
      if (opts.demo && (next.outline.mode !== "demo" || next.hacknplan.mode !== "demo" || next.llm.mode !== "demo")) {
        throw new AppError("Aplikacja działa w trybie demo (--demo). Uruchom ją poleceniem `npm start`, aby połączyć prawdziwe usługi.", { status: 400, code: "demo_locked" });
      }
      if (next.port !== state.config.port) log.info(`Nowy port ${next.port} zacznie obowiązywać po restarcie.`);
      saveConfig(opts.paths, next);
      state.config = next;
      await rebuild();
      recordOperation(opts.db, { action: "settings_update", outcome: "ok", detail: { modes: modes(), projects: next.projects.map((p) => p.id) } });
      return { ok: true, config: state.config };
    }),
  );
  app.put(
    "/api/secrets/:name",
    wrap(async (req) => {
      const name = param(req, "name") as SecretName;
      if (!SECRET_NAMES.includes(name)) throw new AppError("Nieznany sekret.", { status: 404, code: "unknown_secret" });
      const b = body(z.object({ value: z.string().max(4096).nullable() }).strict(), req);
      opts.secrets.set(name, b.value);
      await rebuild();
      recordOperation(opts.db, { action: "secret_update", outcome: b.value ? "set" : "cleared", detail: { name } });
      return { ok: true, secrets: opts.secrets.status() };
    }),
  );
  // --- Model: prawdziwy test połączenia i lista modeli (wyłącznie na żądanie użytkownika) ---
  app.post(
    "/api/llm/test",
    wrap(async () => {
      const llm = state.integrations.llm;
      const started = Date.now();
      try {
        const r = await llm.ping();
        recordOperation(opts.db, { action: "llm_test", outcome: "ok", detail: { mode: llm.mode, model: r.model, ms: Date.now() - started } });
        return { ok: true, mode: llm.mode, label: llm.label, isLocal: llm.isLocal, ...r, ms: Date.now() - started };
      } catch (e) {
        recordOperation(opts.db, { action: "llm_test", outcome: "error", detail: { mode: llm.mode, error: errorMessage(e) } });
        throw e;
      }
    }),
  );
  app.get("/api/llm/models", wrap(async () => ({ mode: state.integrations.llm.mode, models: await state.integrations.llm.listModels() })));

  // --- Szablon opisu zadań: pomoc i podgląd (bez zapisu) ---
  app.get(
    "/api/template/help",
    wrap(() => ({ fields: TEMPLATE_FIELDS, defaultTemplate: DEFAULT_DESCRIPTION_TEMPLATE, sample: SAMPLE_PARTS })),
  );
  app.post(
    "/api/template/preview",
    wrap((req) => {
      const b = body(z.object({ template: z.string().max(20000), projectName: z.string().max(100).optional(), title: z.string().max(200).optional() }).strict(), req);
      const error = validateTemplate(b.template);
      if (error) return { ok: false, error };
      try {
        const rendered = renderDescription(b.template, SAMPLE_PARTS, { title: b.title ?? "Ostrzeżenie o niskim poziomie oleju", project: b.projectName ?? "Projekt", date: new Date().toISOString().slice(0, 10) });
        return { ok: true, rendered, templateHash: templateHash(b.template) };
      } catch (e) {
        return { ok: false, error: e instanceof TemplateError ? e.message : errorMessage(e) };
      }
    }),
  );
  app.get("/api/outline/collections", wrap(() => state.integrations.outline.listCollections()));

  // --- Tylko demo: symulacja zmiany wprowadzonej przez kogoś innego (pokazuje wykrywanie nieaktualnej edycji) ---
  app.post(
    "/api/demo/projects/:pid/tasks/:wid/simulate-change",
    wrap((req) => {
      const hp = state.integrations.hacknplan;
      if (!(hp instanceof DemoHacknPlan)) throw new AppError("Dostępne tylko w trybie demo.", { status: 404, code: "demo_only" });
      const p = project(req);
      hp.touchForDemo(p.hacknplanProjectId, Number(param(req, "wid")), `${new Date().toLocaleTimeString("pl-PL")} — zmienione przez innego użytkownika`);
      return { ok: true };
    }),
  );

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { message: "Nieznany endpoint API.", code: "not_found", source: "app" } });
  });

  const staticDir = opts.staticDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: "index.html", dotfiles: "deny" }));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) log.error(`${err.code}: ${err.message}`);
      res.status(err.status).json({ error: { message: errorMessage(err), hint: err.opts.hint, code: err.code, source: err.opts.source ?? "app" } });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed" || e?.type === "entity.too.large") {
      res.status(e.status ?? 400).json({ error: { message: "Nieprawidłowe lub zbyt duże ciało żądania JSON.", code: "bad_json", source: "app" } });
      return;
    }
    log.error("Nieobsłużony błąd", err);
    res.status(500).json({ error: { message: "Wewnętrzny błąd aplikacji — szczegóły w terminalu.", code: "internal", source: "app" } });
  });

  return {
    app,
    csrfToken,
    state,
    proposals,
    chat,
    setPort(port: number) {
      state.port = port;
    },
    async close() {
      await state.integrations.outline.close().catch(() => undefined);
    },
  };
}
