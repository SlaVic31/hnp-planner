import { createApp } from "./app.js";
import { BIND_HOST, SecretStore, ensureDataDir, loadConfig, resolveDataPaths } from "./config.js";
import { openDb } from "./db.js";
import { log } from "./errors.js";
import { parsePublicOrigins } from "./security.js";

function parseArgs(argv: string[]): { demo: boolean; port?: number; dataDir?: string } {
  const out: { demo: boolean; port?: number; dataDir?: string } = { demo: process.env.HNP_DEMO === "1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--demo") out.demo = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a?.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a?.startsWith("--data-dir=")) out.dataDir = a.slice(11);
    else if (a === "--help" || a === "-h") {
      console.log(`Użycie: node dist/server/index.js [--demo] [--port <numer>] [--data-dir <katalog>]
  --demo        tryb demonstracyjny: fikcyjne dane Outline/HacknPlan i model regułowy, bez sieci
  --port        port HTTP (domyślnie z konfiguracji, 4317); adres zawsze 127.0.0.1
  --data-dir    katalog danych (domyślnie $HNP_PLANNER_HOME lub ~/.hnp-planner)
Zmienne: HNP_PORT, HNP_PLANNER_HOME, HNP_DEMO=1, HNP_BIND_HOST (tylko w kontenerze: 0.0.0.0),
         HNP_PUBLIC_ORIGINS (np. http://127.0.0.1:4317 — port opublikowany przez Dockera)`);
      process.exit(0);
    }
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1024 || out.port > 65535)) {
    throw new Error("Nieprawidłowy port (dozwolone 1024–65535)");
  }
  return out;
}

/** Domyślnie wyłącznie 127.0.0.1; 0.0.0.0 tylko po jawnym ustawieniu (konfiguracja kontenera). */
function resolveBindHost(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v || v === BIND_HOST) return BIND_HOST;
  if (v === "0.0.0.0" || v === "::") return v;
  throw new Error(`HNP_BIND_HOST może mieć wartość 127.0.0.1, 0.0.0.0 lub :: (otrzymano „${v}”)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPort = process.env.HNP_PORT ? Number(process.env.HNP_PORT) : undefined;
  const paths = resolveDataPaths({ demo: args.demo, dir: args.dataDir });
  for (const w of ensureDataDir(paths)) log.warn(w);
  const config = loadConfig(paths, { demo: args.demo });
  const secrets = new SecretStore(paths);
  const db = openDb(paths.dbFile);
  const port = args.port ?? envPort ?? config.port;
  const bindHost = resolveBindHost(process.env.HNP_BIND_HOST);
  const publicOrigins = parsePublicOrigins(process.env.HNP_PUBLIC_ORIGINS);

  const ctx = createApp({ db, config, paths, secrets, demo: args.demo, port, publicOrigins });
  const server = ctx.app.listen(port, bindHost, () => {
    const m = ctx.state.integrations;
    if (bindHost === BIND_HOST) log.info(`Działa: http://${BIND_HOST}:${port}/  (nasłuch wyłącznie na ${BIND_HOST})`);
    else log.warn(`Nasłuch na ${bindHost}:${port} (HNP_BIND_HOST) — przeznaczone wyłącznie dla kontenera z portem opublikowanym na 127.0.0.1 hosta.`);
    if (publicOrigins.length) log.info(`Dodatkowe dozwolone źródła przeglądarki: ${publicOrigins.join(", ")}`);
    log.info(`Tryb: ${args.demo ? "DEMO (dane fikcyjne)" : "normalny"} | Outline: ${m.outline.mode} | HacknPlan: ${m.hacknplan.mode} | Model: ${m.llm.mode} (${m.llm.label})`);
    log.info(`Dane: ${paths.dir}`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    log.error(e.code === "EADDRINUSE" ? `Port ${port} jest zajęty — użyj --port <inny>` : "Nie można uruchomić serwera", e);
    process.exit(1);
  });

  const shutdown = () => {
    log.info("Zamykanie…");
    server.close();
    void ctx.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("Uruchomienie nie powiodło się", e);
  process.exit(1);
});
