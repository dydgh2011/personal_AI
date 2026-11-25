import {
  BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Patch, Post, Query,
} from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { IsArray, IsIn, IsString, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.js';
import { Actor, AllowBroker } from '../auth/auth.js';
import { Clock } from '../common/clock.js';
import { isCalendarDate } from '../common/dates.js';
import { conflict, parseJson, unavailable, unprocessable } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { FRESH_DAYS } from '../mastery/mastery.js';
import { addDays, buildPlan, localTime, TIME_ZONE, toMinutes, type Interval, type Period, type Window, type WorkItem } from './plan.js';

const WEEK = 7;
const DEFAULT_WINDOWS: Window[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
  weekday === 0 || weekday === 6 ? { weekday, start: '10:00', end: '13:00' } : { weekday, start: '18:00', end: '21:00' });
const START_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
type CalendarState = 'connected' | 'disconnected' | 'unconfigured' | 'unavailable';

class ScheduleInput {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  date?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['day', 'week'])
  period?: Period;
}

class AvailabilityInput {
  @IsArray()
  windows: unknown[];
}

export function validateWindows(value: unknown): Window[] {
  if (!Array.isArray(value) || value.length > WEEK) throw unprocessable('INVALID_AVAILABILITY', 'Use at most one availability window per weekday');
  const used = new Set<number>();
  return value.map((w) => {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw unprocessable('INVALID_AVAILABILITY', 'Each window needs a weekday, start and end');
    const { weekday, start, end } = w as Window;
    if (Object.keys(w).length !== 3 || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 || used.has(weekday)
      || typeof start !== 'string' || !START_TIME.test(start) || typeof end !== 'string' || !END_TIME.test(end)
      || toMinutes(start) >= toMinutes(end)) {
      throw unprocessable('INVALID_AVAILABILITY', 'Weekdays must be unique, and start must be before end (HH:MM)');
    }
    used.add(weekday);
    return { weekday, start, end };
  }).sort((a, b) => a.weekday - b.weekday);
}

interface CandidateAssignment {
  id: string;
  title: string;
  domain: string;
  goalId: string;
  constraints: string;
  priority: number;
  estimate: number | null;
  assignmentCount: number;
  fixedDeadline: string | null;
}

interface VerifiedSkill {
  id: string;
  title: string;
  level: number;
  verifiedAt: string;
  domain: string | null;
  priority: number | null;
}

interface Review extends WorkItem {
  kind: 'review';
  dueDate: string;
  verifiedDate: string;
  method: 'practice' | 'revalidate';
}

interface PlannerAvailability {
  timeZone: string;
  calendarConnected: boolean;
  reserved: Array<{ key: string; minutes: number }>;
  days: Array<{ date: string; busy: Interval[] }>;
}

function taskKey(item: Pick<WorkItem, 'kind' | 'id' | 'dueDate'>): string {
  const key = `${item.kind}:${item.id}`;
  return item.dueDate ? `${key}:${item.dueDate}` : key;
}

