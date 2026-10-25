import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoConfig } from "../src/server/config.js";
import { type Harness, startHarness } from "./harness.js";

interface Prop {
  id: string;
  status: string;
  payloadHash: string;
  kind: string;
}
interface Chat {
  conversationId: string;
  assistant: { content: string; sources: { title: string; url: string }[]; meta: { modes?: Record<string, string> }; proposals: Prop[] };
}

let app: Harness;
beforeEach(async () => {
  app = await startHarness({ config: demoConfig(), demo: true });
});
afterEach(async () => app.stop());

describe("tryb demo (bez sieci i bez poświadczeń)", () => {
  it("jest wyraźnie oznaczony i nie korzysta z prawdziwych usług", async () => {
    const s = await app.get<{ demo: boolean; modes: Record<string, string> }>("/api/session");
    expect(s.body.demo).toBe(true);
    expect(s.body.modes).toEqual({ outline: "demo", hacknplan: "demo", llm: "demo" });
    const r = await app.post<Chat>("/api/projects/latarnik/chat", { message: "Co mówi dokumentacja o sztormie i oleju?" });
    expect(r.body.assistant.meta.modes).toEqual({ outline: "demo", hacknplan: "demo", llm: "demo" });
    expect(r.body.assistant.sources.every((x) => x.url.includes(".invalid"))).toBe(true);
    // Dokument z kolekcji spoza projektu (col-hr) nie jest używany.
    expect(r.body.assistant.sources.some((x) => x.title.includes("Wynagrodzenia"))).toBe(false);
  });

  it("pełny przepływ: propozycja → zatwierdzenie → zadanie widoczne na liście; ponowne zatwierdzenie odrzucone", async () => {
    const r = await app.post<Chat>("/api/projects/latarnik/chat", { message: "Dodaj zadanie na ostrzeżenie o niskim poziomie oleju" });
    const p = r.body.assistant.proposals[0]!;
    expect(p.status).toBe("pending");
    const ok = await app.post<Prop & { result: { workItemId: number } }>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(ok.body.status).toBe("succeeded");
    const again = await app.post(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(again.status).toBe(409);
    const tasks = await app.get<{ items: { workItemId: number; title: string }[] }>("/api/projects/latarnik/tasks");
    expect(tasks.body.items.filter((t) => t.title === "Ostrzeżenie o niskim poziomie oleju")).toHaveLength(1);
  });

  it("symulowana zmiana zadania powoduje odrzucenie nieaktualnej edycji", async () => {
    const r = await app.post<Chat>("/api/projects/latarnik/chat", { message: "Zmień #103 — przenieś do etapu W toku" });
    const p = r.body.assistant.proposals[0]!;
    expect(p.kind).toBe("update");
    await new Promise((x) => setTimeout(x, 5));
    expect((await app.post("/api/demo/projects/latarnik/tasks/103/simulate-change", {})).status).toBe(200);
    const res = await app.post<Prop>(`/api/proposals/${p.id}/approve`, { payloadHash: p.payloadHash });
    expect(res.body.status).toBe("stale");
  });

  it("w trybie --demo nie da się przełączyć na prawdziwe usługi", async () => {
    const cfg = { ...demoConfig(), hacknplan: { ...demoConfig().hacknplan, mode: "api" } };
    const r = await fetch(`${app.base}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: app.base, "X-CSRF-Token": app.ctx.csrfToken },
      body: JSON.stringify({ config: cfg }),
    });
    expect(r.status).toBe(400);
  });
});
