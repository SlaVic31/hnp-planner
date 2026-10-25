import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tightenPermissions } from "./config.js";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  `CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     title TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id),
     role TEXT NOT NULL CHECK (role IN ('user','assistant')),
     content TEXT NOT NULL,
     sources_json TEXT NOT NULL DEFAULT '[]',
     meta_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   );
   CREATE INDEX messages_conv ON messages(conversation_id, created_at);
   CREATE TABLE proposals (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     hacknplan_project_id INTEGER NOT NULL,
     conversation_id TEXT,
     message_id TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('create','update')),
     work_item_id INTEGER,
     payload_json TEXT NOT NULL,
     base_json TEXT,
     display_json TEXT NOT NULL DEFAULT '{}',
     rationale TEXT NOT NULL DEFAULT '',
     payload_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','executing','succeeded','failed','rejected','stale','outcome_unknown')),
     result_json TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     decided_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX proposals_project ON proposals(project_id, created_at);
   CREATE TABLE operations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project_id TEXT,
     proposal_id TEXT,
     action TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail_json TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   );
   CREATE INDEX operations_project ON operations(project_id, id);`,
  // Zadania fikcyjnego HacknPlan w trybie demo (przechowywane lokalnie, żeby przetrwały restart).
  `CREATE TABLE demo_work_items (
     project_id INTEGER NOT NULL,
     work_item_id INTEGER NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (project_id, work_item_id)
   );`,
];

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  if (file !== ":memory:") {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        tightenPermissions(f, 0o600);
      } catch {
        /* plik może jeszcze nie istnieć */
      }
    }
  }
  return db;
}

export const now = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();

export interface OperationRow {
  id: number;
  project_id: string | null;
  proposal_id: string | null;
  action: string;
  outcome: string;
  detail_json: string;
  created_at: string;
}

export function recordOperation(
  db: Db,
  op: { projectId?: string | null; proposalId?: string | null; action: string; outcome: string; detail?: unknown },
): void {
  db.prepare(
    `INSERT INTO operations (project_id, proposal_id, action, outcome, detail_json, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(op.projectId ?? null, op.proposalId ?? null, op.action, op.outcome, JSON.stringify(op.detail ?? {}), now());
}
