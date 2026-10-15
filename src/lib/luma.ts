// Luma events API, called through Nango's proxy so the Luma API key lives in
// Nango (one connection per Luma calendar) instead of in this worker's env.
//
// Nango proxy contract: `{NANGO_HOST}/proxy{lumaPath}` with
//   Authorization: Bearer <NANGO_SECRET_KEY>
//   Connection-Id: <connection id>
//   Provider-Config-Key: <integration id configured in Nango>
// Nango injects `x-luma-api-key` and forwards to the provider's base URL.
//
// Luma has no separate "session" resource: a multi-session event is a set of
// individual events on one calendar (cloned, or recurring with a shared
// `series_api_id`). A session here is therefore one calendar event; pass
// `seriesId` to narrow to one multi-session event.
//
// Endpoint paths are the `/public/v1/...` ones Nango's own Luma sync template
// uses (NangoHQ/integration-templates integrations/luma), which resolve against
// the `luma` provider's base URL (https://api.lu.ma). The `luma-v2` provider
// points at https://public-api.luma.com, which uses different paths, so the
// default provider config key here is `luma`.
//
// Luma's API requires Luma Plus, and keys are scoped to a single calendar.

import { fetchWithTimeout, createLimiter } from "./httpUtil";

const NANGO_HOST = (process.env.NANGO_HOST || "https://api.nango.dev").replace(/\/+$/, "");
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;
const PROVIDER_CONFIG_KEY = process.env.NANGO_LUMA_PROVIDER_CONFIG_KEY || "luma";
const DEFAULT_CONNECTION_ID = process.env.NANGO_LUMA_CONNECTION_ID;

// Luma allows 200 requests/minute per calendar key; a small concurrency bound
// keeps a fan-out over many events' guest lists well under that.
const limitLuma = createLimiter(4);

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

async function lumaGet<T>(path: string, params: Record<string, string | undefined>, connectionId?: string): Promise<T> {
  if (!NANGO_SECRET_KEY) throw new Error("NANGO_SECRET_KEY is not set");
  const conn = connectionId || DEFAULT_CONNECTION_ID;
  if (!conn) throw new Error("No Luma connection id: pass one or set NANGO_LUMA_CONNECTION_ID");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
  const url = `${NANGO_HOST}/proxy${path}${qs.toString() ? `?${qs}` : ""}`;

  const res = await limitLuma(() =>
    fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${NANGO_SECRET_KEY}`,
          "Connection-Id": conn,
          "Provider-Config-Key": PROVIDER_CONFIG_KEY,
          Accept: "application/json",
        },
      },
      20_000
    )
  );
  if (!res.ok) throw new Error(`Luma (via Nango) ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface Paged<T> {
  entries: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function lumaGetAll<T>(path: string, params: Record<string, string | undefined>, connectionId?: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await lumaGet<Paged<T>>(
      path,
      { ...params, pagination_limit: String(PAGE_LIMIT), pagination_cursor: cursor },
      connectionId
    );
    out.push(...(res.entries || []));
    if (!res.has_more && !res.next_cursor) return out;
    if (!res.next_cursor || res.next_cursor === cursor) return out;
    cursor = res.next_cursor;
  }
  console.error(`Luma ${path}: stopped after ${MAX_PAGES} pages; results truncated`);
  return out;
}

// Raw Luma shapes (only the fields read here).
interface LumaGeoAddress {
  address?: string;
  city?: string;
  region?: string;
  country?: string;
  full_address?: string;
}

interface LumaRawEvent {
  api_id: string;
  name: string;
  description_md?: string;
  start_at: string;
  end_at: string;
  timezone: string;
  url: string;
  cover_url?: string;
  series_api_id?: string | null;
  meeting_url?: string | null;
  zoom_meeting_url?: string | null;
  geo_address_json?: LumaGeoAddress | null;
  visibility?: string;
}

interface LumaRawCalendarEntry {
  api_id: string;
  event: LumaRawEvent;
  tags?: { api_id: string; name: string }[];
}

interface LumaRawGuest {
  api_id: string;
  name: string | null;
  email: string;
  approval_status: string;
  registered_at: string | null;
  checked_in_at: string | null;
}

export interface LumaSession {
  id: string;
  name: string;
  description: string;
  startAt: string; // ISO-8601 UTC
  endAt: string; // ISO-8601 UTC
  timezone: string;
  url: string;
  coverUrl: string | null;
  seriesId: string | null;
  meetingUrl: string | null;
  location: string | null;
  visibility: string | null;
  tags: string[];
}

export interface LumaSessionGuest {
  id: string;
  name: string | null;
  email: string;
  approvalStatus: string;
  registeredAt: string | null;
  checkedInAt: string | null;
}

export interface ListSessionsOptions {
  connectionId?: string;
  after?: string; // ISO-8601; only sessions starting after this
  before?: string; // ISO-8601; only sessions starting before this
  seriesId?: string; // narrow to one multi-session/recurring event
  tag?: string; // narrow to sessions carrying this calendar tag (name or api_id)
}

function toSession(entry: LumaRawCalendarEntry): LumaSession {
  const e = entry.event;
  const geo = e.geo_address_json;
  return {
    id: e.api_id,
    name: e.name,
    description: e.description_md || "",
    startAt: new Date(e.start_at).toISOString(),
    endAt: new Date(e.end_at).toISOString(),
    timezone: e.timezone,
    url: e.url,
    coverUrl: e.cover_url || null,
    seriesId: e.series_api_id || null,
    meetingUrl: e.meeting_url || e.zoom_meeting_url || null,
    location: geo ? geo.full_address || geo.address || [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || null : null,
    visibility: e.visibility || null,
    tags: (entry.tags || []).map((t) => t.name),
  };
}

export async function listSessions(opts: ListSessionsOptions = {}): Promise<LumaSession[]> {
  const entries = await lumaGetAll<LumaRawCalendarEntry>(
    "/public/v1/calendar/list-events",
    { after: opts.after, before: opts.before },
    opts.connectionId
  );
  return entries
    .filter((en) => !opts.seriesId || en.event.series_api_id === opts.seriesId)
    .filter((en) => !opts.tag || (en.tags || []).some((t) => t.name === opts.tag || t.api_id === opts.tag))
    .map(toSession)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

export async function getSession(eventId: string, connectionId?: string): Promise<LumaSession> {
  const res = await lumaGet<LumaRawCalendarEntry>("/public/v1/event/get", { api_id: eventId }, connectionId);
  return toSession(res);
}

export async function listSessionGuests(eventId: string, connectionId?: string): Promise<LumaSessionGuest[]> {
  const entries = await lumaGetAll<{ api_id: string; guest: LumaRawGuest }>(
    "/public/v1/event/get-guests",
    { event_api_id: eventId },
    connectionId
  );
  return entries.map(({ guest: g }) => ({
    id: g.api_id,
    name: g.name,
    email: g.email,
    approvalStatus: g.approval_status,
    registeredAt: g.registered_at,
    checkedInAt: g.checked_in_at,
  }));
}
