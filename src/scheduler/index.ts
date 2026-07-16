import { randomUUID } from 'node:crypto';
import { Prisma, type ScheduledTask } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleSpecSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('once'),
    date: z.string().regex(datePattern),
    time: z.string().regex(timePattern)
  }),
  z.object({
    type: z.literal('relative'),
    days: z.coerce.number().int().min(1).max(3650),
    time: z.string().regex(timePattern),
    anchorAt: z.string().datetime().optional()
  }),
  z.object({
    type: z.literal('weekly'),
    weekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
    time: z.string().regex(timePattern)
  })
]);

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export const scheduleInputSchema = z.object({
  timezone: z.string().trim().min(1).max(120),
  schedule: scheduleSpecSchema
});

type ScheduledTaskHandler = (
  task: ScheduledTask,
  scheduledFor: Date
) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, ScheduledTaskHandler>();
const workerId = `scheduler-${process.pid}-${randomUUID()}`;
const leaseMs = 2 * 60 * 1000;
const leaseHeartbeatMs = 30 * 1000;
const pollMs = 30 * 1000;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

const parseNumberPart = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => {
  const value = parts.find((part) => part.type === type)?.value;
  return value ? Number(value) : Number.NaN;
};

const zonedParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return {
    year: parseNumberPart(parts, 'year'),
    month: parseNumberPart(parts, 'month'),
    day: parseNumberPart(parts, 'day'),
    hour: parseNumberPart(parts, 'hour'),
    minute: parseNumberPart(parts, 'minute'),
    second: parseNumberPart(parts, 'second')
  };
};

const timezoneOffsetMs = (date: Date, timezone: string) => {
  const parts = zonedParts(date, timezone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ) - date.getTime();
};

const localDateTimeToUtc = (
  date: string,
  time: string,
  timezone: string
) => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const localTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(localTimestamp - timezoneOffsetMs(new Date(localTimestamp), timezone));
  candidate = new Date(localTimestamp - timezoneOffsetMs(candidate, timezone));
  const actual = zonedParts(candidate, timezone);
  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  ) {
    throw new Error(`Local time ${date} ${time} does not exist in ${timezone}`);
  }
  return candidate;
};

const dateStringFromParts = (parts: ReturnType<typeof zonedParts>, addDays = 0) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + addDays));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
};

export const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
};

export const normalizeScheduleSpec = (
  raw: ScheduleSpec,
  now = new Date()
): ScheduleSpec => {
  const parsed = scheduleSpecSchema.parse(raw);
  if (parsed.type === 'relative') {
    return {
      ...parsed,
      anchorAt: parsed.anchorAt ?? now.toISOString()
    };
  }
  if (parsed.type === 'weekly') {
    return {
      ...parsed,
      weekdays: Array.from(new Set(parsed.weekdays)).sort((left, right) => left - right)
    };
  }
  return parsed;
};

