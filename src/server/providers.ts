import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AppError, UpstreamError, errorMessage } from "./errors.js";
import { type ChatContext, type LlmProvider, type ModelInfo, PING_PROMPT, type PingResult, SYSTEM_PROMPT, buildContextText } from "./llm.js";

type ProviderName = "OpenAI" | "Anthropic";

function requireKey(key: string | undefined, provider: ProviderName, envVar: string): string {
  if (!key) {
    throw new AppError(`Brak klucza API ${provider}. Ustaw go w Ustawieniach lub w zmiennej ${envVar}.`, { status: 400, code: "llm_no_key", source: "llm" });
  }
  return key;
}

/** Mapuje błędy oficjalnych SDK na komunikaty z podpowiedzią. Nie zawiera treści żądania ani klucza. */
function mapSdkError(e: unknown, provider: ProviderName, what: string): AppError {
  if (e instanceof AppError) return e;
  const isConn = e instanceof Anthropic.APIConnectionError || e instanceof OpenAI.APIConnectionError;
  const isTimeout = e instanceof Anthropic.APIConnectionTimeoutError || e instanceof OpenAI.APIConnectionTimeoutError;
  if (isConn) {
    return new UpstreamError(`${provider}: ${isTimeout ? "przekroczono czas oczekiwania" : "brak połączenia"} (${what}).`, {
      source: "llm",
      definitive: false,
      hint: isTimeout ? "Zwiększ llm.timeoutMs lub spróbuj ponownie." : "Sprawdź połączenie sieciowe i adres API.",
    });
  }
  const status = e instanceof Anthropic.APIError || e instanceof OpenAI.APIError ? (e.status as number | undefined) : undefined;
  const hint =
    status === 401
      ? `Klucz API ${provider} jest nieprawidłowy lub odwołany.`
      : status === 403
        ? `Klucz API ${provider} nie ma dostępu do tego modelu lub zasobu.`
        : status === 404
          ? "Nie znaleziono modelu — pobierz listę modeli i wybierz dostępny identyfikator."
          : status === 429
            ? "Limit zapytań lub budżet konta wyczerpany — odczekaj lub sprawdź rozliczenia u dostawcy."
            : status === 400
              ? "Dostawca odrzucił parametry żądania (np. model nie obsługuje wybranej opcji)."
              : status && status >= 500
                ? "Błąd po stronie dostawcy — spróbuj ponownie później."
                : undefined;
  return new UpstreamError(`${provider} (${what}): ${status ? `HTTP ${status}: ` : ""}${errorMessage(e).slice(0, 300)}`, {
    source: "llm",
    httpStatus: status,
    definitive: status !== undefined && status < 500,
    hint,
  });
}

export interface OpenAiResponsesOptions {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  timeoutMs: number;
}

/**
 * Oficjalne OpenAI Responses API (POST /v1/responses) przez SDK `openai`, uwierzytelnienie kluczem API.
 * `store: false` — odpowiedzi nie są przechowywane po stronie OpenAI na potrzeby kontynuacji.
 * Tryb logowania kontem ChatGPT nie jest tu zaimplementowany.
 */
export class OpenAiResponsesProvider implements LlmProvider {
  readonly mode = "openai-responses" as const;
  readonly isLocal = false;
  readonly label: string;

  constructor(private readonly opts: OpenAiResponsesOptions) {
    this.label = `OpenAI API (Responses, klucz API): ${opts.model}`;
  }

  private client(): OpenAI {
    return new OpenAI({ apiKey: requireKey(this.opts.apiKey, "OpenAI", "HNP_OPENAI_API_KEY"), baseURL: this.opts.baseUrl, timeout: this.opts.timeoutMs, maxRetries: 0 });
  }

  async complete(ctx: ChatContext): Promise<string> {
    const client = this.client();
    try {
      const res = await client.responses.create({
        model: this.opts.model,
        instructions: `${SYSTEM_PROMPT}\n\n${buildContextText(ctx)}`,
        input: [...ctx.history.slice(-8).map((t) => ({ role: t.role, content: t.content })), { role: "user" as const, content: ctx.question }],
        text: { format: { type: "json_object" } },
        store: false,
      });
      if (!res.output_text?.trim()) {
        throw new UpstreamError(`OpenAI zwrócił pustą odpowiedź (status: ${res.status ?? "?"}).`, { source: "llm", definitive: true, hint: "Spróbuj ponownie lub wybierz inny model." });
      }
      return res.output_text;
    } catch (e) {
      throw mapSdkError(e, "OpenAI", "generowanie odpowiedzi");
    }
  }

