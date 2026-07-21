/*
 * Persistence and domain foundation for the Azeroth Campaign Dashboard.
 * This module is deliberately framework-free so it can run in the browser
 * and in Node's test runner.
 */

export const V1_STORAGE_KEY = 'azeroth-command-center-v1';
export const V2_STORAGE_KEY = 'azeroth-command-center-v2';
export const V1_RECOVERY_KEY = 'azeroth-command-center-v1-recovery';
export const V2_RECOVERY_KEY = 'azeroth-command-center-v2-recovery';
export const V2_SCHEMA_VERSION = 2;

export const COLLECTION_NAMES = ['Achievements', 'Mounts', 'Pets', 'Toys', 'Appearances', 'Reputations'];
export const PLANNED_ACTIVITY_CATEGORIES = ['Campaign', 'Weekly', 'Gold', 'Reputation', 'Professions', 'Mounts', 'Transmog', 'Achievements', 'Events', 'Custom'];
export const PLANNED_ACTIVITY_STATUSES = ['todo', 'in_progress', 'completed', 'skipped'];
export const PLANNED_ACTIVITY_REPEAT_TYPES = ['one_time', 'daily', 'weekly', 'weekdays', 'interval', 'manual'];

const KNOWN_CHARACTER_FIELDS = new Set([
  'id', 'name', 'realm', 'region', 'faction', 'race', 'raceId', 'className', 'classId', 'spec',
  'professions', 'level', 'gold', 'playedMinutes', 'location', 'campaignRole', 'createdAt', 'archivedAt', 'legacy', 'extensions'
]);

const KNOWN_GOAL_FIELDS = new Set([
  'id', 'characterId', 'scope', 'type', 'category', 'title', 'done', 'status', 'priority', 'dueDate',
  'recurrence', 'estimatedMinutes', 'createdAt', 'completedAt', 'order', 'legacy', 'extensions'
]);

const KNOWN_SESSION_FIELDS = new Set(['id', 'date', 'timestamp', 'occurredAt', 'minutes', 'durationMinutes', 'goldDelta', 'note', 'title', 'legacy', 'extensions']);
const KNOWN_LEDGER_FIELDS = new Set(['id', 'date', 'timestamp', 'occurredAt', 'activity', 'minutes', 'revenue', 'cost', 'notes', 'legacy', 'extensions']);
const KNOWN_COLLECTION_FIELDS = new Set(['id', 'owned', 'target', 'baseline', 'legacy', 'extensions']);
const KNOWN_TOP_LEVEL_FIELDS = new Set(['version', 'activeId', 'characters', 'preferences', 'migration', 'schemaVersion', 'activeCharacterId', 'goals', 'activities', 'progressEvents', 'collectionTrackers', 'sessionPlans', 'activityOccurrences', 'recommendationHistory', 'legacy', 'extensions']);

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function isFiniteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

export function asNumber(value, fallback = 0, limits = {}) {
  return isFiniteNumber(value, limits) ? Number(value) : fallback;
}

export function localDateKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = part => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isoNow(value = new Date()) {
  const date = localDateTime(value);
  return date ? date.toISOString() : new Date().toISOString();
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function deterministicId(prefix, parts) {
  const normalized = Array.isArray(parts) ? parts : [parts];
  return `${prefix}-${hashString(JSON.stringify(normalized))}`;
}

export function createId(prefix = 'id') {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `${prefix}-${randomId}` : deterministicId(prefix, [Date.now(), Math.random()]);
}

function unknownFields(value, knownFields) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !knownFields.has(key)));
}

function mergeLegacy(existing, unknown) {
  const legacy = isPlainObject(existing) ? clone(existing) : {};
  if (Object.keys(unknown).length) legacy.legacyFields = { ...(legacy.legacyFields || {}), ...clone(unknown) };
  return Object.keys(legacy).length ? legacy : undefined;
}

function validDateValue(value) {
  return typeof value === 'string' && value.length > 0 && localDateTime(value) !== null;
}

