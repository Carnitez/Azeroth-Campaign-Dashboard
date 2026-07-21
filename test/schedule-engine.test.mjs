import test from 'node:test';
import assert from 'node:assert/strict';
import * as Core from '../src/core.mjs';
import * as Schedule from '../src/schedule-engine.mjs';
import { createPlannedActivity } from '../src/activity-engine.mjs';
import { selectNextUp, selectRecentActivity, selectWeeklyMomentum } from '../src/selectors.mjs';

const now = (day = 20, time = '10:00', offset = '+02:00') => new Date(`2026-07-${String(day).padStart(2, '0')}T${time}:00${offset}`);
const character = (id = 'c1', extra = {}) => ({ id, name: id, realm: 'Silvermoon', region: 'EU', faction: 'Alliance', race: 'Night Elf', className: 'Druid', spec: 'Guardian', location: 'Dolanaar', professions: '', level: 10, gold: 0, playedMinutes: 0, createdAt: '2026-07-01', ...extra });
const activity = (id, schedule, extra = {}) => ({ id, kind: 'planned', title: id, description: '', characterId: 'c1', category: 'Campaign', priority: 1, status: 'todo', estimatedMinutes: 20, repeatType: schedule?.type || 'one_time', tags: [], notes: '', scheduledFor: null, createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z', completedAt: null, ...(schedule ? { schedule: { startDate: null, dueTime: null, weekdays: [], intervalValue: 1, intervalUnit: 'days', endDate: null, timezoneMode: 'local', graceMinutes: 0, paused: false, pausedUntil: null, ...schedule } } : {}), ...extra });
const state = (activities = [], extra = {}) => ({ schemaVersion: 2, activeCharacterId: 'c1', preferences: {}, characters: [character()], goals: [], activities, progressEvents: [], collectionTrackers: [], sessionPlans: [], activityOccurrences: [], migration: { sourceVersion: 2, targetVersion: 2, migratedAt: '2026-07-01T00:00:00.000Z' }, ...extra });
const completeRecord = (item, date, key = Schedule.occurrenceKeyForDate(item, date)) => ({ id: `r-${item.id}-${date}`, activityId: item.id, characterId: item.characterId, occurrenceKey: key, expectedAt: `${date}T00:00:00.000Z`, status: 'completed', recordedAt: `${date}T10:00:00.000Z`, completedAt: `${date}T10:00:00.000Z`, notes: '' });

test('existing activities without schedules keep legacy availability', () => {
  const item = activity('legacy', null, { repeatType: 'one_time' });
  assert.equal(Schedule.normalizeSchedule(item).legacyUnscheduled, true);
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'available_now');
});

test('legacy repeat types normalize into richer schedules', () => {
  assert.equal(Schedule.normalizeSchedule(activity('daily', null, { repeatType: 'daily' })).type, 'daily');
  assert.equal(Schedule.normalizeSchedule(activity('weekly', null, { repeatType: 'weekly', scheduledFor: '2026-07-21' })).weekdays[0], 2);
  assert.equal(Schedule.normalizeSchedule(activity('manual', null, { repeatType: 'manual' })).type, 'manual');
});

test('daily activities are available on the local day', () => {
  const item = activity('daily', { type: 'daily', startDate: '2026-07-01' });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'available_now');
});

test('daily completion resets on the next local day', () => {
  const item = activity('daily', { type: 'daily', startDate: '2026-07-01' });
  const current = state([item], { activityOccurrences: [completeRecord(item, '2026-07-20')] });
  assert.equal(Schedule.activityAvailability(item, current, { now: now() }).state, 'completed_period');
  assert.equal(Schedule.activityAvailability(item, current, { now: now(21) }).state, 'available_now');
});

test('weekly activities become available on the configured local weekday', () => {
  const item = activity('weekly', { type: 'weekly', startDate: '2026-07-01', weekdays: [3] });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'missed');
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now(22) }).state, 'available_now');
});

test('weekly completion resets in the next local week', () => {
  const item = activity('weekly', { type: 'weekly', startDate: '2026-07-01', weekdays: [1] });
  const current = state([item], { activityOccurrences: [completeRecord(item, '2026-07-20')] });
  assert.equal(Schedule.activityAvailability(item, current, { now: now() }).state, 'completed_period');
  assert.equal(Schedule.activityAvailability(item, current, { now: new Date('2026-07-27T10:00:00+02:00') }).state, 'available_now');
});

