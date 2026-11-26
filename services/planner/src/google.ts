// Google OAuth (installed-app flow with PKCE, loopback redirect) and the Calendar API calls
// the planner needs. Plain fetch, no SDK. Tokens never leave this module except into the DB.

import { createHash, randomBytes } from 'node:crypto';

/**
 * Least privilege: write only to calendars the planner created (calendar.app.created), read the
 * calendar list and events of the owner's other calendars (for the one-time import), nothing else.
 * The planner can never change or delete the owner's existing calendars or their events.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Only these hosts are ever contacted, whatever the client file says. */
const TOKEN_URI_PATTERN = /^https:\/\/(?:oauth2\.googleapis\.com\/token|accounts\.google\.com\/o\/oauth2\/token)$/;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
}

/** Parses the "Desktop app" client JSON downloaded from Google Cloud Console. */
export function parseClientFile(text: string): OAuthClient {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The Google OAuth client file is not valid JSON');
  }
  const installed = (data as { installed?: Record<string, unknown> }).installed;
  if (!installed) throw new Error('The Google OAuth client file must be for a "Desktop app" client (top-level key "installed")');
  const clientId = installed.client_id;
  const clientSecret = installed.client_secret;
  const tokenUri = installed.token_uri ?? 'https://oauth2.googleapis.com/token';
  if (typeof clientId !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('client_id in the Google OAuth client file is missing or invalid');
  }
  if (typeof clientSecret !== 'string' || clientSecret.length < 10) throw new Error('client_secret is missing');
  if (typeof tokenUri !== 'string' || !TOKEN_URI_PATTERN.test(tokenUri)) throw new Error('token_uri must be Google\'s token endpoint');
  return { clientId, clientSecret, tokenUri };
}

export interface PendingAuth {
  state: string;
  verifier: string;
  url: string;
}

export function buildAuthRequest(client: OAuthClient, redirectUri: string): PendingAuth {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { state, verifier, url: `${AUTH_ENDPOINT}?${params}` };
}

export interface TokenSet {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  refreshToken: string | null;
  scope: string | null;
}

export type Fetch = typeof fetch;

export class GoogleError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** invalid_grant: the refresh token was revoked or expired; the owner must connect again. */
    readonly reconnect = false,
  ) {
    super(message);
  }
}

async function tokenRequest(client: OAuthClient, form: Record<string, string>, f: Fetch, now: () => number): Promise<TokenSet> {
  const res = await f(client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...form }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
    throw new GoogleError(res.status, `Google token request failed: ${code}`, code === 'invalid_grant');
  }
  if (typeof data.access_token !== 'string') throw new GoogleError(502, 'Google returned no access token');
  return {
    accessToken: data.access_token,
    expiresAt: now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
  };
}

export function exchangeCode(client: OAuthClient, code: string, verifier: string, redirectUri: string, f: Fetch = fetch, now = Date.now) {
  return tokenRequest(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, f, now);
}

export function refreshAccess(client: OAuthClient, refreshToken: string, f: Fetch = fetch, now = Date.now) {
  return tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken }, f, now);
}

// ---- Calendar ---------------------------------------------------------------------------

/**
 * Event categories and their Google event colours (colorId). One managed calendar holds every
 * event; the colour says what kind it is. The mapping lives only here.
 */
export const CATEGORIES = ['class', 'study', 'task', 'deadline', 'routine', 'personal', 'birthday'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_COLOR: Record<Category, string> = {
  class: '9', // Blueberry: classes, lectures, school fixed times
  study: '7', // Peacock: planned study / assignment time
  task: '5', // Banana: planned general work
  deadline: '11', // Tomato: all-day deadline markers
  routine: '2', // Sage: exercise, meals, routines
  personal: '3', // Grape: appointments, plans with people
  birthday: '4', // Flamingo: birthdays, anniversaries
};
export const CATEGORY_LABEL: Record<Category, string> = {
  class: '수업',
  study: '공부',
  task: '할 일',
  deadline: '마감',
  routine: '루틴',
  personal: '개인',
  birthday: '생일·기념일',
};
const COLOR_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_COLOR).map(([k, v]) => [v, k])) as Record<string, Category>;

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

