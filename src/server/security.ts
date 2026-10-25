import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Dodatkowe źródła przeglądarki (np. port opublikowany przez Dockera na hoście).
 * Dopuszczamy wyłącznie http na adresach pętli zwrotnej — publikacja w sieci LAN jest odrzucana.
 */
export function parsePublicOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        throw new Error(`HNP_PUBLIC_ORIGINS: nieprawidłowy adres „${s}”`);
      }
      const host = u.hostname.replace(/^\[|\]$/g, "");
      if (u.protocol !== "http:" || !(host === "localhost" || host === "::1" || /^127\./.test(host)) || !u.port || u.pathname !== "/" || u.search) {
        throw new Error(`HNP_PUBLIC_ORIGINS: dozwolone są tylko źródła http://127.0.0.1:<port> lub http://localhost:<port> (otrzymano „${s}”)`);
      }
      return u.origin;
    });
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const deny = (res: Response, status: number, message: string, code: string) =>
  res.status(status).json({ error: { message, code, source: "app" } });

/**
 * Ochrona lokalnego API:
 * - Host musi wskazywać pętlę zwrotną na naszym porcie (ochrona przed DNS rebinding),
 * - żądania zmieniające stan wymagają: zgodnego Origin (lub braku nagłówka w kliencie nieprzeglądarkowym),
 *   Sec-Fetch-Site same-origin (jeśli przesłany), Content-Type: application/json i nagłówka X-CSRF-Token,
 * - brak nagłówków CORS — inne strony nie mogą czytać odpowiedzi.
 */
export function securityMiddleware(getPort: () => number, csrfToken: string, publicOrigins: string[] = []) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const port = getPort();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...publicOrigins.map((o) => new URL(o).host)]);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...publicOrigins]);

    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    const host = req.headers.host ?? "";
    if (!allowedHosts.has(host)) {
      deny(res, 421, "Nieprawidłowy nagłówek Host — aplikacja odpowiada tylko na 127.0.0.1/localhost.", "bad_host");
      return;
    }
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");

    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD") {
      next();
      return;
    }
    if (method === "OPTIONS") {
      // Nie obsługujemy CORS: preflight z obcych źródeł kończy się odmową.
      deny(res, 403, "Żądania międzydomenowe są zablokowane.", "cors_denied");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      deny(res, 403, "Odrzucono żądanie z innego źródła (Origin).", "bad_origin");
      return;
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      deny(res, 403, "Odrzucono żądanie z innej witryny (Sec-Fetch-Site).", "bad_fetch_site");
      return;
    }
    const ct = String(req.headers["content-type"] ?? "");
    if (!/^application\/json\b/i.test(ct)) {
      deny(res, 415, "Wymagany Content-Type: application/json.", "bad_content_type");
      return;
    }
    const token = req.headers["x-csrf-token"];
    if (typeof token !== "string" || !safeEqual(token, csrfToken)) {
      deny(res, 403, "Brak lub nieprawidłowy token CSRF — odśwież stronę.", "bad_csrf");
      return;
    }
    next();
  };
}