test('selected weekdays only appear on configured local weekdays', () => {
  const item = activity('mwf', { type: 'weekdays', startDate: '2026-07-01', weekdays: [1, 3, 5] });
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-20'), true);
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-21'), false);
});

test('multiple selected weekdays have independent occurrence keys', () => {
  const item = activity('mwf', { type: 'weekdays', startDate: '2026-07-01', weekdays: [1, 3, 5] });
  assert.notEqual(Schedule.occurrenceKeyForDate(item, '2026-07-20'), Schedule.occurrenceKeyForDate(item, '2026-07-22'));
});

test('every-N-days schedules use the anchor date', () => {
  const item = activity('two-days', { type: 'interval', startDate: '2026-07-20', intervalValue: 2, intervalUnit: 'days' });
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-22'), true);
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-23'), false);
});

test('every-N-weeks schedules use the anchored weekday', () => {
  const item = activity('two-weeks', { type: 'interval', startDate: '2026-07-20', intervalValue: 2, intervalUnit: 'weeks' });
  assert.equal(Schedule.scheduledOnDate(item, '2026-08-03'), true);
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-27'), false);
});

test('interval completion time never shifts the stable anchor', () => {
  const item = activity('anchor', { type: 'interval', startDate: '2026-07-20', intervalValue: 3, intervalUnit: 'days' }, { completedAt: '2026-07-21T22:00:00.000Z' });
  assert.equal(Schedule.scheduledOnDate(item, '2026-07-23'), true);
});

test('manual schedules stay available until explicitly completed or reset', () => {
  const item = activity('manual', { type: 'manual' });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'manual_available');
  const done = { ...item, status: 'completed', completedAt: now().toISOString() };
  assert.equal(Schedule.activityAvailability(done, state([done]), { now: now() }).state, 'completed_period');
  assert.equal(Schedule.resetManualSchedule(done, { now: now(21) }).status, 'todo');
});

test('one-time schedules remain complete', () => {
  const item = activity('once', { type: 'one_time', startDate: '2026-07-20' }, { status: 'completed', completedAt: now().toISOString() });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now(21) }).state, 'completed_period');
});

test('future start dates are not started', () => {
  const item = activity('future', { type: 'daily', startDate: '2026-07-22' });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'not_started');
});

test('past end dates expire without rewriting history', () => {
  const item = activity('ended', { type: 'daily', startDate: '2026-07-01', endDate: '2026-07-19' });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'expired');
});

test('paused schedules are excluded until resumed', () => {
  const item = activity('paused', { type: 'daily', paused: true });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now() }).state, 'paused');
  const resumed = Schedule.resumeSchedule(item, { now: now() });
  assert.equal(Schedule.activityAvailability(resumed, state([resumed]), { now: now() }).state, 'available_now');
});

test('snooze later today affects only the current occurrence', () => {
  const item = activity('snooze', { type: 'daily' });
  const result = Schedule.snoozeCurrentOccurrence(item, state([item]), now(20, '15:00'), {}, { now: now() });
  const availability = Schedule.activityAvailability(item, result.state, { now: now(20, '11:00') });
  assert.equal(availability.reason, 'snoozed');
  assert.equal(availability.nextAvailable, now(20, '15:00').toISOString());
});

test('snooze to tomorrow preserves the original expected occurrence', () => {
  const item = activity('tomorrow', { type: 'daily' });
  const result = Schedule.snoozeCurrentOccurrence(item, state([item]), now(21, '09:00'), {}, { now: now() });
  assert.equal(Core.localDateKey(result.record.expectedAt), '2026-07-20');
  assert.equal(Core.localDateKey(result.record.snoozedUntil), '2026-07-21');
});

test('custom snooze validates a future local timestamp', () => {
  const item = activity('custom', { type: 'daily' });
  assert.throws(() => Schedule.snoozeCurrentOccurrence(item, state([item]), now(19), {}, { now: now() }), /future local date/);
});

