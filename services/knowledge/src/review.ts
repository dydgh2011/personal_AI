const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLANS = /내일|할\s*예정|해야|하려고|할\s*거|아직|(?:안|못)\s*(?:했|들었|갔|봤|읽었|풀었|걸었|끝냈|완료|마쳤)|not yet|tomorrow|going to|plan to/i;
const COMPLETED = /(?:(공부|운동|연습|독서|요리|정리|청소|작성|복습|읽기)(?:를)?\s*했(?:어요|어|다|습니다)|(?:다\s*)?(?:끝냈|마쳤|완료했|읽었|들었|걸었|풀었|봤|했)(?:어요|어|다|습니다))$/u;
const KINDS = [
  ['study', /공부|복습|연습문제|study|practice|[A-Z]{2,5}\d{3}[A-Z]?\b/i],
  ['class', /강의|수업|lecture|class/i],
  ['assignment', /과제|숙제|assignment|homework/i],
  ['exercise', /운동|헬스|달리기|산책|헬스장|workout|exercise|gym/i],
  ['reading', /독서|읽기|책|reading|book/i],
  ['coding', /코딩|프로그래밍|coding|programming/i],
  ['chore', /빨래|청소|설거지|요리|laundry|cleaning|cooking/i],
  ['work', /업무|근무|work shift/i],
] as const;
const DURATION = /(\d{1,2})\s*(?:시간|hours?|hrs?)(?:\s*(?:(\d{1,2})\s*(?:분|min(?:utes?)?)|(반)))?|(\d{1,4})\s*(?:분|min(?:utes?)?)/i;

export type ReviewPeriod = { from: string; to: string };
export type ActivityEntry = { type: 'activity'; at: string; title: string; minutes?: number; kind: (typeof KINDS)[number][0] | 'other'; page?: string };
export type FactEntry = { type: 'fact'; at: string; page: string; text: string };

export function isDay(value: string): boolean {
  const date = new Date(value + 'T00:00:00Z');
  return DATE.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + delta * DAY_MS).toISOString().slice(0, 10);
}

export function closedDay(now: Date, timeZone: string, at: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return shiftDay(day, time >= at ? -1 : -2);
}

/** Finds local midnight even on a 23- or 25-hour day. */
export function utcDayStart(day: string, timeZone: string): string {
  const utc = Date.parse(day + 'T00:00:00Z');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let lo = utc - 2 * DAY_MS;
  let hi = utc + 2 * DAY_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (date.format(mid) < day) lo = mid;
    else hi = mid;
  }
  return new Date(hi).toISOString();
}

export function lastClosedWeek(day: string): ReviewPeriod {
  const lastSunday = shiftDay(day, -new Date(day + 'T00:00:00Z').getUTCDay());
  return { from: shiftDay(lastSunday, -6), to: lastSunday };
}

export function normalizedActivity(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function reportedEntries(source: string, text: string, day: string): Array<ActivityEntry | FactEntry> {
  if (source === 'chat') {
    if (!text.startsWith('owner: ')) return [];
    // Existing Kelly turns mark owner and assistant separately. Only the first message is evidence.
    text = text.slice(7).split(/\r?\n\r?\nkelly:\s/, 1)[0];
    // The gateway may inline an attachment or a quoted reply in the user-facing prompt.
    if (/\[(?:the user sent|user sent|attached|image analysis|replying to)\b|saved at:\s+\/opt\/data\/cache\//iu.test(text)) return [];
  } else if (source !== 'note') {
    return [];
  }
  const entries: Array<ActivityEntry | FactEntry> = [];
  let fenced = false;
  for (const rawLine of text.trim().split(/\r?\n/).slice(0, 50)) {
    let line = rawLine.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.length > 1050 || /^[>"“]/.test(line)) continue;
    const fact = /^(?:사실|fact|기억해)\s*(?:\[([^\]\r\n]{1,120})\])?\s*:\s*(.{1,1000})$/iu.exec(line);
    if (fact) {
      entries.push({ type: 'fact', at: day, page: fact[1]?.trim() || 'me', text: fact[2].trim() });
      continue;
    }
    const explicit = /^(?:활동|activity)\s*:\s*/iu.test(line);
    line = line.replace(/^(?:활동|activity)\s*:\s*/iu, '');
    if (PLANS.test(line) || /[?？]$/.test(line)) continue;
    const dayWord = /^(오늘|어제|today|yesterday)\s+/iu.exec(line);
    const at = dayWord && /어제|yesterday/i.test(dayWord[1]) ? shiftDay(day, -1) : day;
    if (dayWord) line = line.slice(dayWord[0].length);
    line = line.replace(/[.!。]+$/u, '').trim();
    const completion = COMPLETED.exec(line);
    const kind = KINDS.find(([, pattern]) => pattern.test(line))?.[0] ?? 'other';
    const english = /^(?:I\s+)?(?:finished|studied|completed|read|did)\s+/i;
    if (!explicit && ((!completion && !english.test(line)) || kind === 'other')) continue;
    if (completion) line = line.slice(0, completion.index) + (completion[1] ?? '');
    line = line.replace(english, '').trim();
    const duration = DURATION.exec(line);
    const counted = duration ? Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? duration[4] ?? (duration[3] ? 30 : 0)) : 0;
    const title = line.replace(DURATION, '').replace(/\s+/g, ' ').trim() || completion?.[1];
    if (!title || !normalizedActivity(title) || title.length > 200 || counted > 1440) continue;
    const page = /\b[A-Z]{2,5}\d{3}[A-Z]?\b/i.exec(title)?.[0];
    entries.push({ type: 'activity', at, title, kind, ...(counted ? { minutes: counted } : {}), ...(page ? { page } : {}) });
  }
  return entries;
}
