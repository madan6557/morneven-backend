import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeNextRunAfterExecution,
  computeNextRunAt,
  normalizeScheduleSpec,
  validateTimezone
} from './index.js';

test('relative schedules keep a stable anchor', () => {
  const anchor = new Date('2026-07-16T02:00:00.000Z');
  const schedule = normalizeScheduleSpec({
    type: 'relative',
    days: 3,
    time: '09:30'
  }, anchor);
  assert.equal(schedule.type, 'relative');
  assert.equal(schedule.anchorAt, anchor.toISOString());
  assert.equal(
    computeNextRunAt(schedule, 'Asia/Singapore', anchor)?.toISOString(),
    '2026-07-19T01:30:00.000Z'
  );
});

test('weekly schedules select the next configured local weekday', () => {
  const next = computeNextRunAt(
    { type: 'weekly', weekdays: [1], time: '08:00' },
    'Asia/Singapore',
    new Date('2026-07-16T02:00:00.000Z')
  );
  assert.equal(next?.toISOString(), '2026-07-20T00:00:00.000Z');
});

test('invalid timezones are rejected', () => {
  assert.throws(() => validateTimezone('Not/AZone'), /Invalid IANA timezone/);
});

test('nonexistent DST wall time is rejected for a one-time schedule', () => {
  assert.throws(
    () => computeNextRunAt(
      { type: 'once', date: '2026-03-08', time: '02:30' },
      'America/New_York',
      new Date('2026-03-07T00:00:00.000Z')
    ),
    /does not exist/
  );
});

test('weekly schedule skips a nonexistent DST occurrence', () => {
  const next = computeNextRunAt(
    { type: 'weekly', weekdays: [0], time: '02:30' },
    'America/New_York',
    new Date('2026-03-07T12:00:00.000Z')
  );
  assert.equal(next?.toISOString(), '2026-03-15T06:30:00.000Z');
});

test('past one-time schedules have no next run', () => {
  const next = computeNextRunAt(
    { type: 'once', date: '2026-07-15', time: '08:00' },
    'Asia/Singapore',
    new Date('2026-07-16T00:00:00.000Z')
  );
  assert.equal(next, null);
});

test('missed weekly runs advance directly to the next future occurrence', () => {
  const next = computeNextRunAfterExecution(
    { type: 'weekly', weekdays: [1], time: '08:00' },
    'Asia/Singapore',
    new Date('2026-07-06T00:00:00.000Z'),
    new Date('2026-07-30T02:00:00.000Z')
  );
  assert.equal(next?.toISOString(), '2026-08-03T00:00:00.000Z');
});
