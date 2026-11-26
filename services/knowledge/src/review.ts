const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The owner's messages are read in Korean or English; what is stored is English (owner decision 2026-11-26).
const PLANS = /내일|할\s*예정|해야|하려고|할\s*거|아직|(?:안|못)\s*(?:했|들었|갔|봤|읽었|풀었|걸었|끝냈|완료|마쳤)|not yet|tomorrow|going to|gonna|plan(?:ning)? to|need to|have to|\bwill\b|didn'?t|haven'?t|couldn'?t/i;
const COMPLETED = /(?:(공부|운동|연습|독서|요리|정리|청소|작성|복습|읽기)(?:를)?\s*했(?:어요|어|다|습니다)|(?:다\s*)?(?:끝냈|마쳤|완료했|읽었|들었|걸었|풀었|봤|했)(?:어요|어|다|습니다))$/u;
const KINDS = [
  ['study', /공부|복습|연습문제|study|studied|review(?:ed)?|practi[cs]e|[A-Z]{2,5}\d{3}[A-Z]?\b/i],
  ['class', /강의|수업|lecture|class/i],
  ['assignment', /과제|숙제|assignment|homework/i],
  ['exercise', /운동|헬스|달리기|산책|헬스장|workout|worked out|exercise|gym|\bran\b|running|\bwalk/i],
  ['reading', /독서|읽기|책|reading|book/i],
  ['coding', /코딩|프로그래밍|coding|programming/i],
  ['chore', /빨래|청소|설거지|요리|laundry|cleaning|cleaned|cooking|cooked|dishes/i],
  ['work', /업무|근무|work shift/i],
] as const;
// "1시간 반", "2 hours 15 min", "1.5 hours", "45분", "45 mins"; "an hour", "half an hour" (HALF_HOUR, AN_HOUR).
const DURATION = /(\d{1,2}(?:\.\d{1,2})?)\s*(?:시간|hours?|hrs?|h\b)(?:\s*(?:and\s+)?(?:(\d{1,2})\s*(?:분|min(?:ute)?s?)|(반|a half)))?|(\d{1,4})\s*(?:분|min(?:ute)?s?\b)/i;
const HALF_HOUR = /\bhalf an hour\b/i;
const AN_HOUR = /\b(?:an|one) hour(?: and a half)?\b/i;
const ENGLISH_DONE = /^(?:I\s+)?(?:finished|studied|completed|read|did|reviewed|practi[cs]ed|worked on|worked out|watched|attended|wrote|solved|went to|ran|walked|cleaned|cooked)\s+/i;
// Stored activity titles are English. Common Korean words of a report become English; anything else in Korean
// makes the title fall back to "<course code> <kind>" (the owner's own words stay in the linked original).
const KO_EN: Array<[RegExp, string]> = [
  [/(\d+)\s*장/g, 'chapter $1'], [/(\d+)\s*(?:문제|개)/g, '$1 problems'], [/(\d+)\s*(?:쪽|페이지)/g, '$1 pages'],
  [/연습\s*문제/g, 'practice problems'], [/기출\s*문제?/g, 'past exams'], [/모의\s*고사/g, 'mock exam'],
  [/공부/g, 'study'], [/복습/g, 'review'], [/예습/g, 'preview'], [/연습/g, 'practice'], [/강의/g, 'lecture'],
  [/수업/g, 'class'], [/튜토리얼/g, 'tutorial'], [/과제/g, 'assignment'], [/숙제/g, 'homework'], [/시험/g, 'exam'],
  [/헬스장?/g, 'gym'], [/운동/g, 'workout'], [/달리기/g, 'running'], [/산책/g, 'walk'], [/독서/g, 'reading'],
  [/읽기/g, 'reading'], [/책/g, 'book'], [/코딩/g, 'coding'], [/프로그래밍/g, 'programming'], [/빨래/g, 'laundry'],
  [/청소/g, 'cleaning'], [/설거지/g, 'dishes'], [/요리/g, 'cooking'], [/정리/g, 'tidying up'], [/작성/g, 'writing'],
  [/업무|근무/g, 'work'],
];
const KIND_TITLE: Record<string, string> = {
  study: 'study', class: 'class', assignment: 'assignment', exercise: 'workout', reading: 'reading',
  coding: 'coding', chore: 'chores', work: 'work', other: 'activity',
};