test('skipping affects only the current occurrence', () => {
  const item = activity('skip', { type: 'daily' });
  const skipped = Schedule.skipCurrentOccurrence(item, state([item]), { reason: 'Raid night' }, { now: now() });
  assert.equal(Schedule.activityAvailability(item, skipped.state, { now: now() }).result, 'skipped');
  assert.equal(Schedule.activityAvailability(item, skipped.state, { now: now(21) }).state, 'available_now');
});

test('a skipped occurrence can be undone safely', () => {
  const item = activity('undo', { type: 'daily' });
  const skipped = Schedule.skipCurrentOccurrence(item, state([item]), {}, { now: now() });
  const restored = Schedule.undoOccurrence(skipped.state, skipped.record.id, { now: now(20, '11:00') });
  assert.equal(Schedule.activityAvailability(item, restored, { now: now(20, '12:00') }).state, 'available_now');
});

test('missed occurrence calculation finds the latest expected occurrence', () => {
  const item = activity('weekday', { type: 'weekdays', startDate: '2026-07-01', weekdays: [1] });
  const availability = Schedule.activityAvailability(item, state([item]), { now: now(21) });
  assert.equal(availability.state, 'missed');
  assert.equal(availability.expectedDate, '2026-07-20');
});

test('upcoming seven-day projection omits empty dates and remains ordered', () => {
  const item = activity('mwf', { type: 'weekdays', startDate: '2026-07-01', weekdays: [1, 3, 5] });
  const projection = Schedule.projectUpcoming(state([item]), { now: now(), days: 7 });
  assert.deepEqual(projection.map(value => value.date), ['2026-07-20', '2026-07-22', '2026-07-24']);
});

test('legacy unscheduled one-time work is not repeated across upcoming days', () => {
  const item = activity('unscheduled-once', null, { scheduledFor: null, repeatType: 'one_time' });
  const projection = Schedule.projectUpcoming(state([item]), { now: now(), days: 7 });
  assert.equal(projection.filter(row => row.activity.id === item.id).length, 1);
  assert.equal(projection.find(row => row.activity.id === item.id)?.date, '2026-07-20');
});

test('due times distinguish later today from due now', () => {
  const item = activity('timed', { type: 'daily', dueTime: '15:00' });
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now(20, '10:00') }).state, 'due_later_today');
  assert.equal(Schedule.activityAvailability(item, state([item]), { now: now(20, '16:00') }).state, 'due_today');
});

test('local midnight assigns 23:59 and 00:01 to different periods', () => {
  const item = activity('midnight', { type: 'daily' });
  const before = Schedule.occurrenceKeyForDate(item, Core.localDateKey(new Date('2026-07-20T23:59:00+02:00')));
  const after = Schedule.occurrenceKeyForDate(item, Core.localDateKey(new Date('2026-07-21T00:01:00+02:00')));
  assert.notEqual(before, after);
});

test('weekly boundaries use the local Monday', () => {
  assert.equal(Core.localDateKey(Schedule.localWeekStart(new Date('2026-07-26T23:59:00+02:00'))), '2026-07-20');
  assert.equal(Core.localDateKey(Schedule.localWeekStart(new Date('2026-07-27T00:01:00+02:00'))), '2026-07-27');
});

