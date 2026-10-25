/** Błąd z komunikatem dla użytkownika (po polsku) i wskazówką, co zrobić. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly opts: {
      status?: number;
      code?: string;
      hint?: string;
      /** Integracja, której dotyczy błąd. */
      source?: "outline" | "hacknplan" | "llm" | "app";
    } = {},
  ) {
    super(message);
    this.name = "AppError";
  }
  get status(): number {
    return this.opts.status ?? 500;
  }
  get code(): string {
    return this.opts.code ?? "error";
  }
}

/** Błąd wywołania zewnętrznej usługi. `definitive` = wiadomo, że żądanie nie zostało wykonane. */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly upstream: {
      source: "outline" | "hacknplan" | "llm";
      httpStatus?: number;
      /** true, gdy serwer jednoznacznie odrzucił żądanie (4xx) — zapis na pewno się nie wykonał. */
      definitive: boolean;
      hint?: string;
    },
  ) {
    super(message, { status: 502, code: `${upstream.source}_error`, hint: upstream.hint, source: upstream.source });
    this.name = "UpstreamError";
  }
}

let secretProvider: () => string[] = () => [];

export function setSecretProvider(fn: () => string[]): void {
  secretProvider = fn;
}

/** Usuwa znane sekrety i typowe wzorce tokenów z tekstu przeznaczonego do logów/odpowiedzi. */
export function redact(text: string): string {
  let out = text;
  for (const s of secretProvider()) out = out.split(s).join("***");
  out = out.replace(/(Bearer|ApiKey)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***");
  out = out.replace(/\b(sk|ol_api|ol)[-_][A-Za-z0-9_-]{8,}\b/g, "***");
  return out;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return redact(e.message);
  return redact(String(e));
}

export const log = {
  info(msg: string): void {
    console.log(`[hnp-planner] ${redact(msg)}`);
  },
  warn(msg: string): void {
    console.warn(`[hnp-planner] UWAGA: ${redact(msg)}`);
  },
  error(msg: string, e?: unknown): void {
    console.error(`[hnp-planner] BŁĄD: ${redact(msg)}${e ? ` — ${errorMessage(e)}` : ""}`);
  },
};