/** English title for a reported activity (stored text is English); English input is kept as it is. */
export function englishTitle(title: string, kind: string): string {
  const label = KIND_TITLE[kind] ?? 'activity';
  const only = /^[A-Z]{2,5}\d{3}[A-Z]?\d?$/i.exec(title.trim());
  if (only) return `${only[0].toUpperCase()} ${label}`;   // "studied CSC207" -> "CSC207 study"
  if (!/[가-힣]/.test(title)) return title;
  let out = title;
  for (const [ko, en] of KO_EN) out = out.replace(ko, ` ${en} `);
  out = out.replace(/(?<=[a-z0-9 ])(?:을|를|은|는|이|가|도|만)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[가-힣]/.test(out) && /[a-z]/i.test(out)) return out;
  const code = /\b[A-Z]{2,5}\d{3}[A-Z]?\d?\b/i.exec(title)?.[0]?.toUpperCase();
  return code ? `${code} ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}

export type ReviewPeriod = { from: string; to: string };
/** title: stored (English); spoken: the title in the owner's words, to match an activity Kelly already recorded. */
export type ActivityEntry = { type: 'activity'; at: string; title: string; spoken: string; minutes?: number; kind: (typeof KINDS)[number][0] | 'other'; page?: string };
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
    let atShift = 0;
    const fact = /^(?:사실|fact|기억해|remember)\s*(?:\[([^\]\r\n]{1,120})\])?\s*:\s*(.{1,1000})$/iu.exec(line);
    if (fact) {
      entries.push({ type: 'fact', at: day, page: fact[1]?.trim() || 'me', text: fact[2].trim() });
      continue;
    }
    const explicit = /^(?:활동|activity)\s*:\s*/iu.test(line);
    line = line.replace(/^(?:활동|activity)\s*:\s*/iu, '');
    if (PLANS.test(line) || /[?？]$/.test(line)) continue;
    const dayWord = /^(오늘|어제|today|yesterday|last night)\s*,?\s+/iu.exec(line);
    const at = dayWord && /어제|yesterday|last night/i.test(dayWord[1]) ? shiftDay(day, -1) : day;
    if (dayWord) line = line.slice(dayWord[0].length);
    // "I studied CSC207 for 45 minutes yesterday": the day word at the end.
    line = line.replace(/[.!。]+$/u, '').replace(/\s*,?\s*\b(?:today|yesterday|last night)$/i, (m) => {
      if (!dayWord && /yesterday|last night/i.test(m)) atShift = -1;
      return '';
    });
    line = line.replace(/[.!。]+$/u, '').trim();
    const completion = COMPLETED.exec(line);
    const kind = KINDS.find(([, pattern]) => pattern.test(line))?.[0] ?? 'other';
    const englishDone = ENGLISH_DONE.exec(line);
    if (!explicit && ((!completion && !englishDone) || kind === 'other')) continue;
    if (completion) line = line.slice(0, completion.index) + (completion[1] ?? '');
    // "worked out", "ran", "walked" carry the activity in the verb: keep a noun for the title.
    const verbTitle = englishDone && /worked out|ran|walked|cleaned|cooked/i.test(englishDone[0]) ? KIND_TITLE[kind] : '';
    line = line.replace(ENGLISH_DONE, verbTitle ? verbTitle + ' ' : '').trim();
    const duration = DURATION.exec(line);
    let counted = duration ? Math.round(Number(duration[1] ?? 0) * 60) + Number(duration[2] ?? duration[4] ?? (duration[3] ? 30 : 0)) : 0;
    if (!duration && HALF_HOUR.test(line)) counted = 30;
    else if (!duration && AN_HOUR.test(line)) counted = /a half/i.test(AN_HOUR.exec(line)![0]) ? 90 : 60;
    const spoken = line.replace(DURATION, '').replace(HALF_HOUR, '').replace(AN_HOUR, '')
      .replace(/\b(?:for|about)\s*$/i, '').replace(/\s+(?:for|about)\s+(?=\S)/i, ' ').replace(/\s+/g, ' ').trim() || completion?.[1];
    if (!spoken || !normalizedActivity(spoken) || spoken.length > 200 || counted > 1440) continue;
    const page = /\b[A-Z]{2,5}\d{3}[A-Z]?\b/i.exec(spoken)?.[0];
    const title = englishTitle(spoken, kind);
    entries.push({
      type: 'activity', at: atShift ? shiftDay(at, atShift) : at, title, spoken, kind,
      ...(counted ? { minutes: counted } : {}), ...(page ? { page } : {}),
    });
  }
  return entries;
}