  async ping(): Promise<PingResult> {
    const client = this.client();
    try {
      const res = await client.responses.create({ model: this.opts.model, input: PING_PROMPT, max_output_tokens: 256, store: false });
      const sample = (res.output_text ?? "").trim().slice(0, 40);
      return { sample, model: res.model ?? this.opts.model, note: sample ? undefined : `Połączenie działa, ale model nie zwrócił tekstu (status: ${res.status ?? "?"}).` };
    } catch (e) {
      throw mapSdkError(e, "OpenAI", "test połączenia");
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = this.client();
    try {
      const out: ModelInfo[] = [];
      for await (const m of client.models.list()) out.push({ id: m.id });
      return out.sort((a, b) => a.id.localeCompare(b.id));
    } catch (e) {
      throw mapSdkError(e, "OpenAI", "lista modeli");
    }
  }
}

export interface AnthropicOptions {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  timeoutMs: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Oficjalne Anthropic Messages API (POST /v1/messages) przez SDK `@anthropic-ai/sdk`, uwierzytelnienie kluczem API.
 * Logowanie subskrypcją Claude (Free/Pro/Max) w aplikacjach zewnętrznych nie jest dozwolone przez Anthropic.
 * Nie wysyłamy `temperature` (odrzucane przez API od 2026-10-21).
 */
export class AnthropicProvider implements LlmProvider {
  readonly mode = "anthropic" as const;
  readonly isLocal = false;
  readonly label: string;

  constructor(private readonly opts: AnthropicOptions) {
    this.label = `Anthropic Claude API (Messages, klucz API): ${opts.model}`;
  }

  private client(): Anthropic {
    return new Anthropic({ apiKey: requireKey(this.opts.apiKey, "Anthropic", "HNP_ANTHROPIC_API_KEY"), baseURL: this.opts.baseUrl, timeout: this.opts.timeoutMs, maxRetries: 0 });
  }

  private async send(params: { system?: string; messages: Anthropic.Beta.BetaMessageParam[]; max_tokens: number }): Promise<Anthropic.Beta.BetaMessage> {
    const client = this.client();
    const res = await client.beta.messages.create({
      model: this.opts.model,
      max_tokens: params.max_tokens,
      ...(params.system ? { system: params.system } : {}),
      messages: params.messages,
      ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
    });
    if (res.stop_reason === "refusal") {
      const details = (res as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
      throw new UpstreamError(`Claude odmówił odpowiedzi${details?.category ? ` (kategoria: ${details.category})` : ""}.`, {
        source: "llm",
        definitive: true,
        hint: "Przeformułuj pytanie; jeśli to fałszywy alarm, spróbuj innego modelu.",
      });
    }
    return res;
  }

  private static text(res: Anthropic.Beta.BetaMessage): string {
    return res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async complete(ctx: ChatContext): Promise<string> {
    try {
      const res = await this.send({
        system: `${SYSTEM_PROMPT}\n\n${buildContextText(ctx)}`,
        messages: [...ctx.history.slice(-8).map((t) => ({ role: t.role, content: t.content })), { role: "user", content: ctx.question }],
        max_tokens: 16000,
      });
      const text = AnthropicProvider.text(res);
      if (!text.trim()) {
        throw new UpstreamError(`Claude zwrócił pustą odpowiedź (stop_reason: ${res.stop_reason ?? "?"}).`, { source: "llm", definitive: true, hint: "Spróbuj ponownie lub zmień poziom wysiłku." });
      }
      return text;
    } catch (e) {
      throw mapSdkError(e, "Anthropic", "generowanie odpowiedzi");
    }
  }

  async ping(): Promise<PingResult> {
    try {
      const res = await this.send({ messages: [{ role: "user", content: PING_PROMPT }], max_tokens: 512 });
      const sample = AnthropicProvider.text(res).trim().slice(0, 40);
      return { sample, model: res.model, note: sample ? undefined : `Połączenie działa, ale model nie zwrócił tekstu (stop_reason: ${res.stop_reason ?? "?"}).` };
    } catch (e) {
      throw mapSdkError(e, "Anthropic", "test połączenia");
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = this.client();
    try {
      const out: ModelInfo[] = [];
      for await (const m of client.models.list()) out.push({ id: m.id, label: m.display_name });
      return out;
    } catch (e) {
      throw mapSdkError(e, "Anthropic", "lista modeli");
    }
  }
}
