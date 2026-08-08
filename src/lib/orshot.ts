// Orshot REST client. CONFIRMED live (2026-08-06) against the real API and
// Orshot's own docs (orshot.com/docs/api-reference/render-from-studio-
// template) after a real, costly debugging cycle: `includePages` MUST live
// INSIDE the `response` object, never top-level — a top-level placement is
// silently ignored and renders every page of the template (confirmed 3x on
// a real 44-page template before finding the fix). Do not "simplify" this
// back to a flat body; it looks more natural but is wrong.

const BASE = "https://api.orshot.com/v1";

function apiKey(): string {
  const key = process.env.ORSHOT_API_KEY;
  if (!key) throw new Error("ORSHOT_API_KEY is not set");
  return key;
}

export interface RenderResult {
  url: string;
}

export async function renderStudioPage(
  templateId: number,
  page: number,
  modifications: Record<string, string>
): Promise<RenderResult> {
  const res = await fetch(`${BASE}/studio/render`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId,
      modifications,
      response: { type: "url", format: "jpg", includePages: [page] },
    }),
  });
  if (!res.ok) throw new Error(`Orshot render -> ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { data?: { content?: string } | Array<{ content?: string }> };
  // Multi-page templates return data as an array (one entry per included
  // page); single-page templates return a bare object. Handle both.
  const entry = Array.isArray(json.data) ? json.data[0] : json.data;
  const url = entry?.content;
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    throw new Error(`Orshot render returned no usable URL: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { url };
}