export interface CalendarEvent {
  id: string;
  status: string;
  summary: string;
  /** RFC 3339 for timed events; null for all-day events. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  /** First day of an all-day event (YYYY-MM-DD). */
  date: string | null;
  /** Day after the last day of an all-day event (Google's exclusive end). */
  endDate: string | null;
  location: string | null;
  description: string | null;
  transparent: boolean;
  declined: boolean;
  category: Category | null;
  /** Recurring series master (singleEvents=false listings). */
  recurrence: string[] | null;
  /** Instance of a recurring series: the series id. */
  recurringEventId: string | null;
  /** Block id when the planner created the event for a plan block. */
  plannerBlockId: string | null;
  /** Todo id when the event is a deadline marker. */
  deadlineTodoId: string | null;
  /** Exam event id when the event is an all-day exam marker. */
  examSourceId: string | null;
  /** Source event id when it was imported from another calendar. */
  importedFrom: string | null;
}

export type Timing =
  | { kind: 'timed'; date: string; start: string; end: string; endDate?: string }
  | { kind: 'allDay'; date: string; endDate: string };

export interface EventInput {
  /** Optional stable id for retryable inserts (not included in patches). */
  id?: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  category: Category;
  timing: Timing;
  /** RRULE / EXDATE lines. Omitted: unchanged on patch, none on insert. */
  recurrence?: string[] | null;
  blockId?: string;
  deadlineTodoId?: string;
  examSourceId?: string;
  importedFrom?: string;
  /** Google pop-up reminders: off for planner blocks (Discord reminds), Google's default otherwise. */
  googleReminders?: boolean;
}

/** One calendar (the planner's managed calendar). */
export interface CalendarApi {
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  /** null when the event no longer exists. */
  getEvent(id: string): Promise<CalendarEvent | null>;
  insertEvent(input: EventInput): Promise<string>;
  patchEvent(id: string, input: EventInput): Promise<void>;
  deleteEvent(id: string): Promise<void>;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

/** The account: its calendar list (read-only), calendars the planner created, other calendars read-only. */
export interface GoogleAccount {
  calendarList(): Promise<CalendarListEntry[]>;
  createCalendar(summary: string, description: string): Promise<string>;
  calendar(id: string): CalendarApi;
  /** Events of another calendar as series (recurring masters + single events), read-only. */
  listSeries(calendarId: string, timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
}

const API = 'https://www.googleapis.com/calendar/v3';

export function googleAccount(getToken: () => Promise<string>, timeZone: string, f: Fetch = fetch): GoogleAccount {
  const call = async (method: string, url: string, body?: unknown): Promise<unknown> => {
    const token = await getToken();
    const res = await f(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 204) return null;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const message = (data?.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      // Deleting an event the owner already deleted is fine.
      if (method === 'DELETE' && (res.status === 404 || res.status === 410)) return null;
      throw new GoogleError(res.status, `Google Calendar ${method} failed: ${message}`);
    }
    return data;
  };

  const list = async (calendarId: string, params: Record<string, string>): Promise<CalendarEvent[]> => {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ maxResults: '250', timeZone, ...params, ...(pageToken ? { pageToken } : {}) });
      const data = (await call('GET', `${API}/calendars/${encodeURIComponent(calendarId)}/events?${query}`)) as { items?: unknown[]; nextPageToken?: string };
      for (const item of data.items ?? []) events.push(toEvent(item as Record<string, any>));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return events;
  };

