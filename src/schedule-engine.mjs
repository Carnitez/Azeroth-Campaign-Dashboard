/*
 * Pure recurring schedule, Daily Agenda, and run-history domain logic.
 * All availability is derived at read time; no derived agenda state is persisted.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');

export const SCHEDULE_TYPES = Object.freeze(['one_time', 'daily', 'weekly', 'weekdays', 'interval', 'manual']);
export const INTERVAL_UNITS = Object.freeze(['days', 'weeks']);
export const OCCURRENCE_STATUSES = Object.freeze(['completed', 'skipped', 'snoozed', 'reset']);
export const AVAILABILITY_STATES = Object.freeze([
  'available_now', 'due_today', 'due_later_today', 'upcoming', 'completed_period',
  'missed', 'paused', 'not_started', 'expired', 'manual_available'
]);

const DAY_MS = 86_400_000;
const list = value => Array.isArray(value) ? value : [];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestamp = value => Core.localDateTime(value)?.getTime() ?? 0;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
const terminalResult = status => ['completed', 'skipped', 'partial'].includes(status);

export function localDateFromKey(key, time = '00:00') {
  if (!datePattern.test(String(key)) || !timePattern.test(String(time))) return null;
  const [year, month, day] = key.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day ? value : null;
}

export function addLocalDays(value, amount) {
  const date = value instanceof Date ? new Date(value.getTime()) : localDateFromKey(Core.localDateKey(value));
  if (!date) return null;
  date.setDate(date.getDate() + Number(amount || 0));
  return date;
}

export function localWeekStart(value = new Date()) {
  const date = Core.localDateTime(value) ?? new Date();
  const output = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  output.setDate(output.getDate() - ((output.getDay() + 6) % 7));
  return output;
}

function cleanWeekdays(value) {
  return [...new Set(list(value).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function legacyType(activity) {
  return SCHEDULE_TYPES.includes(activity?.repeatType) ? activity.repeatType : 'one_time';
}

export function normalizeSchedule(activity = {}) {
  const source = Core.isPlainObject(activity.schedule) ? activity.schedule : {};
  const type = SCHEDULE_TYPES.includes(source.type) ? source.type : legacyType(activity);
  const scheduled = datePattern.test(String(activity.scheduledFor || '')) ? activity.scheduledFor : null;
  const created = Core.localDateKey(activity.createdAt) || Core.localDateKey();
  let startDate = datePattern.test(String(source.startDate || '')) ? source.startDate : scheduled;
  let weekdays = cleanWeekdays(source.weekdays);
  if (type === 'weekly' && !weekdays.length) {
    const anchor = localDateFromKey(startDate || scheduled || created);
    weekdays = [anchor?.getDay() ?? 1];
  }
  if (type === 'weekdays' && !weekdays.length) weekdays = [];
  if (type === 'interval' && !startDate) startDate = scheduled || created;
  return {
    type,
    startDate,
    dueTime: timePattern.test(String(source.dueTime || '')) ? source.dueTime : null,
    weekdays,
    intervalValue: Math.max(1, Math.floor(number(source.intervalValue, 1))),
    intervalUnit: INTERVAL_UNITS.includes(source.intervalUnit) ? source.intervalUnit : 'days',
    endDate: datePattern.test(String(source.endDate || '')) ? source.endDate : null,
    timezoneMode: 'local',
    graceMinutes: Math.max(0, Math.floor(number(source.graceMinutes, 0))),
    paused: Boolean(source.paused),
    pausedUntil: datePattern.test(String(source.pausedUntil || '')) ? source.pausedUntil : null,
    legacyUnscheduled: !activity.schedule && !scheduled
  };
}

export function validateSchedule(input) {
  const errors = [];
  if (!Core.isPlainObject(input)) return { ok: false, errors: ['Schedule must be an object.'] };
  if (!SCHEDULE_TYPES.includes(input.type)) errors.push('Choose a supported schedule type.');
  if (input.startDate && (!datePattern.test(String(input.startDate)) || !localDateFromKey(input.startDate))) errors.push('Start date is invalid.');
  if (input.endDate && (!datePattern.test(String(input.endDate)) || !localDateFromKey(input.endDate))) errors.push('End date is invalid.');
  if (input.startDate && input.endDate && input.endDate < input.startDate) errors.push('End date must not be before the start date.');
  if (input.dueTime && !timePattern.test(String(input.dueTime))) errors.push('Due time must be a valid local time.');
  if (input.type === 'weekdays' && !cleanWeekdays(input.weekdays).length) errors.push('Choose at least one weekday.');
  if (input.type === 'weekly' && cleanWeekdays(input.weekdays).length !== 1) errors.push('Choose one weekday for a weekly schedule.');
  if (input.type === 'interval' && (!Number.isInteger(Number(input.intervalValue)) || Number(input.intervalValue) <= 0)) errors.push('Interval must be a positive whole number.');
  if (input.type === 'interval' && !INTERVAL_UNITS.includes(input.intervalUnit)) errors.push('Choose days or weeks for the interval.');
  if (input.type === 'interval' && !input.startDate) errors.push('Interval schedules need a stable start date.');
  return { ok: !errors.length, errors };
}

const weekdayNames = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

export function scheduleDescription(input) {
  const schedule = Core.isPlainObject(input?.schedule) || input?.repeatType ? normalizeSchedule(input) : { ...input, weekdays: cleanWeekdays(input?.weekdays) };
  let text = 'Available once';
  if (schedule.type === 'daily') text = 'Available every day';
  else if (schedule.type === 'weekly') text = `Available every ${weekdayNames[schedule.weekdays?.[0] ?? 1]}`;
  else if (schedule.type === 'weekdays') text = `Available ${schedule.weekdays.map(day => weekdayNames[day]).join(', ')}`;
  else if (schedule.type === 'interval') text = `Available every ${schedule.intervalValue} ${schedule.intervalUnit}${schedule.startDate ? ` starting ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(localDateFromKey(schedule.startDate))}` : ''}`;
  else if (schedule.type === 'manual') text = 'Available manually';
  else if (schedule.startDate) text = `Available on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(localDateFromKey(schedule.startDate))}`;
  if (schedule.dueTime) text += ` at ${schedule.dueTime}`;
  if (schedule.paused) text += schedule.pausedUntil ? ` · Paused until ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(localDateFromKey(schedule.pausedUntil))}` : ' · Paused';
  return text;
}

function daysBetween(anchorKey, targetKey) {
  const anchor = localDateFromKey(anchorKey);
  const target = localDateFromKey(targetKey);
  if (!anchor || !target) return NaN;
  return Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / DAY_MS);
}

function weekDifference(anchorKey, targetKey) {
  const anchor = localWeekStart(localDateFromKey(anchorKey));
  const target = localWeekStart(localDateFromKey(targetKey));
  return Math.round((Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / (7 * DAY_MS));
}

export function scheduledOnDate(activity, dateKey) {
  const schedule = normalizeSchedule(activity);
  if (!datePattern.test(String(dateKey))) return false;
  if (schedule.startDate && dateKey < schedule.startDate) return false;
  if (schedule.endDate && dateKey > schedule.endDate) return false;
  const date = localDateFromKey(dateKey);
  if (!date) return false;
  if (schedule.type === 'daily') return true;
  if (schedule.type === 'weekdays') return schedule.weekdays.includes(date.getDay());
  if (schedule.type === 'weekly') return schedule.weekdays.includes(date.getDay());
  if (schedule.type === 'interval') {
    const difference = schedule.intervalUnit === 'weeks' ? weekDifference(schedule.startDate, dateKey) : daysBetween(schedule.startDate, dateKey);
    if (difference < 0 || difference % schedule.intervalValue !== 0) return false;
    if (schedule.intervalUnit === 'weeks') return date.getDay() === localDateFromKey(schedule.startDate)?.getDay();
    return true;
  }
  if (schedule.type === 'one_time') return schedule.startDate ? dateKey === schedule.startDate : true;
  return false;
}

function occurrenceDateForWeekly(activity, todayKey) {
  const schedule = normalizeSchedule(activity);
  const week = localWeekStart(localDateFromKey(todayKey));
  const targetDay = schedule.type === 'interval' ? localDateFromKey(schedule.startDate)?.getDay() : schedule.weekdays[0];
  const offset = ((targetDay ?? 1) + 6) % 7;
  return Core.localDateKey(addLocalDays(week, offset));
}

export function occurrenceKeyForDate(activity, dateKey) {
  const schedule = normalizeSchedule(activity);
  if (schedule.type === 'one_time') return `one:${schedule.startDate || activity.scheduledFor || Core.localDateKey(activity.createdAt) || 'unscheduled'}`;
  if (schedule.type === 'weekly' || (schedule.type === 'interval' && schedule.intervalUnit === 'weeks')) return `week:${Core.localDateKey(localWeekStart(localDateFromKey(dateKey)))}`;
  if (schedule.type === 'manual') return `manual:${activity.manualResetAt || activity.createdAt || activity.id}`;
  return `day:${dateKey}`;
}

function occurrenceRecords(state, activityId) {
  return list(state?.activityOccurrences).filter(record => record.activityId === activityId && !record.undoneAt);
}

function sessionRuns(state, activityId) {
  const output = [];
  for (const plan of list(state?.sessionPlans)) for (const item of list(plan.items)) {
    if (item.activityId !== activityId || !terminalResult(item.status)) continue;
    output.push({ plan, item, at: item.completedAt || plan.completedAt || plan.endedAt });
  }
  return output;
}

function completionKeys(state, activity) {
  const keys = new Set();
  for (const record of occurrenceRecords(state, activity.id)) if (record.status === 'completed') keys.add(record.occurrenceKey);
  for (const run of sessionRuns(state, activity.id)) if (run.item.status === 'completed' && run.at) keys.add(occurrenceKeyForDate(activity, Core.localDateKey(run.at)));
  if (activity.status === 'completed' && activity.completedAt) keys.add(occurrenceKeyForDate(activity, Core.localDateKey(activity.completedAt)));
  return keys;
}

function activeOccurrenceRecord(state, activityId, key, status) {
  return occurrenceRecords(state, activityId).filter(record => record.occurrenceKey === key && (!status || record.status === status)).sort((a, b) => timestamp(b.recordedAt) - timestamp(a.recordedAt))[0] || null;
}

function mostRecentCompletion(state, activity) {
  const values = [];
  if (activity.completedAt) values.push(activity.completedAt);
  occurrenceRecords(state, activity.id).filter(record => record.status === 'completed').forEach(record => values.push(record.completedAt || record.recordedAt));
  sessionRuns(state, activity.id).filter(run => run.item.status === 'completed').forEach(run => values.push(run.at));
  return values.filter(Boolean).sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
}

function periodFor(activity, now) {
  const schedule = normalizeSchedule(activity);
  const today = Core.localDateKey(now);
  if (schedule.type === 'weekly' || (schedule.type === 'interval' && schedule.intervalUnit === 'weeks')) {
    const expectedDate = occurrenceDateForWeekly(activity, today);
    return { expectedDate, key: occurrenceKeyForDate(activity, expectedDate), endsAt: addLocalDays(localWeekStart(now), 7) };
  }
  return { expectedDate: today, key: occurrenceKeyForDate(activity, today), endsAt: addLocalDays(localDateFromKey(today), 1) };
}

function nextScheduledDate(activity, from, { includeToday = true, limitDays = 740 } = {}) {
  const schedule = normalizeSchedule(activity);
  if (schedule.type === 'manual') return null;
  let cursor = localDateFromKey(Core.localDateKey(from));
  if (!includeToday) cursor = addLocalDays(cursor, 1);
  for (let index = 0; index <= limitDays; index += 1) {
    const key = Core.localDateKey(cursor);
    if (scheduledOnDate(activity, key)) return key;
    cursor = addLocalDays(cursor, 1);
  }
  return null;
}

function previousScheduledDate(activity, from, { includeToday = false, limitDays = 740 } = {}) {
  const schedule = normalizeSchedule(activity);
  if (schedule.type === 'manual') return null;
  let cursor = localDateFromKey(Core.localDateKey(from));
  if (!includeToday) cursor = addLocalDays(cursor, -1);
  for (let index = 0; index <= limitDays; index += 1) {
    const key = Core.localDateKey(cursor);
    if (scheduledOnDate(activity, key)) return key;
    cursor = addLocalDays(cursor, -1);
  }
  return null;
}

export function activityAvailability(activity, state = {}, { now = new Date() } = {}) {
  const schedule = normalizeSchedule(activity);
  const today = Core.localDateKey(now);
  const nowDate = Core.localDateTime(now) || new Date();
  const pausedByDate = schedule.pausedUntil && today < schedule.pausedUntil;
  if (schedule.paused || pausedByDate) return { state: 'paused', schedule, occurrenceKey: null, expectedDate: null, nextAvailable: schedule.pausedUntil, lastCompletedAt: mostRecentCompletion(state, activity) };
  if (schedule.startDate && today < schedule.startDate) return { state: 'not_started', schedule, occurrenceKey: null, expectedDate: schedule.startDate, nextAvailable: schedule.startDate, lastCompletedAt: mostRecentCompletion(state, activity) };
  if (schedule.endDate && today > schedule.endDate) return { state: 'expired', schedule, occurrenceKey: null, expectedDate: null, nextAvailable: null, lastCompletedAt: mostRecentCompletion(state, activity) };

  const period = periodFor(activity, nowDate);
  const key = period.key;
  const completed = completionKeys(state, activity).has(key);
  const skipped = activeOccurrenceRecord(state, activity.id, key, 'skipped');
  const snoozed = activeOccurrenceRecord(state, activity.id, key, 'snoozed');
  if (completed || skipped) return { state: 'completed_period', result: completed ? 'completed' : 'skipped', schedule, occurrenceKey: key, expectedDate: period.expectedDate, nextAvailable: nextScheduledDate(activity, addLocalDays(nowDate, 1)), lastCompletedAt: mostRecentCompletion(state, activity), record: skipped };

  if (schedule.type === 'manual') return { state: activity.status === 'completed' ? 'completed_period' : 'manual_available', schedule, occurrenceKey: key, expectedDate: null, nextAvailable: null, lastCompletedAt: mostRecentCompletion(state, activity) };
  if (schedule.type === 'one_time' && !schedule.startDate && schedule.legacyUnscheduled) {
    return { state: activity.status === 'completed' ? 'completed_period' : 'available_now', schedule, occurrenceKey: key, expectedDate: null, nextAvailable: null, lastCompletedAt: mostRecentCompletion(state, activity), optional: true };
  }

  let expectedDate = period.expectedDate;
  let occurs = scheduledOnDate(activity, today);
  if (schedule.type === 'weekly' || (schedule.type === 'interval' && schedule.intervalUnit === 'weeks')) {
    occurs = scheduledOnDate(activity, expectedDate) && today >= expectedDate;
  }
  if (!occurs) {
    const next = nextScheduledDate(activity, nowDate, { includeToday: false });
    const previous = previousScheduledDate(activity, nowDate);
    const previousKey = previous ? occurrenceKeyForDate(activity, previous) : null;
    const previousMissed = previous && previous < today && !completionKeys(state, activity).has(previousKey) && !activeOccurrenceRecord(state, activity.id, previousKey, 'skipped');
    return { state: previousMissed ? 'missed' : 'upcoming', schedule, occurrenceKey: previousMissed ? previousKey : null, expectedDate: previousMissed ? previous : next, nextAvailable: next, lastCompletedAt: mostRecentCompletion(state, activity) };
  }

  if (snoozed?.snoozedUntil && timestamp(snoozed.snoozedUntil) > nowDate.getTime()) return { state: 'upcoming', reason: 'snoozed', schedule, occurrenceKey: key, expectedDate, nextAvailable: snoozed.snoozedUntil, lastCompletedAt: mostRecentCompletion(state, activity), record: snoozed };
  if (schedule.dueTime) {
    const due = localDateFromKey(expectedDate, schedule.dueTime);
    if (due && nowDate < due) return { state: 'due_later_today', schedule, occurrenceKey: key, expectedDate, dueAt: due.toISOString(), nextAvailable: due.toISOString(), lastCompletedAt: mostRecentCompletion(state, activity) };
    return { state: 'due_today', schedule, occurrenceKey: key, expectedDate, dueAt: due?.toISOString() || null, nextAvailable: null, lastCompletedAt: mostRecentCompletion(state, activity) };
  }
  return { state: activity.status === 'in_progress' ? 'available_now' : 'available_now', schedule, occurrenceKey: key, expectedDate, nextAvailable: null, lastCompletedAt: mostRecentCompletion(state, activity), optional: schedule.type === 'manual' || schedule.legacyUnscheduled };
}

export function nextAvailability(activity, state = {}, { now = new Date() } = {}) {
  const availability = activityAvailability(activity, state, { now });
  if (['available_now', 'due_today', 'due_later_today', 'manual_available'].includes(availability.state)) return availability.nextAvailable || availability.expectedDate || Core.localDateKey(now);
  return availability.nextAvailable || nextScheduledDate(activity, now, { includeToday: false });
}

function occurrenceRecord(activity, status, availability, input = {}, { now = new Date(), id } = {}) {
  const recordedAt = Core.isoNow(now);
  return {
    id: id || Core.deterministicId('occurrence', [activity.id, availability.occurrenceKey, status, recordedAt]),
    activityId: activity.id,
    characterId: activity.characterId,
    occurrenceKey: availability.occurrenceKey,
    expectedAt: availability.expectedDate ? localDateFromKey(availability.expectedDate, availability.schedule.dueTime || '00:00')?.toISOString() || null : null,
    status,
    recordedAt,
    notes: String(input.notes || ''),
    ...(status === 'completed' ? { completedAt: input.completedAt || recordedAt } : {}),
    ...(status === 'skipped' ? { skippedAt: recordedAt, reason: String(input.reason || '') } : {}),
    ...(status === 'snoozed' ? { snoozedAt: recordedAt, snoozedUntil: Core.isoNow(input.snoozedUntil) } : {})
  };
}

export function completeCurrentOccurrence(activity, state, input = {}, options = {}) {
  const availability = activityAvailability(activity, state, options);
  if (!availability.occurrenceKey) throw new Error('This activity does not have a current occurrence to complete.');
  if (completionKeys(state, activity).has(availability.occurrenceKey)) return { state: Core.clone(state), record: activeOccurrenceRecord(state, activity.id, availability.occurrenceKey, 'completed'), duplicate: true };
  const output = Core.clone(state); output.activityOccurrences ||= [];
  const record = occurrenceRecord(activity, 'completed', availability, input, options);
  output.activityOccurrences.push(record);
  return { state: output, record, duplicate: false };
}

export function skipCurrentOccurrence(activity, state, input = {}, options = {}) {
  const availability = activityAvailability(activity, state, options);
  if (!availability.occurrenceKey) throw new Error('This activity does not have a current occurrence to skip.');
  const output = Core.clone(state); output.activityOccurrences ||= [];
  const existing = activeOccurrenceRecord(output, activity.id, availability.occurrenceKey, 'skipped');
  if (existing) return { state: output, record: existing, duplicate: true };
  const record = occurrenceRecord(activity, 'skipped', availability, input, options);
  output.activityOccurrences.push(record);
  return { state: output, record, duplicate: false };
}

export function snoozeCurrentOccurrence(activity, state, snoozedUntil, input = {}, options = {}) {
  const until = Core.localDateTime(snoozedUntil);
  const now = Core.localDateTime(options.now || new Date());
  if (!until || !now || until.getTime() <= now.getTime()) throw new Error('Choose a future local date and time.');
  const availability = activityAvailability(activity, state, options);
  if (!availability.occurrenceKey) throw new Error('This activity does not have a current occurrence to snooze.');
  const output = Core.clone(state); output.activityOccurrences ||= [];
  output.activityOccurrences.forEach(record => { if (record.activityId === activity.id && record.occurrenceKey === availability.occurrenceKey && record.status === 'snoozed' && !record.undoneAt) record.undoneAt = Core.isoNow(options.now || new Date()); });
  const record = occurrenceRecord(activity, 'snoozed', availability, { ...input, snoozedUntil: until }, options);
  output.activityOccurrences.push(record);
  return { state: output, record };
}

export function undoOccurrence(state, recordId, { now = new Date() } = {}) {
  const output = Core.clone(state); output.activityOccurrences ||= [];
  const index = output.activityOccurrences.findIndex(record => record.id === recordId && !record.undoneAt);
  if (index < 0) return output;
  output.activityOccurrences[index] = { ...output.activityOccurrences[index], undoneAt: Core.isoNow(now) };
  return output;
}

export function pauseSchedule(activity, { until = null, now = new Date() } = {}) {
  return { ...Core.clone(activity), schedule: { ...normalizeSchedule(activity), legacyUnscheduled: undefined, paused: true, pausedUntil: datePattern.test(String(until || '')) ? until : null }, updatedAt: Core.isoNow(now) };
}

export function resumeSchedule(activity, { now = new Date() } = {}) {
  return { ...Core.clone(activity), schedule: { ...normalizeSchedule(activity), legacyUnscheduled: undefined, paused: false, pausedUntil: null }, updatedAt: Core.isoNow(now) };
}

export function resetManualSchedule(activity, { now = new Date() } = {}) {
  return { ...Core.clone(activity), status: 'todo', completedAt: null, manualResetAt: Core.isoNow(now), updatedAt: Core.isoNow(now) };
}

export function projectUpcoming(state, { now = new Date(), days = 7, characterId = '', category = '', priority = '', scheduleType = '' } = {}) {
  const rosterIds = new Set(list(state?.characters).filter(character => !character.archivedAt).map(character => character.id));
  const output = [];
  for (const activity of list(state?.activities).filter(item => item.kind === 'planned' && rosterIds.has(item.characterId))) {
    if (characterId && activity.characterId !== characterId) continue;
    if (category && activity.category !== category) continue;
    if (priority !== '' && number(activity.priority) !== number(priority)) continue;
    if (scheduleType && normalizeSchedule(activity).type !== scheduleType) continue;
    for (let offset = 0; offset < days; offset += 1) {
      const date = addLocalDays(now, offset); const dateKey = Core.localDateKey(date);
      if (!scheduledOnDate(activity, dateKey)) continue;
      const key = occurrenceKeyForDate(activity, dateKey);
      const complete = completionKeys(state, activity).has(key) || Boolean(activeOccurrenceRecord(state, activity.id, key, 'skipped'));
      output.push({ activity, date: dateKey, occurrenceKey: key, completed: complete, availability: offset === 0 ? activityAvailability(activity, state, { now }) : { state: complete ? 'completed_period' : 'upcoming', schedule: normalizeSchedule(activity), expectedDate: dateKey } });
    }
  }
  return output.sort((a, b) => a.date.localeCompare(b.date) || number(b.activity.priority) - number(a.activity.priority) || String(a.activity.title).localeCompare(String(b.activity.title)));
}

export function selectAgenda(state, filters = {}) {
  const now = filters.now || new Date();
  const roster = list(state?.characters).filter(character => !character.archivedAt);
  const rosterIds = new Set(roster.map(character => character.id));
  const scopeId = filters.scope === 'all' ? '' : filters.characterId || (filters.scope === 'active' || !filters.scope ? state?.activeCharacterId : filters.scope);
  const rows = list(state?.activities).filter(activity => activity.kind === 'planned' && rosterIds.has(activity.characterId)).filter(activity => !scopeId || activity.characterId === scopeId).map(activity => ({ activity, availability: activityAvailability(activity, state, { now }) })).filter(row => {
    if (filters.category && row.activity.category !== filters.category) return false;
    if (filters.priority !== '' && filters.priority !== undefined && number(row.activity.priority) !== number(filters.priority)) return false;
    if (filters.scheduleType && row.availability.schedule.type !== filters.scheduleType) return false;
    if (filters.completionState === 'completed' && row.availability.state !== 'completed_period') return false;
    if (filters.completionState === 'available' && !['available_now', 'due_today', 'due_later_today', 'manual_available'].includes(row.availability.state)) return false;
    if (filters.completionState === 'missed' && row.availability.state !== 'missed') return false;
    if (filters.completionState === 'upcoming' && !['upcoming', 'not_started'].includes(row.availability.state)) return false;
    if (filters.completionState === 'paused' && row.availability.state !== 'paused') return false;
    return true;
  });
  const sortRows = values => values.sort((a, b) => (a.activity.status === 'in_progress' ? 0 : 1) - (b.activity.status === 'in_progress' ? 0 : 1) || number(b.activity.priority) - number(a.activity.priority) || String(a.activity.title).localeCompare(String(b.activity.title)));
  const groups = {
    inProgress: sortRows(rows.filter(row => row.activity.status === 'in_progress' && !['paused', 'expired'].includes(row.availability.state))),
    dueNow: sortRows(rows.filter(row => row.availability.state === 'due_today')),
    availableToday: sortRows(rows.filter(row => ['available_now', 'due_later_today'].includes(row.availability.state) && !row.availability.optional && row.activity.status !== 'in_progress')),
    optional: sortRows(rows.filter(row => ['manual_available', 'available_now'].includes(row.availability.state) && row.availability.optional && row.activity.status !== 'in_progress')),
    completedToday: sortRows(rows.filter(row => row.availability.state === 'completed_period' && (row.availability.expectedDate === Core.localDateKey(now) || Core.localDateKey(row.availability.lastCompletedAt) === Core.localDateKey(now)))),
    needsAttention: sortRows(rows.filter(row => row.availability.state === 'missed')),
    upcoming: filters.completionState && filters.completionState !== 'upcoming' ? [] : projectUpcoming(state, { now, days: 7, characterId: scopeId, category: filters.category, priority: filters.priority, scheduleType: filters.scheduleType }).filter(item => item.date > Core.localDateKey(now) && !item.completed)
  };
  return { rows, groups };
}

export function selectRunHistory(state, activityId) {
  const activity = list(state?.activities).find(item => item.id === activityId);
  if (!activity) return [];
  const characters = new Map(list(state?.characters).map(character => [character.id, character]));
  const output = [];
  for (const run of sessionRuns(state, activityId)) output.push({
    id: `session:${run.plan.id}:${run.item.id}`, activityId, characterId: run.item.characterId, character: characters.get(run.item.characterId) || null,
    status: run.item.status, occurredAt: run.at, actualMinutes: number(run.item.actualMinutes), goldEarned: number(run.item.goldEarned), goldSpent: number(run.item.goldSpent),
    progressMetric: run.item.progressMetric, progressGained: number(run.item.progressGained), notes: run.item.resultNotes, sourceSessionId: run.plan.id, sourceSessionTitle: run.plan.title, correctedAt: run.plan.updatedAt
  });
  for (const record of list(state?.activityOccurrences).filter(item => item.activityId === activityId)) output.push({
    id: record.id, activityId, characterId: record.characterId, character: characters.get(record.characterId) || null, status: record.undoneAt ? 'undone' : record.status,
    occurredAt: record.completedAt || record.skippedAt || record.snoozedAt || record.recordedAt, actualMinutes: number(record.actualMinutes), goldEarned: number(record.goldEarned), goldSpent: number(record.goldSpent),
    progressMetric: record.progressMetric || '', progressGained: number(record.progressGained), notes: record.notes || record.reason || '', occurrenceKey: record.occurrenceKey, undoneAt: record.undoneAt || null
  });
  return output.filter(item => item.occurredAt).sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt) || String(a.id).localeCompare(String(b.id)));
}

export function agendaToSessionPlan(state, activityIds, { budgetMinutes = Infinity, now = new Date() } = {}) {
  const selected = new Set(list(activityIds));
  const eligible = selectAgenda(state, { scope: 'all', now }).rows.filter(row => selected.has(row.activity.id) && ['available_now', 'due_today', 'due_later_today', 'manual_available'].includes(row.availability.state));
  const sorted = eligible.sort((a, b) => (a.activity.status === 'in_progress' ? 0 : 1) - (b.activity.status === 'in_progress' ? 0 : 1) || (a.availability.state === 'due_today' ? 0 : 1) - (b.availability.state === 'due_today' ? 0 : 1) || number(b.activity.priority) - number(a.activity.priority));
  const items = []; let totalMinutes = 0;
  for (const row of sorted) {
    const minutes = Math.max(1, number(row.activity.estimatedMinutes, 30));
    if (totalMinutes + minutes > number(budgetMinutes, Infinity) + 5) continue;
    items.push({ activity: row.activity, locked: true, reason: row.availability.state === 'due_today' ? 'Due today' : 'Selected from Daily Agenda' }); totalMinutes += minutes;
  }
  return { budgetMinutes: Number.isFinite(Number(budgetMinutes)) ? Number(budgetMinutes) : totalMinutes, totalMinutes, items, characterIds: [...new Set(items.map(item => item.activity.characterId))], categories: [...new Set(items.map(item => item.activity.category))] };
}

export function commandCenterTodaySummary(state, { now = new Date(), characterId = state?.activeCharacterId } = {}) {
  const agenda = selectAgenda(state, { scope: characterId, now });
  const available = [...agenda.groups.inProgress, ...agenda.groups.dueNow, ...agenda.groups.availableToday, ...agenda.groups.optional];
  const upcoming = agenda.groups.upcoming[0] || null;
  return {
    availableCount: available.length,
    completedCount: agenda.groups.completedToday.length,
    estimatedMinutes: available.reduce((sum, row) => sum + number(row.activity.estimatedMinutes), 0),
    highestPriority: [...available].sort((a, b) => number(b.activity.priority) - number(a.activity.priority))[0] || null,
    nextScheduled: upcoming
  };
}

export const ScheduleEngine = Object.freeze({
  SCHEDULE_TYPES, INTERVAL_UNITS, OCCURRENCE_STATUSES, AVAILABILITY_STATES,
  localDateFromKey, addLocalDays, localWeekStart, normalizeSchedule, validateSchedule,
  scheduleDescription, scheduledOnDate, occurrenceKeyForDate, activityAvailability,
  nextAvailability, completeCurrentOccurrence, skipCurrentOccurrence, snoozeCurrentOccurrence,
  undoOccurrence, pauseSchedule, resumeSchedule, resetManualSchedule, projectUpcoming,
  selectAgenda, selectRunHistory, agendaToSessionPlan, commandCenterTodaySummary
});

globalThis.AzerothSchedule = ScheduleEngine;