test('daylight-saving transitions generate one local date per day', () => {
  const start = Schedule.localDateFromKey('2026-10-24');
  const dates = [0, 1, 2, 3].map(offset => Core.localDateKey(Schedule.addLocalDays(start, offset)));
  assert.deepEqual(dates, ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
});

test('schedule editor validation rejects impossible configurations', () => {
  assert.equal(Schedule.validateSchedule({ type: 'weekdays', weekdays: [], intervalValue: 1, intervalUnit: 'days' }).ok, false);
  assert.equal(Schedule.validateSchedule({ type: 'interval', startDate: '2026-07-20', endDate: '2026-07-19', weekdays: [], intervalValue: 0, intervalUnit: 'days' }).ok, false);
  assert.equal(Schedule.validateSchedule({ type: 'daily', dueTime: '25:99', weekdays: [], intervalValue: 1, intervalUnit: 'days' }).ok, false);
});

test('Next Up excludes unavailable recurring activities', () => {
  const unavailable = activity('tuesday', { type: 'weekdays', startDate: '2026-07-01', weekdays: [2] }, { priority: 3 });
  const available = activity('monday', { type: 'daily' }, { priority: 1 });
  const results = selectNextUp(state([unavailable, available]), { now: now(), limit: 10 });
  assert.equal(results.some(item => item.sourceId === unavailable.id), false);
  assert.equal(results.some(item => item.sourceId === available.id), true);
});

test('Next Up prioritises due activities over other available work', () => {
  const optional = activity('optional', null, { priority: 1 });
  const due = activity('due', { type: 'daily', dueTime: '09:00' }, { priority: 2 });
  const results = selectNextUp(state([optional, due]), { now: now(), limit: 10 }).filter(item => item.sourceType === 'activity');
  assert.equal(results[0].sourceId, due.id);
});

test('agenda grouping separates due, available, optional, completed, and attention work', () => {
  const due = activity('due', { type: 'daily', dueTime: '09:00' });
  const available = activity('available', { type: 'daily' });
  const optional = activity('optional', null);
  const done = activity('done', { type: 'daily' });
  const missed = activity('missed', { type: 'weekdays', weekdays: [1] });
  const current = state([due, available, optional, done, missed], { activityOccurrences: [completeRecord(done, '2026-07-20')] });
  const groups = Schedule.selectAgenda(current, { scope: 'all', now: now(21) }).groups;
  assert.ok(groups.dueNow.length || groups.availableToday.length);
  assert.equal(groups.optional.some(row => row.activity.id === optional.id), true);
  assert.equal(groups.needsAttention.some(row => row.activity.id === missed.id), true);
});

test('agenda filters cover category, priority, schedule, and completion', () => {
  const daily = activity('daily', { type: 'daily' }, { category: 'Gold', priority: 3 });
  const other = activity('other', null, { category: 'Campaign', priority: 1 });
  const rows = Schedule.selectAgenda(state([daily, other]), { scope: 'all', now: now(), category: 'Gold', priority: 3, scheduleType: 'daily', completionState: 'available' }).rows;
  assert.deepEqual(rows.map(row => row.activity.id), ['daily']);
});

test('all-character agenda scope includes each active character', () => {
  const first = activity('first', { type: 'daily' });
  const second = activity('second', { type: 'daily' }, { characterId: 'c2' });
  const current = state([first, second], { characters: [character(), character('c2')] });
  assert.deepEqual(new Set(Schedule.selectAgenda(current, { scope: 'all', now: now() }).rows.map(row => row.activity.characterId)), new Set(['c1', 'c2']));
});

test('archived characters are excluded from the active agenda', () => {
  const archived = activity('archived', { type: 'daily' }, { characterId: 'c2' });
  const current = state([archived], { characters: [character(), character('c2', { archivedAt: now().toISOString() })] });
  assert.equal(Schedule.selectAgenda(current, { scope: 'all', now: now() }).rows.length, 0);
});

test('selected available agenda items convert into a locked session plan', () => {
  const first = activity('first', { type: 'daily' }, { estimatedMinutes: 20 });
  const second = activity('second', { type: 'daily' }, { estimatedMinutes: 30 });
  const result = Schedule.agendaToSessionPlan(state([first, second]), [first.id, second.id], { budgetMinutes: 40, now: now() });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].locked, true);
});

test('duplicate direct completion records are prevented', () => {
  const item = activity('complete', { type: 'daily' });
  const first = Schedule.completeCurrentOccurrence(item, state([item]), {}, { now: now() });
  const second = Schedule.completeCurrentOccurrence(item, first.state, {}, { now: now(20, '11:00') });
  assert.equal(second.duplicate, true);
  assert.equal(second.state.activityOccurrences.length, 1);
});

test('historical runs survive future schedule edits', () => {
  const item = activity('history', { type: 'daily' });
  const current = state([item], { activityOccurrences: [completeRecord(item, '2026-07-19')] });
  const edited = { ...item, schedule: { ...item.schedule, type: 'weekly', weekdays: [1] } };
  const nextState = { ...current, activities: [edited] };
  assert.equal(Schedule.selectRunHistory(nextState, item.id).length, 1);
});