  const eventBody = (e: EventInput) => {
    const body: Record<string, unknown> = {
      summary: e.summary,
      description: e.description ?? '',
      location: e.location ?? '',
      colorId: CATEGORY_COLOR[e.category],
      extendedProperties: {
        private: {
          personalAiPlanner: '1',
          personalAiCategory: e.category,
          ...(e.blockId ? { personalAiBlockId: e.blockId } : {}),
          ...(e.deadlineTodoId ? { personalAiDeadlineTodoId: e.deadlineTodoId } : {}),
          ...(e.examSourceId ? { personalAiExamSourceId: e.examSourceId } : {}),
          ...(e.importedFrom ? { personalAiImportedFrom: e.importedFrom } : {}),
        },
      },
      reminders: e.googleReminders ? { useDefault: true } : { useDefault: false, overrides: [] },
    };
    if (e.timing.kind === 'timed') {
      const t = e.timing;
      const at = (time: string) => (time === '24:00' ? '23:59' : time);
      body.start = { dateTime: `${t.date}T${at(t.start)}:00`, timeZone };
      body.end = { dateTime: `${t.endDate ?? t.date}T${at(t.end)}:00`, timeZone };
    } else {
      body.start = { date: e.timing.date };
      body.end = { date: e.timing.endDate };
    }
    if (e.recurrence !== undefined) body.recurrence = e.recurrence ?? [];
    return body;
  };

  return {
    async calendarList() {
      const out: CalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) });
        const data = (await call('GET', `${API}/users/me/calendarList?${query}`)) as { items?: Array<Record<string, any>>; nextPageToken?: string };
        for (const c of data.items ?? []) {
          out.push({ id: String(c.id), summary: String(c.summaryOverride ?? c.summary ?? c.id), primary: c.primary === true, accessRole: String(c.accessRole ?? '') });
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return out;
    },
    async createCalendar(summary, description) {
      const data = (await call('POST', `${API}/calendars`, { summary, description, timeZone })) as { id: string };
      return data.id;
    },
    listSeries(calendarId, timeMin, timeMax) {
      return list(calendarId, { timeMin, timeMax, singleEvents: 'false', showDeleted: 'false' });
    },
    calendar(calendarId) {
      const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
      return {
        listEvents: (timeMin, timeMax) => list(calendarId, { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime' }),
        async getEvent(id) {
          try {
            return toEvent((await call('GET', `${base}/${encodeURIComponent(id)}?timeZone=${encodeURIComponent(timeZone)}`)) as Record<string, any>);
          } catch (error) {
            if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return null;
            throw error;
          }
        },
        async insertEvent(input) {
          return ((await call('POST', base, { ...eventBody(input), ...(input.id ? { id: input.id } : {}) })) as { id: string }).id;
        },
        async patchEvent(id, input) {
          await call('PATCH', `${base}/${encodeURIComponent(id)}`, eventBody(input));
        },
        async deleteEvent(id) {
          await call('DELETE', `${base}/${encodeURIComponent(id)}`);
        },
      };
    },
  };
}

export function toEvent(item: Record<string, any>): CalendarEvent {
  const allDay = !item.start?.dateTime;
  const self = Array.isArray(item.attendees) ? item.attendees.find((a: any) => a?.self) : null;
  const priv = item.extendedProperties?.private ?? {};
  const category = isCategory(priv.personalAiCategory) ? priv.personalAiCategory : (COLOR_CATEGORY[String(item.colorId ?? '')] ?? null);
  return {
    id: String(item.id),
    status: String(item.status ?? 'confirmed'),
    summary: typeof item.summary === 'string' ? item.summary : '(제목 없음)',
    start: allDay ? null : String(item.start.dateTime),
    end: allDay ? null : String(item.end?.dateTime ?? item.start.dateTime),
    allDay,
    date: allDay ? String(item.start?.date ?? '') || null : null,
    endDate: allDay ? String(item.end?.date ?? '') || null : null,
    location: typeof item.location === 'string' && item.location ? item.location : null,
    description: typeof item.description === 'string' && item.description ? item.description : null,
    transparent: item.transparency === 'transparent',
    declined: self?.responseStatus === 'declined',
    category,
    recurrence: Array.isArray(item.recurrence) ? item.recurrence.map(String) : null,
    recurringEventId: typeof item.recurringEventId === 'string' ? item.recurringEventId : null,
    plannerBlockId: priv.personalAiBlockId ?? null,
    deadlineTodoId: priv.personalAiDeadlineTodoId ?? null,
    examSourceId: priv.personalAiExamSourceId ?? null,
    importedFrom: priv.personalAiImportedFrom ?? null,
  };
}