export const computeNextRunAt = (
  schedule: ScheduleSpec,
  timezone: string,
  after = new Date()
): Date | null => {
  validateTimezone(timezone);
  const normalized = normalizeScheduleSpec(schedule, after);

  if (normalized.type === 'once') {
    const candidate = localDateTimeToUtc(normalized.date, normalized.time, timezone);
    return candidate.getTime() > after.getTime() ? candidate : null;
  }

  if (normalized.type === 'relative') {
    const anchor = new Date(normalized.anchorAt!);
    if (!Number.isFinite(anchor.getTime())) throw new Error('Invalid relative schedule anchor');
    const targetDate = dateStringFromParts(zonedParts(anchor, timezone), normalized.days);
    const candidate = localDateTimeToUtc(targetDate, normalized.time, timezone);
    return candidate.getTime() > after.getTime() ? candidate : null;
  }

  const currentParts = zonedParts(after, timezone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const localDate = dateStringFromParts(currentParts, offset);
    const calendarDate = new Date(`${localDate}T00:00:00Z`);
    if (!normalized.weekdays.includes(calendarDate.getUTCDay())) continue;
    try {
      const candidate = localDateTimeToUtc(localDate, normalized.time, timezone);
      if (candidate.getTime() > after.getTime()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

export const computeNextRunAfterExecution = (
  schedule: ScheduleSpec,
  timezone: string,
  scheduledFor: Date,
  now = new Date()
) => computeNextRunAt(
  schedule,
  timezone,
  new Date(Math.max(scheduledFor.getTime(), now.getTime()))
);

export const serializeScheduledTask = (task: ScheduledTask | null) => {
  if (!task) return null;
  return {
    id: task.id,
    key: task.key,
    kind: task.kind,
    targetId: task.targetId,
    enabled: task.enabled,
    timezone: task.timezone,
    schedule: task.schedule,
    payload: task.payload,
    nextRunAt: task.nextRunAt?.toISOString() ?? null,
    lastRunAt: task.lastRunAt?.toISOString() ?? null,
    lastStatus: task.lastStatus,
    lastError: task.lastError,
    createdBy: task.createdBy,
    updatedBy: task.updatedBy,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
};

export const upsertScheduledTask = async (input: {
  key: string;
  kind: string;
  targetId?: string | null;
  timezone: string;
  schedule: ScheduleSpec;
  payload?: Record<string, unknown>;
  actor: string;
}) => {
  const timezone = validateTimezone(input.timezone);
  const schedule = normalizeScheduleSpec(input.schedule);
  const nextRunAt = computeNextRunAt(schedule, timezone, new Date(Date.now() - 1000));
  if (!nextRunAt) throw new Error('Schedule must have a future run time');
  return prisma.scheduledTask.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      kind: input.kind,
      targetId: input.targetId ?? null,
      enabled: true,
      timezone,
      schedule: schedule as Prisma.InputJsonValue,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      nextRunAt,
      createdBy: input.actor,
      updatedBy: input.actor
    },
    update: {
      kind: input.kind,
      targetId: input.targetId ?? null,
      enabled: true,
      timezone,
      schedule: schedule as Prisma.InputJsonValue,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      nextRunAt,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      updatedBy: input.actor
    }
  });
};

export const deleteScheduledTask = async (key: string) => {
  const existing = await prisma.scheduledTask.findUnique({ where: { key } });
  if (!existing) return null;
  await prisma.scheduledTask.delete({ where: { id: existing.id } });
  return existing;
};

export const registerScheduledTaskHandler = (
  kind: string,
  handler: ScheduledTaskHandler
) => {
  handlers.set(kind, handler);
};

const taskPriority = (kind: string) => {
  if (kind === 'runtime.freeze') return 0;
  if (kind === 'runtime.stop') return 1;
  if (kind === 'runtime.start') return 2;
  return 3;
};

const executeTask = async (task: ScheduledTask) => {
  const scheduledFor = task.nextRunAt;
  if (!scheduledFor) return;
  const claimed = await prisma.scheduledTask.updateMany({
    where: {
      id: task.id,
      enabled: true,
      nextRunAt: scheduledFor,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
    },
    data: {
      leaseOwner: workerId,
      leaseUntil: new Date(Date.now() + leaseMs)
    }
  });
  if (!claimed.count) return;

  const schedule = scheduleSpecSchema.parse(task.schedule);
  const existingRun = await prisma.scheduledTaskRun.findUnique({
    where: {
      taskId_scheduledFor: {
        taskId: task.id,
        scheduledFor
      }
    }
  });
  if (existingRun?.status === 'completed') {
    const nextRunAt = computeNextRunAfterExecution(schedule, task.timezone, scheduledFor);
    await prisma.scheduledTask.updateMany({
      where: { id: task.id, leaseOwner: workerId, nextRunAt: scheduledFor },
      data: {
        enabled: Boolean(nextRunAt),
        nextRunAt,
        lastRunAt: scheduledFor,
        lastStatus: 'completed',
        lastError: null,
        leaseOwner: null,
        leaseUntil: null
      }
    });
    return;
  }

  const run = await prisma.scheduledTaskRun.upsert({
    where: {
      taskId_scheduledFor: {
        taskId: task.id,
        scheduledFor
      }
    },
    create: {
      taskId: task.id,
      scheduledFor,
      status: 'running',
      workerId
    },
    update: {
      startedAt: new Date(),
      completedAt: null,
      status: 'running',
      result: Prisma.JsonNull,
      error: null,
      workerId
    }
  });
  const handler = handlers.get(task.kind);
  const heartbeat = setInterval(() => {
    void prisma.scheduledTask.updateMany({
      where: { id: task.id, leaseOwner: workerId, nextRunAt: scheduledFor },
      data: { leaseUntil: new Date(Date.now() + leaseMs) }
    }).catch((error) => {
      console.error('Scheduled task lease heartbeat failed', error);
    });
  }, leaseHeartbeatMs);
  heartbeat.unref();
  try {
    if (!handler) throw new Error(`No handler registered for scheduled task kind ${task.kind}`);
    const result = await handler(task, scheduledFor);
    const nextRunAt = computeNextRunAfterExecution(schedule, task.timezone, scheduledFor);
    await prisma.$transaction([
      prisma.scheduledTaskRun.updateMany({
        where: { id: run.id, workerId, status: 'running' },
        data: {
          status: 'completed',
          completedAt: new Date(),
          result: (result ?? {}) as Prisma.InputJsonValue
        }
      }),
      prisma.scheduledTask.updateMany({
        where: { id: task.id, leaseOwner: workerId, nextRunAt: scheduledFor },
        data: {
          enabled: Boolean(nextRunAt),
          nextRunAt,
          lastRunAt: scheduledFor,
          lastStatus: 'completed',
          lastError: null,
          leaseOwner: null,
          leaseUntil: null
        }
      })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scheduled task failed';
    const nextRunAt = computeNextRunAfterExecution(schedule, task.timezone, scheduledFor);
    await prisma.$transaction([
      prisma.scheduledTaskRun.updateMany({
        where: { id: run.id, workerId, status: 'running' },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: message
        }
      }),
      prisma.scheduledTask.updateMany({
        where: { id: task.id, leaseOwner: workerId, nextRunAt: scheduledFor },
        data: {
          enabled: Boolean(nextRunAt),
          nextRunAt,
          lastRunAt: scheduledFor,
          lastStatus: 'failed',
          lastError: message,
          leaseOwner: null,
          leaseUntil: null
        }
      })
    ]);
  } finally {
    clearInterval(heartbeat);
  }
};

export const runScheduledTaskTick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    const due = await prisma.scheduledTask.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]
      },
      orderBy: { nextRunAt: 'asc' },
      take: 50
    });
    due.sort((left, right) => {
      const time = (left.nextRunAt?.getTime() ?? 0) - (right.nextRunAt?.getTime() ?? 0);
      return time || taskPriority(left.kind) - taskPriority(right.kind);
    });
    for (const task of due) {
      try {
        await executeTask(task);
      } catch (error) {
        console.error(`Scheduled task execution failed before completion: ${task.key}`, error);
      }
    }
  } finally {
    ticking = false;
  }
};

export const startScheduledTaskWorker = () => {
  if (timer) return () => undefined;
  void runScheduledTaskTick().catch((error) => {
    console.error('Scheduled task worker tick failed', error);
  });
  timer = setInterval(() => {
    void runScheduledTaskTick().catch((error) => {
      console.error('Scheduled task worker tick failed', error);
    });
  }, pollMs);
  timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
};