interface PlannerProposal {
  code: string;
  title: string;
  status: string;
}

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  availability(): { windows: Window[]; isDefault: boolean } {
    const row = this.db.prepare('SELECT windows FROM schedule_preferences WHERE id = 1').get() as { windows: string } | undefined;
    return { windows: row ? JSON.parse(row.windows) as Window[] : DEFAULT_WINDOWS, isDefault: !row };
  }

  setAvailability(value: unknown, actor: string) {
    const windows = validateWindows(value);
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO schedule_preferences (id, windows) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET windows = excluded.windows').run(JSON.stringify(windows));
      this.audit.record(actor, 'schedule.availability.update', 'schedule', 'weekly', windows);
    }).immediate();
    return this.availability();
  }

  private assignments(): WorkItem[] {
    const rows = this.db.prepare(`
      SELECT a.id, a.title, d.title AS domain, g.id AS goalId, g.constraints, d.priority,
        n.estimate_minutes AS estimate, m.fixed_deadline AS fixedDeadline,
        (SELECT COUNT(*) FROM assignments sibling WHERE sibling.milestone_id = a.milestone_id
          AND sibling.status <> 'archived') AS assignmentCount
      FROM assignments a
      JOIN milestones m ON m.id = a.milestone_id
      JOIN roadmaps r ON r.id = m.roadmap_id
      JOIN goals g ON g.id = r.goal_id
      JOIN domains d ON d.id = g.domain_id
      LEFT JOIN roadmap_nodes n ON n.version_id = r.current_version_id AND n.key = m.node_key
      WHERE a.status IN ('planned', 'available', 'revision_required') AND m.status IN ('planned', 'active')
        AND r.status = 'active' AND g.status = 'active' AND d.status IN ('active', 'maintaining')
    `).all() as CandidateAssignment[];
    return rows.map(({ id, title, domain, goalId, priority, constraints, estimate, assignmentCount, fixedDeadline }) => {
      const goal = parseJson<{ weeklyMinutes?: number; deadline?: string } | null>(constraints, {});
      const target = goal?.weeklyMinutes;
      return {
        id, kind: 'assignment', title, domain, goalId, priority, dueDate: null,
        weeklyMinutes: typeof target === 'number' && Number.isInteger(target) && target >= 0 ? target : null,
        minutes: Math.min(6000, Math.max(30, Math.ceil((estimate ? estimate / assignmentCount : 60) / 30) * 30)),
        deadline: fixedDeadline ?? (isCalendarDate(goal?.deadline) ? goal.deadline : null),
      };
    });
  }

  private reviews(asOf: string): Review[] {
    const rows = this.db.prepare(`
      WITH linked AS (
        SELECT n.skill_id, d.title, d.priority,
          ROW_NUMBER() OVER (PARTITION BY n.skill_id ORDER BY d.priority DESC, d.id) AS choice
        FROM roadmaps r
        JOIN goals g ON g.id = r.goal_id
        JOIN domains d ON d.id = g.domain_id
        JOIN roadmap_nodes n ON n.version_id = r.current_version_id AND n.skill_id IS NOT NULL
        WHERE r.status = 'active' AND g.status = 'active' AND d.status IN ('active', 'maintaining')
      )
      SELECT s.id, s.display_name AS title, m.verified_level AS level, m.verified_at AS verifiedAt, linked.title AS domain, linked.priority
      FROM skill_mastery m
      JOIN skills s ON s.id = m.skill_id
      LEFT JOIN linked ON linked.skill_id = s.id AND linked.choice = 1
      WHERE m.verified_level IS NOT NULL AND m.verified_at IS NOT NULL
        AND (linked.skill_id IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM roadmaps r JOIN roadmap_nodes n ON n.version_id = r.current_version_id WHERE n.skill_id = s.id
        ))
    `).all() as VerifiedSkill[];
    return rows.map(({ id, title, domain, priority, level, verifiedAt }): Review => {
      const verifiedDate = localTime(new Date(verifiedAt)).date;
      const method = addDays(verifiedDate, FRESH_DAYS + 1) <= asOf ? 'revalidate' : 'practice';
      return {
        id, title, domain, kind: 'review', method, verifiedDate, goalId: null, weeklyMinutes: null,
        dueDate: addDays(verifiedDate, [7, 14, 30, 45, 60][level]),
        priority: priority ?? 3, minutes: method === 'revalidate' ? 60 : 30, deadline: null,
      };
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  }

  status() {
    const date = localTime(this.clock.now()).date;
    const assignments = this.assignments();
    const reviews = this.reviews(date);
    return {
      date, timeZone: TIME_ZONE,
      assignmentsOpen: assignments.length,
      assignmentsOverdue: assignments.filter((a) => a.deadline && a.deadline < date).length,
      reviewsDue: reviews.filter((r) => r.dueDate <= date).length,
    };
  }

  private async calculate(input: ScheduleInput, requirePlanner: boolean) {
    const now = localTime(this.clock.now());
    const date = input.date ?? now.date;
    const period = input.period ?? 'day';
    if (!isCalendarDate(date) || date < now.date || date > '9999-12-25') {
      throw new BadRequestException('Choose a valid start date today or later (America/Toronto)');
    }
    const length = period === 'day' ? 1 : WEEK;
    const reviews = this.reviews(addDays(date, length - 1));
    const availability = this.availability();
    let calendar: CalendarState = 'unconfigured';
    let reserved = new Map<string, number>();
    const busyByDate = new Map<string, Interval[]>();
    if (this.config.planner || requirePlanner) {
      try {
        const result = await this.planner<PlannerAvailability>('GET', `/learning/availability?date=${date}&days=${length}`);
        if (result.timeZone !== TIME_ZONE) throw unavailable('PLANNER_TIME_ZONE', 'Planner needs the America/Toronto time zone');
        reserved = new Map(result.reserved.map(({ key, minutes }) => [key, minutes]));
        for (const day of result.days) busyByDate.set(day.date, day.busy);
        calendar = result.calendarConnected ? 'connected' : 'disconnected';
      } catch (error) {
        if (requirePlanner) throw error;
        calendar = 'unavailable';
      }
    }
    const end = addDays(date, length - 1);
    const tasks = [...this.assignments(), ...reviews.filter((r) => r.dueDate <= end)];
    const pending = tasks.map((item) => ({ ...item, minutes: Math.max(0, item.minutes - (reserved.get(taskKey(item)) ?? 0)) }));
    const plan = buildPlan(date, period, now, availability.windows, busyByDate, pending);
    return { tasks, view: { date, period, timeZone: TIME_ZONE, availability, calendar, reviews, ...plan } };
  }

  async plan(input: ScheduleInput) {
    return (await this.calculate(input, false)).view;
  }

  async propose(input: ScheduleInput, actor: string) {
    const { view: plan, tasks: snapshot } = await this.calculate(input, true);
    const tasks = new Map(snapshot.map((item) => [taskKey(item), item]));
    const items = plan.days.flatMap((day) => day.blocks.map((block) => {
      const key = taskKey(block);
      const task = tasks.get(key)!;
      return {
        title: block.title,
        date: day.date,
        start: block.start,
        end: block.end,
        task: {
          key,
          estimateMinutes: task.minutes,
          priority: task.priority >= 4 ? 1 : task.priority <= 2 ? 3 : 2,
          deadline: task.deadline,
        },
      };
    }));
    if (!items.length) throw conflict('EMPTY_STUDY_PLAN', 'There are no study blocks to propose in this period');
    const { proposal } = await this.planner<{ proposal: PlannerProposal }>('POST', '/learning/proposals', {
      date: plan.date, period: plan.period, items,
    });
    this.audit.record(actor, 'schedule.propose', 'planner_proposal', proposal.code, { date: plan.date, period: plan.period, items: items.length });
    return { date: plan.date, period: plan.period, proposal };
  }

  private async planner<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    if (!this.config.planner) throw unavailable('PLANNER_NOT_CONFIGURED', 'Planner connection is not configured');
    const { url, key } = this.config.planner;
    try {
      const response = await fetch(url + path, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6_000),
        headers: { 'X-Planner-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.ok) return await response.json() as T;
      if (response.status === 409) throw conflict('PLANNER_CONFLICT', 'Planner could not accept this draft. Refresh the plan and try again.');
    } catch (error) {
      if (error instanceof Error && 'getStatus' in error) throw error;
    }
    throw unavailable('PLANNER_UNAVAILABLE', 'Planner availability or proposal API is currently unavailable');
  }
}

@Controller('schedule')
class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @AllowBroker()
  @Get()
  plan(@Query() input: ScheduleInput) {
    return this.schedule.plan(input);
  }

  @AllowBroker()
  @Get('status')
  status() {
    return this.schedule.status();
  }

  @Get('availability')
  availability() {
    return this.schedule.availability();
  }

  @Patch('availability')
  setAvailability(@Body() body: AvailabilityInput, @Actor() actor: string) {
    return this.schedule.setAvailability(body.windows, actor);
  }

  @AllowBroker()
  @Post('propose')
  propose(@Body() input: ScheduleInput, @Actor() actor: string) {
    return this.schedule.propose(input, actor);
  }
}

@Module({ controllers: [ScheduleController], providers: [ScheduleService] })
export class ScheduleModule {}
