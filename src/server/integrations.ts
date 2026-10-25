import type { AppConfig, SecretStore } from "./config.js";
import type { Db } from "./db.js";
import { DemoHacknPlan } from "./hacknplan/demo.js";
import { RestHacknPlan } from "./hacknplan/rest.js";
import type { HacknPlanApi } from "./hacknplan/types.js";
import { DemoProvider, OpenAiCompatibleProvider, type LlmProvider } from "./llm.js";
import { DemoOutlineSource } from "./outline/demo.js";
import { AnthropicProvider, OpenAiResponsesProvider } from "./providers.js";
import { McpOutlineSource } from "./outline/mcp.js";
import type { OutlineSource } from "./outline/types.js";

export interface Integrations {
  outline: OutlineSource;
  hacknplan: HacknPlanApi;
  llm: LlmProvider;
}

export function buildIntegrations(cfg: AppConfig, secrets: SecretStore, db: Db, overrides: Partial<Integrations> = {}): Integrations {
  return {
    outline:
      overrides.outline ??
      (cfg.outline.mode === "mcp" ? new McpOutlineSource({ url: cfg.outline.mcpUrl, token: secrets.get("outlineToken"), timeoutMs: cfg.outline.timeoutMs }) : new DemoOutlineSource()),
    hacknplan:
      overrides.hacknplan ??
      (cfg.hacknplan.mode === "api"
        ? new RestHacknPlan({ baseUrl: cfg.hacknplan.baseUrl, apiKey: secrets.get("hacknplanApiKey"), timeoutMs: cfg.hacknplan.timeoutMs })
        : new DemoHacknPlan(db)),
    llm: overrides.llm ?? buildLlm(cfg, secrets),
  };
}

export function buildLlm(cfg: AppConfig, secrets: SecretStore): LlmProvider {
  switch (cfg.llm.mode) {
    case "openai-responses":
      return new OpenAiResponsesProvider({ ...cfg.llm.openaiResponses, apiKey: secrets.get("openaiApiKey"), timeoutMs: cfg.llm.timeoutMs });
    case "anthropic":
      return new AnthropicProvider({ ...cfg.llm.anthropic, apiKey: secrets.get("anthropicApiKey"), timeoutMs: cfg.llm.timeoutMs });
    case "openai":
      return new OpenAiCompatibleProvider({
            baseUrl: cfg.llm.baseUrl,
            model: cfg.llm.model,
            apiKey: secrets.get("llmApiKey"),
            jsonMode: cfg.llm.jsonMode,
            temperature: cfg.llm.temperature,
            timeoutMs: cfg.llm.timeoutMs,
          });
    default:
      return new DemoProvider();
  }
}

export function taskUrl(cfg: AppConfig, projectId: number, workItemId: number): string {
  if (cfg.hacknplan.mode === "demo") return `https://demo.hacknplan.invalid/p/${projectId}/task/${workItemId}`;
  return cfg.hacknplan.webUrlTemplate.replaceAll("{projectId}", String(projectId)).replaceAll("{workItemId}", String(workItemId));
}