test('corrected session results update run history automatically', () => {
  const item = activity('session-history', { type: 'daily' });
  const plan = { id: 'p1', title: 'Run', status: 'completed', updatedAt: now().toISOString(), completedAt: now().toISOString(), items: [{ id: 'i1', activityId: item.id, characterId: 'c1', status: 'completed', completedAt: now().toISOString(), actualMinutes: 12, goldEarned: 55, goldSpent: 5, progressMetric: '', progressGained: 0, resultNotes: 'Corrected' }] };
  const history = Schedule.selectRunHistory(state([item], { sessionPlans: [plan] }), item.id);
  assert.equal(history[0].goldEarned, 55);
  assert.equal(history[0].notes, 'Corrected');
});

test('schedule selectors never mutate canonical input', () => {
  const item = activity('pure', { type: 'daily' });
  const current = state([item]); const before = structuredClone(current);
  Schedule.activityAvailability(item, current, { now: now() }); Schedule.selectAgenda(current, { scope: 'all', now: now() }); Schedule.projectUpcoming(current, { now: now() }); Schedule.selectRunHistory(current, item.id);
  assert.deepEqual(current, before);
});

test('existing v1 migration includes an empty occurrence collection', () => {
  const migrated = Core.migrateV1ToV2({ characters: [{ id: 'c1', name: 'C', realm: 'R', level: 1, gold: 0 }] }, { now: now() });
  assert.deepEqual(migrated.activityOccurrences, []);
});

test('existing v2 loading adds optional schedule collections safely', () => {
  const legacyV2 = state([]); delete legacyV2.activityOccurrences;
  const loaded = Core.migrateState(legacyV2, { now: now() });
  assert.deepEqual(loaded.activityOccurrences, []);
});

test('existing saved session plans survive schedule normalization', () => {
  const existing = state([], { sessionPlans: [{ id: 'plan', title: 'Saved', status: 'ready', characterIds: ['c1'], items: [], totalEstimatedMinutes: 0, plannedFor: '2026-07-20', createdAt: now().toISOString(), updatedAt: now().toISOString(), startedAt: null, completedAt: null, endedAt: null, activeStartedAt: null, pausedAt: null, accumulatedMs: 0, currentItemId: null, notes: '', reconciliation: null }] });
  assert.equal(Core.migrateState(existing).sessionPlans[0].id, 'plan');
});

test('schedule descriptions remain plain-language and deterministic', () => {
  const item = activity('description', { type: 'weekdays', weekdays: [1, 3, 5] });
  assert.equal(Schedule.scheduleDescription(item), 'Available Monday, Wednesday, Friday');
});

test('command center Today summary derives counts and estimates', () => {
  const first = activity('first', { type: 'daily' }, { estimatedMinutes: 20, priority: 3 });
  const second = activity('second', { type: 'daily' }, { estimatedMinutes: 10 });
  const summary = Schedule.commandCenterTodaySummary(state([first, second]), { now: now() });
  assert.equal(summary.availableCount, 2);
  assert.equal(summary.estimatedMinutes, 30);
  assert.equal(summary.highestPriority.activity.id, 'first');
});

test('direct occurrence completions update momentum and recent activity', () => {
  const item = activity('direct-history', { type: 'daily' });
  const current = state([item], { activityOccurrences: [completeRecord(item, '2026-07-20')] });
  assert.equal(selectWeeklyMomentum(current, { now: now() }).completed, 1);
  assert.equal(selectRecentActivity(current).some(entry => entry.sourceId === item.id && entry.title.startsWith('Completed')), true);
});

test('completed session runs count once in weekly momentum without completing the reusable activity', () => {
  const item = activity('session-momentum', { type: 'daily' });
  const plan = { id: 'session-momentum-plan', title: 'Daily run', status: 'completed', completedAt: now().toISOString(), endedAt: now().toISOString(), items: [{ id: 'item-1', activityId: item.id, characterId: item.characterId, status: 'completed', completedAt: now().toISOString() }] };
  assert.equal(selectWeeklyMomentum(state([item], { sessionPlans: [plan] }), { now: now() }).completed, 1);
});