function addError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateCharacter(character, index, errors) {
  const path = `characters[${index}]`;
  if (!isPlainObject(character)) {
    addError(errors, path, 'must be an object');
    return;
  }
  if (typeof character.id !== 'string' || !character.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  for (const field of ['name', 'realm', 'region', 'faction', 'race', 'className', 'spec', 'location']) {
    if (typeof character[field] !== 'string') addError(errors, `${path}.${field}`, 'must be a string');
  }
  if (!isFiniteNumber(character.level, { min: 1, max: 100 })) addError(errors, `${path}.level`, 'must be a number from 1 to 100');
  if (!isFiniteNumber(character.gold, { min: 0 })) addError(errors, `${path}.gold`, 'must be a non-negative number');
  if (!isFiniteNumber(character.playedMinutes, { min: 0 })) addError(errors, `${path}.playedMinutes`, 'must be a non-negative number');
  if (!validDateValue(character.createdAt)) addError(errors, `${path}.createdAt`, 'must be a valid date or timestamp');
  if (character.professions !== undefined && !Array.isArray(character.professions) && typeof character.professions !== 'string') addError(errors, `${path}.professions`, 'must be a string or array');
  if (character.campaignRole !== undefined && !['main', 'active_alt', 'occasional', 'resting'].includes(character.campaignRole)) addError(errors, `${path}.campaignRole`, 'has an unknown campaign role');
}

function validateGoal(goal, index, errors) {
  const path = `goals[${index}]`;
  if (!isPlainObject(goal)) {
    addError(errors, path, 'must be an object');
    return;
  }
  if (typeof goal.id !== 'string' || !goal.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  if (typeof goal.title !== 'string' || !goal.title) addError(errors, `${path}.title`, 'must be a non-empty string');
  if (typeof goal.characterId !== 'string' || !goal.characterId) addError(errors, `${path}.characterId`, 'must identify a character');
  if (!['character', 'account'].includes(goal.scope)) addError(errors, `${path}.scope`, 'must be character or account');
  if (!['todo', 'in_progress', 'done', 'dismissed'].includes(goal.status)) addError(errors, `${path}.status`, 'has an unknown status');
  if (!isFiniteNumber(goal.priority)) addError(errors, `${path}.priority`, 'must be numeric');
  for (const field of ['createdAt']) if (!validDateValue(goal[field])) addError(errors, `${path}.${field}`, 'must be a valid date or timestamp');
  if (goal.completedAt !== null && goal.completedAt !== undefined && !validDateValue(goal.completedAt)) addError(errors, `${path}.completedAt`, 'must be null or a valid date');
}

function validateActivity(activity, index, errors) {
  const path = `activities[${index}]`;
  if (!isPlainObject(activity)) {
    addError(errors, path, 'must be an object');
    return;
  }
  if (typeof activity.id !== 'string' || !activity.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  if (typeof activity.characterId !== 'string' || !activity.characterId) addError(errors, `${path}.characterId`, 'must identify a character');
  if (!['session', 'gold', 'collection', 'note', 'planned'].includes(activity.kind)) addError(errors, `${path}.kind`, 'has an unknown activity type');
  if (activity.kind === 'planned') {
    if (typeof activity.title !== 'string' || !activity.title.trim()) addError(errors, `${path}.title`, 'must be a non-empty string');
    if (typeof activity.description !== 'string') addError(errors, `${path}.description`, 'must be a string');
    if (!PLANNED_ACTIVITY_CATEGORIES.includes(activity.category)) addError(errors, `${path}.category`, 'has an unknown category');
    if (!isFiniteNumber(activity.priority, { min: 0, max: 3 })) addError(errors, `${path}.priority`, 'must be a number from 0 to 3');
    if (!PLANNED_ACTIVITY_STATUSES.includes(activity.status)) addError(errors, `${path}.status`, 'has an unknown status');
    if (!isFiniteNumber(activity.estimatedMinutes, { min: 1 })) addError(errors, `${path}.estimatedMinutes`, 'must be a positive number');
    if (!PLANNED_ACTIVITY_REPEAT_TYPES.includes(activity.repeatType)) addError(errors, `${path}.repeatType`, 'has an unknown repeat type');
    if (!Array.isArray(activity.tags) || activity.tags.some(tag => typeof tag !== 'string')) addError(errors, `${path}.tags`, 'must be an array of strings');
    if (typeof activity.notes !== 'string') addError(errors, `${path}.notes`, 'must be a string');
    if (!validDateValue(activity.createdAt)) addError(errors, `${path}.createdAt`, 'must be a valid date or timestamp');
    if (!validDateValue(activity.updatedAt)) addError(errors, `${path}.updatedAt`, 'must be a valid date or timestamp');
    if (activity.completedAt !== null && activity.completedAt !== undefined && !validDateValue(activity.completedAt)) addError(errors, `${path}.completedAt`, 'must be null or a valid date');
    if (activity.scheduledFor !== null && activity.scheduledFor !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(activity.scheduledFor)) addError(errors, `${path}.scheduledFor`, 'must be null or a local date');
    if (activity.schedule !== undefined) {
      const schedulePath = `${path}.schedule`;
      if (!isPlainObject(activity.schedule)) addError(errors, schedulePath, 'must be an object');
      else {
        if (!['one_time', 'daily', 'weekly', 'weekdays', 'interval', 'manual'].includes(activity.schedule.type)) addError(errors, `${schedulePath}.type`, 'has an unknown schedule type');
        for (const field of ['startDate', 'endDate', 'pausedUntil']) if (activity.schedule[field] !== null && activity.schedule[field] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(activity.schedule[field])) addError(errors, `${schedulePath}.${field}`, 'must be null or a local date');
        if (activity.schedule.dueTime !== null && activity.schedule.dueTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(activity.schedule.dueTime)) addError(errors, `${schedulePath}.dueTime`, 'must be null or a local time');
        if (!Array.isArray(activity.schedule.weekdays) || activity.schedule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) addError(errors, `${schedulePath}.weekdays`, 'must contain local weekday numbers from 0 to 6');
        if (!isFiniteNumber(activity.schedule.intervalValue, { min: 1 })) addError(errors, `${schedulePath}.intervalValue`, 'must be positive');
        if (!['days', 'weeks'].includes(activity.schedule.intervalUnit)) addError(errors, `${schedulePath}.intervalUnit`, 'must be days or weeks');
        if (activity.schedule.timezoneMode !== 'local') addError(errors, `${schedulePath}.timezoneMode`, 'must be local');
        if (!isFiniteNumber(activity.schedule.graceMinutes, { min: 0 })) addError(errors, `${schedulePath}.graceMinutes`, 'must be non-negative');
        if (typeof activity.schedule.paused !== 'boolean') addError(errors, `${schedulePath}.paused`, 'must be boolean');
      }
    }
    if (activity.manualResetAt !== undefined && !validDateValue(activity.manualResetAt)) addError(errors, `${path}.manualResetAt`, 'must be a timestamp');
    if (activity.blockedAt !== undefined && activity.blockedAt !== null && !validDateValue(activity.blockedAt)) addError(errors, `${path}.blockedAt`, 'must be null or a timestamp');
    if (activity.blockedReason !== undefined && typeof activity.blockedReason !== 'string') addError(errors, `${path}.blockedReason`, 'must be a string');
  } else {
    if (!validDateValue(activity.occurredAt)) addError(errors, `${path}.occurredAt`, 'must be a valid date or timestamp');
    if (!isFiniteNumber(activity.durationMinutes, { min: 0 })) addError(errors, `${path}.durationMinutes`, 'must be a non-negative number');
  }
  if (activity.gold !== undefined) {
    if (!isPlainObject(activity.gold)) addError(errors, `${path}.gold`, 'must be an object');
    else {
      for (const field of ['revenue', 'cost', 'delta']) if (!isFiniteNumber(activity.gold[field])) addError(errors, `${path}.gold.${field}`, 'must be numeric');
      if (typeof activity.gold.affectsBalance !== 'boolean') addError(errors, `${path}.gold.affectsBalance`, 'must be boolean');
    }
  }
}

function validateActivityOccurrence(record, index, errors) {
  const path = `activityOccurrences[${index}]`;
  if (!isPlainObject(record)) { addError(errors, path, 'must be an object'); return; }
  for (const field of ['id', 'activityId', 'characterId', 'occurrenceKey']) if (typeof record[field] !== 'string' || !record[field]) addError(errors, `${path}.${field}`, 'must be a non-empty string');
  if (!['completed', 'skipped', 'snoozed', 'reset'].includes(record.status)) addError(errors, `${path}.status`, 'has an unknown occurrence status');
  if (!validDateValue(record.recordedAt)) addError(errors, `${path}.recordedAt`, 'must be a timestamp');
  for (const field of ['expectedAt', 'completedAt', 'skippedAt', 'snoozedAt', 'snoozedUntil', 'undoneAt']) if (record[field] !== null && record[field] !== undefined && !validDateValue(record[field])) addError(errors, `${path}.${field}`, 'must be null or a timestamp');
  if (record.notes !== undefined && typeof record.notes !== 'string') addError(errors, `${path}.notes`, 'must be a string');
  if (record.reason !== undefined && typeof record.reason !== 'string') addError(errors, `${path}.reason`, 'must be a string');
}

function validateRecommendationHistory(record, index, errors) {
  const path = `recommendationHistory[${index}]`;
  if (!isPlainObject(record)) { addError(errors, path, 'must be an object'); return; }
  for (const field of ['id', 'entityId', 'recommendationType']) if (typeof record[field] !== 'string' || !record[field]) addError(errors, `${path}.${field}`, 'must be a non-empty string');
  if (record.characterId !== null && record.characterId !== undefined && typeof record.characterId !== 'string') addError(errors, `${path}.characterId`, 'must be null or a string');
  if (!validDateValue(record.firstShownAt)) addError(errors, `${path}.firstShownAt`, 'must be a timestamp');
  if (!validDateValue(record.lastShownAt)) addError(errors, `${path}.lastShownAt`, 'must be a timestamp');
  if (!Number.isInteger(record.timesShown) || record.timesShown < 1) addError(errors, `${path}.timesShown`, 'must be a positive integer');
  if (record.lastUserResponse !== null && record.lastUserResponse !== undefined && !['opened', 'started', 'completed', 'skipped', 'dismissed', 'snoozed', 'ignored', 'useful', 'not_useful', 'not_today'].includes(record.lastUserResponse)) addError(errors, `${path}.lastUserResponse`, 'has an unknown response');
  if (record.dismissedUntil !== null && record.dismissedUntil !== undefined && !validDateValue(record.dismissedUntil)) addError(errors, `${path}.dismissedUntil`, 'must be null or a timestamp');
}

function validateProgressEvent(event, index, errors) {
  const path = `progressEvents[${index}]`;
  if (!isPlainObject(event)) {
    addError(errors, path, 'must be an object');
    return;
  }
  if (typeof event.id !== 'string' || !event.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  if (!['account', 'character'].includes(event.entityType)) addError(errors, `${path}.entityType`, 'must be account or character');
  if (typeof event.entityId !== 'string' || !event.entityId) addError(errors, `${path}.entityId`, 'must identify an entity');
  if (typeof event.metric !== 'string' || !event.metric) addError(errors, `${path}.metric`, 'must be a non-empty string');
  if (!isFiniteNumber(event.value)) addError(errors, `${path}.value`, 'must be numeric');
  if (!validDateValue(event.recordedAt)) addError(errors, `${path}.recordedAt`, 'must be a valid date or timestamp');
}

function validateCollectionTracker(tracker, index, errors) {
  const path = `collectionTrackers[${index}]`;
  if (!isPlainObject(tracker)) {
    addError(errors, path, 'must be an object');
    return;
  }
  if (typeof tracker.id !== 'string' || !tracker.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  if (tracker.scope !== 'character') addError(errors, `${path}.scope`, 'must remain character-scoped in schema v2');
  if (typeof tracker.characterId !== 'string' || !tracker.characterId) addError(errors, `${path}.characterId`, 'must identify a character');
  if (typeof tracker.name !== 'string' || !tracker.name) addError(errors, `${path}.name`, 'must be a non-empty string');
  for (const field of ['owned', 'target', 'baseline']) if (!isFiniteNumber(tracker[field], { min: 0 })) addError(errors, `${path}.${field}`, 'must be a non-negative number');
}

function validateSessionPlan(plan, index, errors) {
  const path = `sessionPlans[${index}]`;
  if (!isPlainObject(plan)) { addError(errors, path, 'must be an object'); return; }
  if (typeof plan.id !== 'string' || !plan.id) addError(errors, `${path}.id`, 'must be a non-empty string');
  if (typeof plan.title !== 'string' || !plan.title.trim()) addError(errors, `${path}.title`, 'must be a non-empty string');
  if (!['draft', 'ready', 'in_progress', 'paused', 'completed', 'abandoned'].includes(plan.status)) addError(errors, `${path}.status`, 'has an unknown status');
  if (!Array.isArray(plan.characterIds) || plan.characterIds.some(id => typeof id !== 'string' || !id)) addError(errors, `${path}.characterIds`, 'must be an array of character ids');
  if (!Array.isArray(plan.items)) addError(errors, `${path}.items`, 'must be an array');
  else plan.items.forEach((item, itemIndex) => {
    const itemPath = `${path}.items[${itemIndex}]`;
    if (!isPlainObject(item)) { addError(errors, itemPath, 'must be an object'); return; }
    if (typeof item.id !== 'string' || !item.id) addError(errors, `${itemPath}.id`, 'must be a non-empty string');
    if (item.activityId !== null && item.activityId !== undefined && typeof item.activityId !== 'string') addError(errors, `${itemPath}.activityId`, 'must be null or a string');
    if (typeof item.characterId !== 'string' || !item.characterId) addError(errors, `${itemPath}.characterId`, 'must identify a character');
    if (!isPlainObject(item.snapshot) || typeof item.snapshot.title !== 'string' || typeof item.snapshot.category !== 'string' || typeof item.snapshot.characterId !== 'string' || typeof item.snapshot.repeatType !== 'string') addError(errors, `${itemPath}.snapshot`, 'must preserve title, category, character, and repeat type');
    if (!['pending', 'current', 'completed', 'skipped', 'partial'].includes(item.status)) addError(errors, `${itemPath}.status`, 'has an unknown status');
    if (!isFiniteNumber(item.order, { min: 0 })) addError(errors, `${itemPath}.order`, 'must be non-negative');
    if (typeof item.locked !== 'boolean') addError(errors, `${itemPath}.locked`, 'must be boolean');
    for (const field of ['plannedMinutes']) if (!isFiniteNumber(item[field], { min: 1 })) addError(errors, `${itemPath}.${field}`, 'must be positive');
    for (const field of ['actualMinutes', 'goldEarned', 'goldSpent']) if (!isFiniteNumber(item[field], { min: 0 })) addError(errors, `${itemPath}.${field}`, 'must be non-negative');
    if (!isFiniteNumber(item.progressGained)) addError(errors, `${itemPath}.progressGained`, 'must be numeric');
    if (typeof item.resultNotes !== 'string' || typeof item.progressMetric !== 'string') addError(errors, itemPath, 'result notes and progress metric must be strings');
    if (typeof item.completeUnderlying !== 'boolean' || typeof item.unplanned !== 'boolean') addError(errors, itemPath, 'completion and unplanned flags must be boolean');
    for (const field of ['startedAt', 'completedAt']) if (item[field] !== null && item[field] !== undefined && !validDateValue(item[field])) addError(errors, `${itemPath}.${field}`, 'must be null or a timestamp');
  });
  if (!isFiniteNumber(plan.totalEstimatedMinutes, { min: 0 })) addError(errors, `${path}.totalEstimatedMinutes`, 'must be non-negative');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plan.plannedFor || ''))) addError(errors, `${path}.plannedFor`, 'must be a local date');
  for (const field of ['createdAt', 'updatedAt']) if (!validDateValue(plan[field])) addError(errors, `${path}.${field}`, 'must be a timestamp');
  for (const field of ['startedAt', 'completedAt', 'endedAt', 'activeStartedAt', 'pausedAt']) if (plan[field] !== null && plan[field] !== undefined && !validDateValue(plan[field])) addError(errors, `${path}.${field}`, 'must be null or a timestamp');
  if (!isFiniteNumber(plan.accumulatedMs, { min: 0 })) addError(errors, `${path}.accumulatedMs`, 'must be non-negative');
  if (plan.currentItemId !== null && plan.currentItemId !== undefined && typeof plan.currentItemId !== 'string') addError(errors, `${path}.currentItemId`, 'must be null or a string');
  if (typeof plan.notes !== 'string') addError(errors, `${path}.notes`, 'must be a string');
  if (plan.reconciliation !== null && plan.reconciliation !== undefined && !isPlainObject(plan.reconciliation)) addError(errors, `${path}.reconciliation`, 'must be null or an object');
}

export function validateV2State(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['state: must be an object'] };
  if (input.schemaVersion !== V2_SCHEMA_VERSION) addError(errors, 'schemaVersion', `must equal ${V2_SCHEMA_VERSION}`);
  if (typeof input.activeCharacterId !== 'string' || !input.activeCharacterId) addError(errors, 'activeCharacterId', 'must be a non-empty string');
  if (!isPlainObject(input.preferences)) addError(errors, 'preferences', 'must be an object');
  if (!Array.isArray(input.characters) || !input.characters.length) addError(errors, 'characters', 'must be a non-empty array');
  else input.characters.forEach((character, index) => validateCharacter(character, index, errors));
  if (!Array.isArray(input.goals)) addError(errors, 'goals', 'must be an array');
  else input.goals.forEach((goal, index) => validateGoal(goal, index, errors));
  if (!Array.isArray(input.activities)) addError(errors, 'activities', 'must be an array');
  else input.activities.forEach((activity, index) => validateActivity(activity, index, errors));
  if (!Array.isArray(input.progressEvents)) addError(errors, 'progressEvents', 'must be an array');
  else input.progressEvents.forEach((event, index) => validateProgressEvent(event, index, errors));
  if (!Array.isArray(input.collectionTrackers)) addError(errors, 'collectionTrackers', 'must be an array');
  else input.collectionTrackers.forEach((tracker, index) => validateCollectionTracker(tracker, index, errors));
  if (input.sessionPlans !== undefined && !Array.isArray(input.sessionPlans)) addError(errors, 'sessionPlans', 'must be an array when present');
  else (input.sessionPlans || []).forEach((plan, index) => validateSessionPlan(plan, index, errors));
  if ((input.sessionPlans || []).filter(plan => plan?.status === 'in_progress').length > 1) addError(errors, 'sessionPlans', 'cannot contain more than one running session');
  if (input.activityOccurrences !== undefined && !Array.isArray(input.activityOccurrences)) addError(errors, 'activityOccurrences', 'must be an array when present');
  else (input.activityOccurrences || []).forEach((record, index) => validateActivityOccurrence(record, index, errors));
  if (input.recommendationHistory !== undefined && !Array.isArray(input.recommendationHistory)) addError(errors, 'recommendationHistory', 'must be an array when present');
  else (input.recommendationHistory || []).forEach((record, index) => validateRecommendationHistory(record, index, errors));
  if (!isPlainObject(input.migration)) addError(errors, 'migration', 'must be an object');
  else {
    if (!Number.isInteger(input.migration.sourceVersion)) addError(errors, 'migration.sourceVersion', 'must be an integer');
    if (input.migration.targetVersion !== V2_SCHEMA_VERSION) addError(errors, 'migration.targetVersion', `must equal ${V2_SCHEMA_VERSION}`);
    if (!validDateValue(input.migration.migratedAt)) addError(errors, 'migration.migratedAt', 'must be a valid date or timestamp');
  }
  if (input.characters?.length && input.activeCharacterId && !input.characters.some(character => character.id === input.activeCharacterId)) addError(errors, 'activeCharacterId', 'must reference an existing character');
  return { ok: errors.length === 0, errors };
}

function migrateCharacter(rawCharacter, index, nowIsoValue) {
  const characterId = typeof rawCharacter?.id === 'string' && rawCharacter.id ? rawCharacter.id : deterministicId('character', [index, rawCharacter?.name, rawCharacter?.realm]);
  const unknown = unknownFields(rawCharacter, KNOWN_CHARACTER_FIELDS);
  return {
    ...clone(unknown),
    id: characterId,
    name: typeof rawCharacter?.name === 'string' ? rawCharacter.name : `Character ${index + 1}`,
    realm: typeof rawCharacter?.realm === 'string' ? rawCharacter.realm : 'Unknown realm',
    region: typeof rawCharacter?.region === 'string' ? rawCharacter.region : 'EU',
    faction: typeof rawCharacter?.faction === 'string' ? rawCharacter.faction : 'Alliance',
    race: typeof rawCharacter?.race === 'string' ? rawCharacter.race : 'Unknown race',
    className: typeof rawCharacter?.className === 'string' ? rawCharacter.className : 'Adventurer',
    spec: typeof rawCharacter?.spec === 'string' ? rawCharacter.spec : '',
    professions: rawCharacter?.professions ?? '',
    level: asNumber(rawCharacter?.level, 1, { min: 1, max: 100 }),
    gold: asNumber(rawCharacter?.gold, 0, { min: 0 }),
    playedMinutes: asNumber(rawCharacter?.playedMinutes, 0, { min: 0 }),
    location: typeof rawCharacter?.location === 'string' ? rawCharacter.location : '',
    ...(['main', 'active_alt', 'occasional', 'resting'].includes(rawCharacter?.campaignRole) ? { campaignRole: rawCharacter.campaignRole } : {}),
    createdAt: validDateValue(rawCharacter?.createdAt) ? rawCharacter.createdAt : nowIsoValue,
    ...(mergeLegacy(rawCharacter?.legacy, unknown) ? { legacy: mergeLegacy(rawCharacter?.legacy, unknown) } : {})
  };
}

function migrateGoal(rawGoal, characterId, characterIndex, goalIndex, fallbackDate) {
  const id = typeof rawGoal?.id === 'string' && rawGoal.id ? rawGoal.id : deterministicId('goal', [characterId, characterIndex, goalIndex, rawGoal?.type, rawGoal?.title]);
  const unknown = unknownFields(rawGoal, KNOWN_GOAL_FIELDS);
  const done = rawGoal?.done === true || rawGoal?.status === 'done';
  return {
    ...clone(unknown),
    id,
    characterId,
    scope: 'character',
    category: typeof rawGoal?.category === 'string' ? rawGoal.category : (typeof rawGoal?.type === 'string' ? rawGoal.type : 'Personal'),
    title: typeof rawGoal?.title === 'string' ? rawGoal.title : 'Untitled objective',
    status: done ? 'done' : 'todo',
    priority: asNumber(rawGoal?.priority, 0),
    dueDate: rawGoal?.dueDate ?? null,
    recurrence: rawGoal?.recurrence ?? null,
    estimatedMinutes: rawGoal?.estimatedMinutes ?? null,
    createdAt: validDateValue(rawGoal?.createdAt) ? rawGoal.createdAt : fallbackDate,
    completedAt: done ? (validDateValue(rawGoal?.completedAt) ? rawGoal.completedAt : fallbackDate) : null,
    order: Number.isFinite(Number(rawGoal?.order)) ? Number(rawGoal.order) : characterIndex + goalIndex,
    ...(mergeLegacy(rawGoal?.legacy, unknown) ? { legacy: mergeLegacy(rawGoal?.legacy, unknown) } : {})
  };
}

function migrateSession(rawSession, characterId, characterIndex, sessionIndex, fallbackDate) {
  const id = typeof rawSession?.id === 'string' && rawSession.id ? rawSession.id : deterministicId('activity-session', [characterId, characterIndex, sessionIndex, rawSession?.date, rawSession?.minutes, rawSession?.goldDelta, rawSession?.note]);
  const unknown = unknownFields(rawSession, KNOWN_SESSION_FIELDS);
  return {
    ...clone(unknown),
    id,
    characterId,
    kind: 'session',
    occurredAt: rawSession?.occurredAt ?? rawSession?.timestamp ?? rawSession?.date ?? fallbackDate,
    durationMinutes: asNumber(rawSession?.durationMinutes ?? rawSession?.minutes, 0, { min: 0 }),
    title: typeof rawSession?.title === 'string' ? rawSession.title : 'Play session',
    notes: typeof rawSession?.notes === 'string' ? rawSession.notes : (typeof rawSession?.note === 'string' ? rawSession.note : ''),
    gold: { revenue: 0, cost: 0, delta: asNumber(rawSession?.goldDelta, 0), affectsBalance: true },
    source: 'legacy-v1',
    ...(mergeLegacy(rawSession?.legacy, unknown) ? { legacy: mergeLegacy(rawSession?.legacy, unknown) } : {})
  };
}

function migrateLedgerEntry(rawEntry, characterId, characterIndex, entryIndex, fallbackDate) {
  const id = typeof rawEntry?.id === 'string' && rawEntry.id ? rawEntry.id : deterministicId('activity-gold', [characterId, characterIndex, entryIndex, rawEntry?.date, rawEntry?.activity, rawEntry?.revenue, rawEntry?.cost]);
  const unknown = unknownFields(rawEntry, KNOWN_LEDGER_FIELDS);
  return {
    ...clone(unknown),
    id,
    characterId,
    kind: 'gold',
    occurredAt: rawEntry?.occurredAt ?? rawEntry?.timestamp ?? rawEntry?.date ?? fallbackDate,
    durationMinutes: asNumber(rawEntry?.minutes, 0, { min: 0 }),
    title: typeof rawEntry?.activity === 'string' ? rawEntry.activity : 'Gold activity',
    notes: typeof rawEntry?.notes === 'string' ? rawEntry.notes : '',
    gold: {
      revenue: asNumber(rawEntry?.revenue, 0, { min: 0 }),
      cost: asNumber(rawEntry?.cost, 0, { min: 0 }),
      delta: 0,
      affectsBalance: false
    },
    source: 'legacy-v1',
    ...(mergeLegacy(rawEntry?.legacy, unknown) ? { legacy: mergeLegacy(rawEntry?.legacy, unknown) } : {})
  };
}

function migrateSnapshot(rawSnapshot, characterId, characterIndex, snapshotIndex) {
  const recordedAt = rawSnapshot?.recordedAt ?? rawSnapshot?.timestamp ?? rawSnapshot?.date;
  if (!validDateValue(recordedAt)) return [];
  const events = [];
  if (isFiniteNumber(rawSnapshot?.gold, { min: 0 })) events.push({
    id: typeof rawSnapshot?.id === 'string' && rawSnapshot.id ? rawSnapshot.id : deterministicId('progress-gold', [characterId, characterIndex, snapshotIndex, recordedAt]),
    entityType: 'character', entityId: characterId, metric: 'liquidGold', value: Number(rawSnapshot.gold), recordedAt, source: 'legacy-v1'
  });
  if (isFiniteNumber(rawSnapshot?.level, { min: 1, max: 100 })) events.push({
    id: typeof rawSnapshot?.id === 'string' && rawSnapshot.id ? `${rawSnapshot.id}-level` : deterministicId('progress-level', [characterId, characterIndex, snapshotIndex, recordedAt]),
    entityType: 'character', entityId: characterId, metric: 'level', value: Number(rawSnapshot.level), recordedAt, source: 'legacy-v1'
  });
  return events;
}

function migrateCollections(rawCollections, characterId, characterIndex) {
  if (!isPlainObject(rawCollections)) return [];
  return Object.entries(rawCollections).map(([name, rawValue], collectionIndex) => {
    const value = isPlainObject(rawValue) ? rawValue : {};
    const unknown = unknownFields(value, KNOWN_COLLECTION_FIELDS);
    return {
      ...clone(unknown),
      id: typeof value.id === 'string' && value.id ? value.id : deterministicId('collection', [characterId, characterIndex, name, collectionIndex]),
      scope: 'character', characterId, name,
      owned: asNumber(value.owned, 0, { min: 0 }),
      target: asNumber(value.target, 10, { min: 1 }),
      baseline: asNumber(value.baseline, 0, { min: 0 }),
      ...(mergeLegacy(value.legacy, unknown) ? { legacy: mergeLegacy(value.legacy, unknown) } : {})
    };
  });
}

export function migrateV1ToV2(input, { now = new Date() } = {}) {
  if (!isPlainObject(input) || (input.version !== undefined && input.version !== 1)) throw new Error('Unsupported legacy schema.');
  if (!Array.isArray(input.characters) || !input.characters.length) throw new Error('Legacy data contains no characters.');
  const nowIsoValue = isoNow(now);
  const warnings = [];
  const characters = [];
  const goals = [];
  const activities = [];
  const progressEvents = [];
  const collectionTrackers = [];

  input.characters.forEach((rawCharacter, characterIndex) => {
    if (!isPlainObject(rawCharacter)) {
      warnings.push(`characters[${characterIndex}] was not an object and was preserved in migration warnings.`);
      return;
    }
    const character = migrateCharacter(rawCharacter, characterIndex, nowIsoValue);
    characters.push(character);
    const fallbackDate = character.createdAt;
    (Array.isArray(rawCharacter.goals) ? rawCharacter.goals : []).forEach((goal, goalIndex) => {
      if (!isPlainObject(goal)) { warnings.push(`characters[${characterIndex}].goals[${goalIndex}] was skipped.`); return; }
      goals.push(migrateGoal(goal, character.id, characterIndex, goalIndex, fallbackDate));
    });
    (Array.isArray(rawCharacter.sessions) ? rawCharacter.sessions : []).forEach((session, sessionIndex) => {
      if (!isPlainObject(session)) { warnings.push(`characters[${characterIndex}].sessions[${sessionIndex}] was skipped.`); return; }
      activities.push(migrateSession(session, character.id, characterIndex, sessionIndex, fallbackDate));
    });
    (Array.isArray(rawCharacter.ledger) ? rawCharacter.ledger : []).forEach((entry, entryIndex) => {
      if (!isPlainObject(entry)) { warnings.push(`characters[${characterIndex}].ledger[${entryIndex}] was skipped.`); return; }
      activities.push(migrateLedgerEntry(entry, character.id, characterIndex, entryIndex, fallbackDate));
    });
    const rawSnapshots = Array.isArray(rawCharacter.snapshots) ? rawCharacter.snapshots : [];
    rawSnapshots.forEach((snapshot, snapshotIndex) => {
      const events = migrateSnapshot(snapshot, character.id, characterIndex, snapshotIndex);
      if (!events.length) warnings.push(`characters[${characterIndex}].snapshots[${snapshotIndex}] had no valid observations.`);
      progressEvents.push(...events);
    });
    collectionTrackers.push(...migrateCollections(rawCharacter.collections, character.id, characterIndex));
    const latestGold = [...progressEvents].filter(event => event.entityId === character.id && event.metric === 'liquidGold').at(-1);
    const latestLevel = [...progressEvents].filter(event => event.entityId === character.id && event.metric === 'level').at(-1);
    if (!latestGold || Number(latestGold.value) !== Number(character.gold)) progressEvents.push({ id: deterministicId('progress-final-gold', [character.id, character.gold]), entityType: 'character', entityId: character.id, metric: 'liquidGold', value: character.gold, recordedAt: nowIsoValue, source: 'legacy-current-observation' });
    if (!latestLevel || Number(latestLevel.value) !== Number(character.level)) progressEvents.push({ id: deterministicId('progress-final-level', [character.id, character.level]), entityType: 'character', entityId: character.id, metric: 'level', value: character.level, recordedAt: nowIsoValue, source: 'legacy-current-observation' });
  });

  if (!characters.length) throw new Error('Legacy data contains no valid characters.');
  const rawLegacy = unknownFields(input, KNOWN_TOP_LEVEL_FIELDS);
  const migrated = {
    schemaVersion: V2_SCHEMA_VERSION,
    activeCharacterId: characters.some(character => character.id === input.activeId) ? input.activeId : characters[0].id,
    preferences: isPlainObject(input.preferences) ? clone(input.preferences) : {},
    characters,
    goals,
    activities,
    progressEvents,
    collectionTrackers,
    sessionPlans: [],
    activityOccurrences: [],
    recommendationHistory: [],
    migration: { sourceVersion: 1, targetVersion: V2_SCHEMA_VERSION, migratedAt: nowIsoValue, warnings },
    ...(Object.keys(rawLegacy).length ? { legacy: clone(rawLegacy) } : {})
  };
  const validation = validateV2State(migrated);
  if (!validation.ok) throw new Error(`Migrated data failed validation: ${validation.errors.join('; ')}`);
  return migrated;
}

export function normalizeV2State(input) {
  const normalized = clone(input);
  if (normalized.sessionPlans === undefined) normalized.sessionPlans = [];
  if (normalized.activityOccurrences === undefined) normalized.activityOccurrences = [];
  if (normalized.recommendationHistory === undefined) normalized.recommendationHistory = [];
  return normalized;
}

export function migrateState(input, { now = new Date() } = {}) {
  if (!isPlainObject(input)) throw new Error('Stored data is not an object.');
  if (input.schemaVersion > V2_SCHEMA_VERSION) throw new Error(`This dashboard cannot read schema version ${input.schemaVersion} yet.`);
  if (input.schemaVersion === V2_SCHEMA_VERSION) {
    const normalized = normalizeV2State(input);
    const validation = validateV2State(normalized);
    if (!validation.ok) throw new Error(`Stored v2 data failed validation: ${validation.errors.join('; ')}`);
    return normalized;
  }
  if (input.version === 1 || input.version === undefined) return migrateV1ToV2(input, { now });
  throw new Error(`Unsupported stored schema version ${input.version}.`);
}

export function createStarterState({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const nowIsoValue = isoNow(now);
  const characterId = 'carnitez-silvermoon-eu';
  const character = {
    id: characterId, name: 'Carnitez', realm: 'Silvermoon', region: 'EU', faction: 'Alliance', race: 'Night Elf', className: 'Druid', spec: 'Guardian', professions: 'Herbalism, Mining', campaignRole: 'main', level: 1, gold: 0, playedMinutes: 0, location: 'Shadowglen', createdAt: date
  };
  const goals = [
    ['Current content', 'Complete every available quest in Shadowglen'],
    ['Collection', 'Capture the first account collection baseline'],
    ['Gold', 'Earn the first 100 gold without outside help']
  ].map(([category, title], index) => ({ id: deterministicId('goal', [characterId, 'starter', index]), characterId, scope: 'character', category, title, status: 'todo', priority: 0, dueDate: null, recurrence: null, estimatedMinutes: null, createdAt: date, completedAt: null, order: index }));
  const collectionTrackers = COLLECTION_NAMES.map((name, index) => ({ id: deterministicId('collection', [characterId, 'starter', index]), scope: 'character', characterId, name, owned: 0, target: name === 'Appearances' ? 100 : 10, baseline: 0 }));
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    activeCharacterId: characterId,
    preferences: {},
    characters: [character],
    goals,
    activities: [],
    progressEvents: [
      { id: deterministicId('progress-gold', [characterId, 'starter']), entityType: 'character', entityId: characterId, metric: 'liquidGold', value: 0, recordedAt: date, source: 'starter' },
      { id: deterministicId('progress-level', [characterId, 'starter']), entityType: 'character', entityId: characterId, metric: 'level', value: 1, recordedAt: date, source: 'starter' }
    ],
    collectionTrackers,
    sessionPlans: [],
    activityOccurrences: [],
    recommendationHistory: [],
    migration: { sourceVersion: V2_SCHEMA_VERSION, targetVersion: V2_SCHEMA_VERSION, migratedAt: nowIsoValue }
  };
}

function readStorage(storage, key) {
  try { return storage.getItem(key); } catch (_) { return null; }
}

function writeStorage(storage, key, value) {
  storage.setItem(key, value);
}

function parseJson(raw) {
  if (typeof raw !== 'string') throw new Error('No stored value.');
  try { return JSON.parse(raw); } catch (_) { throw new Error('Stored data is not valid JSON.'); }
}

export function persistV2(storage, state, { legacyRaw = null, overwriteInvalidV2 = false } = {}) {
  const validation = validateV2State(state);
  if (!validation.ok) throw new Error(`Refusing to save invalid v2 data: ${validation.errors.join('; ')}`);
  if (legacyRaw !== null && readStorage(storage, V1_RECOVERY_KEY) === null) writeStorage(storage, V1_RECOVERY_KEY, legacyRaw);
  if (overwriteInvalidV2) {
    const invalidV2 = readStorage(storage, V2_STORAGE_KEY);
    if (invalidV2 !== null && readStorage(storage, V2_RECOVERY_KEY) === null) writeStorage(storage, V2_RECOVERY_KEY, invalidV2);
  }
  writeStorage(storage, V2_STORAGE_KEY, JSON.stringify(state));
}

export function loadPersistedState(storage, { now = new Date() } = {}) {
  const rawV2 = readStorage(storage, V2_STORAGE_KEY);
  if (rawV2 !== null) {
    try {
      const parsedV2 = parseJson(rawV2);
      return { status: 'ready', source: 'v2', state: migrateState(parsedV2, { now }) };
    } catch (error) {
      let legacyState = null;
      const rawV1 = readStorage(storage, V1_STORAGE_KEY);
      if (rawV1 !== null) {
        try { legacyState = migrateV1ToV2(parseJson(rawV1), { now }); } catch (_) { legacyState = null; }
      }
      return { status: 'recovery', sourceKey: V2_STORAGE_KEY, raw: rawV2, reason: error.message, legacyState };
    }
  }
  const rawV1 = readStorage(storage, V1_STORAGE_KEY);
  if (rawV1 !== null) {
    try {
      const migrated = migrateV1ToV2(parseJson(rawV1), { now });
      persistV2(storage, migrated, { legacyRaw: rawV1 });
      return { status: 'ready', source: 'v1-migrated', state: migrated };
    } catch (error) {
      return { status: 'recovery', sourceKey: V1_STORAGE_KEY, raw: rawV1, reason: error.message, legacyState: null };
    }
  }
  const starter = createStarterState({ now });
  return { status: 'ready', source: 'starter', state: starter };
}

export function calculateGoldTotals(activities = []) {
  const goldActivities = activities.filter(activity => activity?.kind === 'gold');
  const profit = goldActivities.reduce((sum, activity) => sum + asNumber(activity.gold?.revenue) - asNumber(activity.gold?.cost), 0);
  const minutes = goldActivities.reduce((sum, activity) => sum + asNumber(activity.durationMinutes, 0, { min: 0 }), 0);
  const measured = goldActivities.map(activity => {
    const activityProfit = asNumber(activity.gold?.revenue) - asNumber(activity.gold?.cost);
    const duration = asNumber(activity.durationMinutes, 0, { min: 0 });
    return { activity, profit: activityProfit, rate: duration ? activityProfit / duration * 60 : null };
  }).filter(item => item.rate !== null);
  const best = [...measured].sort((a, b) => b.rate - a.rate)[0] || null;
  return { profit, minutes, hourlyRate: minutes ? profit / minutes * 60 : null, best };
}

export function currentProgressValue(progressEvents, entityId, metric) {
  const events = progressEvents.filter(event => event.entityId === entityId && event.metric === metric).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  return events.length ? Number(events.at(-1).value) : null;
}

export function progressEventsForSnapshots(characterId, snapshots = [], current = {}, { now = new Date() } = {}) {
  const events = [];
  snapshots.forEach((snapshot, index) => events.push(...migrateSnapshot(snapshot, characterId, 0, index)));
  const latestGold = [...events].filter(event => event.metric === 'liquidGold').at(-1);
  const latestLevel = [...events].filter(event => event.metric === 'level').at(-1);
  const nowIsoValue = isoNow(now);
  if (!latestGold || Number(latestGold.value) !== Number(current.gold)) events.push({ id: deterministicId('progress-final-gold', [characterId, current.gold]), entityType: 'character', entityId: characterId, metric: 'liquidGold', value: asNumber(current.gold), recordedAt: nowIsoValue, source: 'current-observation' });
  if (!latestLevel || Number(latestLevel.value) !== Number(current.level)) events.push({ id: deterministicId('progress-final-level', [characterId, current.level]), entityType: 'character', entityId: characterId, metric: 'level', value: asNumber(current.level, 1, { min: 1, max: 100 }), recordedAt: nowIsoValue, source: 'current-observation' });
  return events;
}

export function groupByLocalDate(items, getDate = item => item.occurredAt ?? item.date) {
  return items.reduce((groups, item) => {
    const key = localDateKey(getDate(item));
    if (!key) return groups;
    (groups[key] ||= []).push(item);
    return groups;
  }, {});
}

const Core = {
  V1_STORAGE_KEY, V2_STORAGE_KEY, V1_RECOVERY_KEY, V2_RECOVERY_KEY, V2_SCHEMA_VERSION, COLLECTION_NAMES,
  isPlainObject, clone, isFiniteNumber, asNumber, localDateKey, localDateTime, isoNow, deterministicId, createId,
  validateV2State, migrateV1ToV2, normalizeV2State, migrateState, createStarterState, persistV2, loadPersistedState,
  calculateGoldTotals, currentProgressValue, progressEventsForSnapshots, groupByLocalDate
};

if (typeof globalThis !== 'undefined') globalThis.AzerothCore = Core;
