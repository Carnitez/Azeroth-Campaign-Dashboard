/*
 * Pure saved-plan and session-execution domain logic for schema v2.
 * No function in this module mutates its inputs.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');
const Activities = globalThis.AzerothActivities ?? await import('./activity-engine.mjs');

export const SESSION_STATUSES = Object.freeze(['draft', 'ready', 'in_progress', 'paused', 'completed', 'abandoned']);
export const SESSION_ITEM_STATUSES = Object.freeze(['pending', 'current', 'completed', 'skipped', 'partial']);

const list = value => Array.isArray(value) ? value : [];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestamp = value => value ? (Core.localDateTime(value)?.getTime() ?? 0) : 0;
const nowIso = value => Core.isoNow(value ?? new Date());
const terminalItem = item => ['completed', 'skipped', 'partial'].includes(item?.status);
const plans = state => list(state?.sessionPlans);

function cleanMinutes(value, fallback = 0) {
  return Math.max(0, Math.round(number(value, fallback)));
}

function cleanAmount(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function itemSnapshot(activity) {
  return {
    title: String(activity?.title || 'Removed activity'),
    category: String(activity?.category || 'Custom'),
    characterId: String(activity?.characterId || ''),
    repeatType: String(activity?.repeatType || 'one_time')
  };
}

export function createSessionItem(activity, options = {}) {
  const snapshot = options.snapshot || itemSnapshot(activity);
  return {
    id: options.id || Core.createId('session-item'),
    activityId: activity?.id || options.activityId || null,
    characterId: String(activity?.characterId || options.characterId || snapshot.characterId || ''),
    snapshot: {
      title: String(snapshot.title || 'Removed activity'),
      category: String(snapshot.category || 'Custom'),
      characterId: String(snapshot.characterId || activity?.characterId || options.characterId || ''),
      repeatType: String(snapshot.repeatType || activity?.repeatType || 'one_time')
    },
    order: cleanMinutes(options.order),
    locked: Boolean(options.locked),
    plannedMinutes: Math.max(1, cleanMinutes(options.plannedMinutes, activity?.estimatedMinutes || 30)),
    status: SESSION_ITEM_STATUSES.includes(options.status) ? options.status : 'pending',
    actualMinutes: cleanMinutes(options.actualMinutes),
    startedAt: options.startedAt || null,
    completedAt: options.completedAt || null,
    resultNotes: String(options.resultNotes || ''),
    goldEarned: cleanAmount(options.goldEarned),
    goldSpent: cleanAmount(options.goldSpent),
    progressMetric: String(options.progressMetric || ''),
    progressGained: number(options.progressGained),
    completionQuantity: options.completionQuantity === null || options.completionQuantity === undefined || options.completionQuantity === '' ? null : Math.max(0, number(options.completionQuantity)),
    completeUnderlying: Boolean(options.completeUnderlying),
    unplanned: Boolean(options.unplanned)
  };
}

function normalizeItemOrder(items) {
  return list(items).map((item, index) => ({ ...item, order: index }));
}

function planCharacterIds(items) {
  return [...new Set(list(items).map(item => item.characterId || item.snapshot?.characterId).filter(Boolean))];
}

function totalPlannedMinutes(items) {
  return list(items).reduce((sum, item) => sum + Math.max(1, cleanMinutes(item.plannedMinutes, 30)), 0);
}

export function createSavedPlan(generatedPlan, input = {}, { id = Core.createId('session-plan'), now = new Date() } = {}) {
  const createdAt = nowIso(now);
  const generatedItems = list(generatedPlan?.items).map((entry, index) => createSessionItem(entry.activity, {
    id: Core.deterministicId('session-item', [id, entry.activity?.id || index, index]),
    order: index,
    locked: entry.locked,
    plannedMinutes: entry.activity?.estimatedMinutes
  }));
  const items = normalizeItemOrder(input.items || generatedItems);
  const status = ['draft', 'ready'].includes(input.status) ? input.status : 'draft';
  return {
    id,
    title: String(input.title || `Campaign session · ${Core.localDateKey(now)}`).trim(),
    characterIds: planCharacterIds(items),
    items,
    totalEstimatedMinutes: totalPlannedMinutes(items),
    plannedFor: /^\d{4}-\d{2}-\d{2}$/.test(String(input.plannedFor || '')) ? String(input.plannedFor) : Core.localDateKey(now),
    status,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    endedAt: null,
    activeStartedAt: null,
    pausedAt: null,
    accumulatedMs: 0,
    currentItemId: null,
    notes: String(input.notes || ''),
    reconciliation: null
  };
}

export function validateSavedPlan(plan) {
  const errors = [];
  if (!Core.isPlainObject(plan)) return { ok: false, errors: ['plan must be an object'] };
  if (typeof plan.id !== 'string' || !plan.id) errors.push('id must be a non-empty string');
  if (typeof plan.title !== 'string' || !plan.title.trim()) errors.push('title must be a non-empty string');
  if (!SESSION_STATUSES.includes(plan.status)) errors.push('status is invalid');
  if (!Array.isArray(plan.characterIds) || plan.characterIds.some(id => typeof id !== 'string' || !id)) errors.push('characterIds must be strings');
  if (!Array.isArray(plan.items)) errors.push('items must be an array');
  list(plan.items).forEach((item, index) => {
    const path = `items[${index}]`;
    if (!Core.isPlainObject(item)) { errors.push(`${path} must be an object`); return; }
    if (typeof item.id !== 'string' || !item.id) errors.push(`${path}.id is required`);
    if (item.activityId !== null && item.activityId !== undefined && typeof item.activityId !== 'string') errors.push(`${path}.activityId must be null or a string`);
    if (typeof item.characterId !== 'string' || !item.characterId) errors.push(`${path}.characterId is required`);
    if (!Core.isPlainObject(item.snapshot) || typeof item.snapshot.title !== 'string' || typeof item.snapshot.category !== 'string') errors.push(`${path}.snapshot is invalid`);
    if (!SESSION_ITEM_STATUSES.includes(item.status)) errors.push(`${path}.status is invalid`);
    if (!Core.isFiniteNumber(item.plannedMinutes, { min: 1 })) errors.push(`${path}.plannedMinutes must be positive`);
    if (!Core.isFiniteNumber(item.actualMinutes, { min: 0 })) errors.push(`${path}.actualMinutes must be non-negative`);
    for (const field of ['goldEarned', 'goldSpent']) if (!Core.isFiniteNumber(item[field], { min: 0 })) errors.push(`${path}.${field} must be non-negative`);
    if (!Core.isFiniteNumber(item.progressGained)) errors.push(`${path}.progressGained must be numeric`);
    for (const field of ['startedAt', 'completedAt']) if (item[field] !== null && item[field] !== undefined && !timestamp(item[field])) errors.push(`${path}.${field} must be null or a timestamp`);
  });
  if (!Core.isFiniteNumber(plan.totalEstimatedMinutes, { min: 0 })) errors.push('totalEstimatedMinutes must be non-negative');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plan.plannedFor || ''))) errors.push('plannedFor must be a local date');
  if (!timestamp(plan.createdAt) || !timestamp(plan.updatedAt)) errors.push('createdAt and updatedAt must be timestamps');
  for (const field of ['startedAt', 'completedAt', 'endedAt', 'activeStartedAt', 'pausedAt']) if (plan[field] !== null && plan[field] !== undefined && !timestamp(plan[field])) errors.push(`${field} must be null or a timestamp`);
  if (!Core.isFiniteNumber(plan.accumulatedMs, { min: 0 })) errors.push('accumulatedMs must be non-negative');
  if (typeof plan.notes !== 'string') errors.push('notes must be a string');
  return { ok: errors.length === 0, errors };
}

function rebuildPlan(plan, changes, now = new Date()) {
  const items = normalizeItemOrder(changes.items || plan.items);
  return {
    ...plan,
    ...changes,
    items,
    characterIds: planCharacterIds(items),
    totalEstimatedMinutes: totalPlannedMinutes(items),
    updatedAt: nowIso(now)
  };
}

export function updateSavedPlan(plan, changes, { now = new Date() } = {}) {
  if (!['draft', 'ready'].includes(plan?.status)) throw new Error('Only draft or ready plans can be edited.');
  const status = changes.status === undefined ? plan.status : changes.status;
  if (!['draft', 'ready'].includes(status)) throw new Error('An editable plan can only be Draft or Ready.');
  const plannedFor = changes.plannedFor === undefined ? plan.plannedFor : changes.plannedFor;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plannedFor))) throw new Error('Choose a valid planned date.');
  const next = rebuildPlan(plan, {
    ...changes,
    title: changes.title === undefined ? plan.title : String(changes.title).trim(),
    notes: changes.notes === undefined ? plan.notes : String(changes.notes),
    plannedFor,
    status
  }, now);
  if (!next.title) throw new Error('A session title is required.');
  return next;
}

export function addActivityToPlan(plan, activity, { now = new Date(), unplanned = false } = {}) {
  const item = createSessionItem(activity, { id: Core.createId('session-item'), order: plan.items.length, unplanned });
  return rebuildPlan(plan, { items: [...plan.items, item] }, now);
}

export function removeSessionItem(plan, itemId, { now = new Date() } = {}) {
  return rebuildPlan(plan, { items: plan.items.filter(item => item.id !== itemId) }, now);
}

export function reorderSessionItems(plan, fromIndex, toIndex, { now = new Date() } = {}) {
  const items = Activities.reorderPlan(plan.items, fromIndex, toIndex);
  return rebuildPlan(plan, { items }, now);
}

export function updateSessionItemPlan(plan, itemId, changes, { now = new Date() } = {}) {
  const items = plan.items.map(item => item.id === itemId ? {
    ...item,
    locked: changes.locked === undefined ? item.locked : Boolean(changes.locked),
    plannedMinutes: changes.plannedMinutes === undefined ? item.plannedMinutes : Math.max(1, cleanMinutes(changes.plannedMinutes, item.plannedMinutes))
  } : item);
  return rebuildPlan(plan, { items }, now);
}

export function duplicateSavedPlan(plan, { id = Core.createId('session-plan'), now = new Date() } = {}) {
  const items = plan.items.map((item, index) => createSessionItem(null, {
    ...item,
    id: Core.deterministicId('session-item', [id, item.activityId || item.id, index]),
    order: index,
    status: 'pending', actualMinutes: 0, startedAt: null, completedAt: null,
    resultNotes: '', goldEarned: 0, goldSpent: 0, progressMetric: '', progressGained: 0,
    completionQuantity: null, completeUnderlying: false
  }));
  return createSavedPlan(null, {
    items, title: `${plan.title} copy`, plannedFor: Core.localDateKey(now), status: 'draft', notes: plan.notes
  }, { id, now });
}

export function selectRunningSession(state, excludeId = null) {
  return plans(state).filter(plan => plan.status === 'in_progress' && plan.id !== excludeId)
    .sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export function selectActiveSession(state) {
  return plans(state).filter(plan => ['in_progress', 'paused'].includes(plan.status))
    .sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
      || timestamp(b.startedAt) - timestamp(a.startedAt) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export function elapsedSessionMs(plan, now = new Date()) {
  const accumulated = Math.max(0, number(plan?.accumulatedMs));
  if (plan?.status !== 'in_progress' || !plan.activeStartedAt) return accumulated;
  return accumulated + Math.max(0, timestamp(now) - timestamp(plan.activeStartedAt));
}

function closeActiveSegment(plan, now) {
  return {
    ...plan,
    accumulatedMs: elapsedSessionMs(plan, now),
    activeStartedAt: null
  };
}

export function startSession(plan, state, { now = new Date() } = {}) {
  if (!['draft', 'ready'].includes(plan?.status)) throw new Error('Only a draft or ready session can be started.');
  const running = selectRunningSession(state, plan.id);
  if (running) throw new Error(`Pause, finish, or abandon “${running.title}” before starting another session.`);
  if (!plan.items.length) throw new Error('Add at least one activity before starting this session.');
  const at = nowIso(now);
  const currentId = plan.items.find(item => !terminalItem(item))?.id || null;
  const items = plan.items.map(item => item.id === currentId ? { ...item, status: 'current', startedAt: item.startedAt || at } : item);
  return rebuildPlan(plan, {
    status: 'in_progress', startedAt: plan.startedAt || at, activeStartedAt: at, pausedAt: null,
    completedAt: null, endedAt: null, currentItemId: currentId, items
  }, now);
}

export function pauseSession(plan, { now = new Date() } = {}) {
  if (plan?.status !== 'in_progress') throw new Error('Only a running session can be paused.');
  return rebuildPlan(closeActiveSegment(plan, now), { status: 'paused', pausedAt: nowIso(now) }, now);
}

export function resumeSession(plan, state, { now = new Date() } = {}) {
  if (plan?.status !== 'paused') throw new Error('Only a paused session can be resumed.');
  const running = selectRunningSession(state, plan.id);
  if (running) throw new Error(`Pause, finish, or abandon “${running.title}” before resuming this session.`);
  return rebuildPlan(plan, { status: 'in_progress', activeStartedAt: nowIso(now), pausedAt: null }, now);
}

export function setCurrentSessionItem(plan, itemId, { now = new Date() } = {}) {
  if (!['in_progress', 'paused'].includes(plan?.status)) throw new Error('Open a running or paused session to change activities.');
  const target = plan.items.find(item => item.id === itemId);
  if (!target || terminalItem(target)) return plan;
  const at = nowIso(now);
  const items = plan.items.map(item => {
    if (item.id === itemId) return { ...item, status: 'current', startedAt: item.startedAt || at };
    if (item.status === 'current') return { ...item, status: 'pending' };
    return item;
  });
  return rebuildPlan(plan, { currentItemId: itemId, items }, now);
}

export function updateSessionItemResult(plan, itemId, result, { now = new Date(), advance = true } = {}) {
  const status = result.status;
  if (!['completed', 'skipped', 'partial'].includes(status)) throw new Error('Choose Completed, Skipped, or Partially completed.');
  const index = plan.items.findIndex(item => item.id === itemId);
  if (index < 0) throw new Error('That session item no longer exists.');
  const at = nowIso(now);
  const current = plan.items[index];
  const updated = {
    ...current,
    status,
    actualMinutes: status === 'skipped' ? 0 : cleanMinutes(result.actualMinutes, current.actualMinutes),
    startedAt: current.startedAt || at,
    completedAt: at,
    resultNotes: String(result.resultNotes ?? current.resultNotes ?? ''),
    goldEarned: status === 'skipped' ? 0 : cleanAmount(result.goldEarned, current.goldEarned),
    goldSpent: status === 'skipped' ? 0 : cleanAmount(result.goldSpent, current.goldSpent),
    progressMetric: status === 'skipped' ? '' : String(result.progressMetric ?? current.progressMetric ?? '').trim(),
    progressGained: status === 'skipped' ? 0 : number(result.progressGained, current.progressGained),
    completionQuantity: status === 'skipped' || result.completionQuantity === '' || result.completionQuantity === null || result.completionQuantity === undefined ? null : Math.max(0, number(result.completionQuantity)),
    completeUnderlying: status === 'completed' && Boolean(result.completeUnderlying)
  };
  let items = plan.items.map(item => item.id === itemId ? updated : item);
  let currentItemId = plan.currentItemId === itemId ? null : plan.currentItemId;
  if (advance && ['in_progress', 'paused'].includes(plan.status)) {
    const next = items.slice(index + 1).find(item => !terminalItem(item)) || items.find(item => !terminalItem(item));
    if (next) {
      currentItemId = next.id;
      items = items.map(item => item.id === next.id ? { ...item, status: 'current', startedAt: item.startedAt || at } : item.status === 'current' ? { ...item, status: 'pending' } : item);
    }
  }
  return rebuildPlan(plan, { items, currentItemId }, now);
}

export function addUnplannedActivity(plan, activity, { now = new Date() } = {}) {
  const next = addActivityToPlan(plan, activity, { now, unplanned: true });
  if (!plan.currentItemId && ['in_progress', 'paused'].includes(plan.status)) return setCurrentSessionItem(next, next.items.at(-1).id, { now });
  return next;
}

export function appendSessionNote(plan, note, { now = new Date() } = {}) {
  const text = String(note || '').trim();
  if (!text) return plan;
  const line = `[${nowIso(now)}] ${text}`;
  return rebuildPlan(plan, { notes: [plan.notes, line].filter(Boolean).join('\n') }, now);
}

export function abandonSession(plan, { now = new Date() } = {}) {
  if (!['in_progress', 'paused'].includes(plan?.status)) throw new Error('Only an active session can be abandoned.');
  const closed = plan.status === 'in_progress' ? closeActiveSegment(plan, now) : plan;
  return rebuildPlan(closed, { status: 'abandoned', endedAt: nowIso(now), activeStartedAt: null, pausedAt: null }, now);
}

export function sessionSummary(plan, { now = new Date() } = {}) {
  const counts = { planned: plan.items.length, completed: 0, skipped: 0, partial: 0, unfinished: 0 };
  for (const item of plan.items) {
    if (item.status === 'completed') counts.completed += 1;
    else if (item.status === 'skipped') counts.skipped += 1;
    else if (item.status === 'partial') counts.partial += 1;
    else counts.unfinished += 1;
  }
  const goldEarned = plan.items.reduce((sum, item) => sum + cleanAmount(item.goldEarned), 0);
  const goldSpent = plan.items.reduce((sum, item) => sum + cleanAmount(item.goldSpent), 0);
  const progress = plan.items.filter(item => item.progressMetric && number(item.progressGained) !== 0).map(item => ({ itemId: item.id, title: item.snapshot.title, characterId: item.characterId, metric: item.progressMetric, gained: number(item.progressGained) }));
  return {
    plannedMinutes: totalPlannedMinutes(plan.items),
    actualMinutes: Math.max(cleanMinutes(elapsedSessionMs(plan, now) / 60_000), plan.items.reduce((sum, item) => sum + cleanMinutes(item.actualMinutes), 0)),
    ...counts,
    goldEarned,
    goldSpent,
    netGold: goldEarned - goldSpent,
    progress,
    notes: plan.notes,
    unfinishedItems: plan.items.filter(item => !terminalItem(item))
  };
}

function restorePreviousUnderlying(state, plan) {
  const previous = plan.reconciliation?.underlying || {};
  state.activities = state.activities.map(activity => {
    const record = previous[activity.id];
    if (!record || activity.completionSourceSessionId !== plan.id) return activity;
    const restored = { ...activity, status: record.status, completedAt: record.completedAt, updatedAt: record.updatedAt };
    delete restored.completionSourceSessionId;
    delete restored.completionSourceItemId;
    return restored;
  });
}

function canonicalProgressValue(state, characterId, metric) {
  const character = state.characters.find(item => item.id === characterId);
  if (metric === 'level') return number(character?.level, 1);
  const match = /^collection:([^:]+):owned$/i.exec(metric);
  if (match) return number(state.collectionTrackers.find(item => item.characterId === characterId && String(item.name).toLowerCase() === match[1].toLowerCase())?.owned);
  return number(Core.currentProgressValue(state.progressEvents, characterId, metric));
}

function applyCanonicalProgress(state, characterId, metric, delta) {
  const character = state.characters.find(item => item.id === characterId);
  if (metric === 'level' && character) {
    const next = number(character.level, 1) + delta;
    if (next < 1 || next > 100) throw new Error('The session would create an impossible character level.');
    character.level = next;
  }
  const match = /^collection:([^:]+):owned$/i.exec(metric);
  if (match) {
    const tracker = state.collectionTrackers.find(item => item.characterId === characterId && String(item.name).toLowerCase() === match[1].toLowerCase());
    if (tracker) tracker.owned = Math.max(0, number(tracker.owned) + delta);
  }
}

export function reconcileSessionResults(inputState, inputPlan, { now = new Date() } = {}) {
  const state = Core.clone(inputState);
  let plan = Core.clone(inputPlan);
  const at = nowIso(now);
  const previous = plan.reconciliation || {};
  const oldGoldByCharacter = previous.goldBalanceByCharacter || {};
  const oldPlayedByCharacter = previous.playedMinutesByCharacter || {};
  const oldProgress = previous.progressByKey || {};

  restorePreviousUnderlying(state, plan);
  state.activities = state.activities.filter(activity => activity.sourceSessionId !== plan.id);
  state.progressEvents = state.progressEvents.filter(event => event.sourceSessionId !== plan.id);

  const nextGoldByCharacter = {};
  const nextPlayedByCharacter = {};
  const nextProgress = {};
  for (const item of plan.items) {
    if (item.status === 'skipped' || !terminalItem(item)) continue;
    const characterId = item.characterId;
    nextGoldByCharacter[characterId] = number(nextGoldByCharacter[characterId]) + cleanAmount(item.goldEarned) - cleanAmount(item.goldSpent);
    nextPlayedByCharacter[characterId] = number(nextPlayedByCharacter[characterId]) + cleanMinutes(item.actualMinutes);
    if (item.progressMetric && number(item.progressGained) !== 0) {
      const key = `${characterId}:${item.progressMetric}`;
      nextProgress[key] = number(nextProgress[key]) + number(item.progressGained);
    }
  }

  const characterIds = new Set([...Object.keys(oldGoldByCharacter), ...Object.keys(nextGoldByCharacter), ...Object.keys(oldPlayedByCharacter), ...Object.keys(nextPlayedByCharacter)]);
  for (const characterId of characterIds) {
    const character = state.characters.find(item => item.id === characterId);
    if (!character) continue;
    const gold = number(character.gold) - number(oldGoldByCharacter[characterId]) + number(nextGoldByCharacter[characterId]);
    if (gold < 0) throw new Error(`${character.name} does not have enough gold for these session results.`);
    character.gold = gold;
    character.playedMinutes = Math.max(0, number(character.playedMinutes) - number(oldPlayedByCharacter[characterId]) + number(nextPlayedByCharacter[characterId]));
  }

  const progressKeys = new Set([...Object.keys(oldProgress), ...Object.keys(nextProgress)]);
  for (const key of progressKeys) {
    const split = key.indexOf(':');
    const characterId = key.slice(0, split);
    const metric = key.slice(split + 1);
    applyCanonicalProgress(state, characterId, metric, number(nextProgress[key]) - number(oldProgress[key]));
  }

  const linkedActivityIds = [];
  const linkedProgressEventIds = [];
  const progressRunning = {};
  for (const item of plan.items) {
    if (item.status === 'skipped' || !terminalItem(item)) continue;
    const occurredAt = item.completedAt || plan.completedAt || at;
    if (cleanAmount(item.goldEarned) || cleanAmount(item.goldSpent)) {
      const id = Core.deterministicId('session-gold', [plan.id, item.id]);
      state.activities.push({
        id, characterId: item.characterId, kind: 'gold', occurredAt,
        durationMinutes: cleanMinutes(item.actualMinutes), title: item.snapshot.title,
        notes: item.resultNotes, gold: { revenue: cleanAmount(item.goldEarned), cost: cleanAmount(item.goldSpent), delta: cleanAmount(item.goldEarned) - cleanAmount(item.goldSpent), affectsBalance: true },
        sourceSessionId: plan.id, sourceSessionItemId: item.id, sourceType: 'session-result'
      });
      linkedActivityIds.push(id);
    }
    if (item.progressMetric && number(item.progressGained) !== 0) {
      const key = `${item.characterId}:${item.progressMetric}`;
      if (progressRunning[key] === undefined) progressRunning[key] = canonicalProgressValue(state, item.characterId, item.progressMetric) - number(nextProgress[key]);
      progressRunning[key] += number(item.progressGained);
      const id = Core.deterministicId('session-progress', [plan.id, item.id, item.progressMetric]);
      state.progressEvents.push({
        id, entityType: 'character', entityId: item.characterId, metric: item.progressMetric,
        value: progressRunning[key], delta: number(item.progressGained), recordedAt: occurredAt,
        source: 'session-result', sourceSessionId: plan.id, sourceSessionItemId: item.id
      });
      linkedProgressEventIds.push(id);
    }
  }

  const summary = sessionSummary(plan, { now });
  const primaryCharacterId = plan.characterIds[0] || plan.items[0]?.characterId;
  if (primaryCharacterId) {
    const timelineId = Core.deterministicId('session-timeline', [plan.id]);
    state.activities.push({
      id: timelineId, characterId: primaryCharacterId, kind: 'session', occurredAt: plan.completedAt || plan.endedAt || at,
      durationMinutes: summary.actualMinutes, title: plan.title, notes: plan.notes,
      gold: { revenue: 0, cost: 0, delta: 0, affectsBalance: false },
      sourceSessionId: plan.id, sourceType: 'session-timeline'
    });
    linkedActivityIds.push(timelineId);
  }

  const underlying = {};
  for (const item of plan.items.filter(item => item.status === 'completed' && item.completeUnderlying && item.activityId)) {
    const index = state.activities.findIndex(activity => activity.id === item.activityId && Activities.isPlannedActivity(activity));
    if (index < 0) continue;
    const activity = state.activities[index];
    underlying[activity.id] = { status: activity.status, completedAt: activity.completedAt, updatedAt: activity.updatedAt };
    state.activities[index] = {
      ...Activities.setPlannedActivityStatus(activity, 'completed', { now: Core.localDateTime(item.completedAt || at) || now }),
      completionSourceSessionId: plan.id,
      completionSourceItemId: item.id
    };
  }

  plan = {
    ...plan,
    updatedAt: at,
    reconciliation: { linkedActivityIds, linkedProgressEventIds, goldBalanceByCharacter: nextGoldByCharacter, playedMinutesByCharacter: nextPlayedByCharacter, progressByKey: nextProgress, underlying }
  };
  return { state, plan };
}

export function finalizeSession(inputState, planId, { now = new Date() } = {}) {
  const state = Core.clone(inputState);
  const index = plans(state).findIndex(plan => plan.id === planId);
  if (index < 0) throw new Error('That saved session no longer exists.');
  let plan = state.sessionPlans[index];
  if (!['in_progress', 'paused', 'completed'].includes(plan.status)) throw new Error('Only an active or completed session can be finalized.');
  if (plan.status !== 'completed') {
    const closed = plan.status === 'in_progress' ? closeActiveSegment(plan, now) : plan;
    plan = rebuildPlan(closed, { status: 'completed', completedAt: nowIso(now), endedAt: nowIso(now), activeStartedAt: null, pausedAt: null, currentItemId: null }, now);
  }
  const reconciled = reconcileSessionResults(state, plan, { now });
  reconciled.state.sessionPlans[index] = reconciled.plan;
  return reconciled.state;
}

export function filterSessionHistory(state, { view = 'all', characterId = '', now = new Date() } = {}) {
  const today = Core.localDateKey(now);
  return plans(state).filter(plan => {
    if (characterId && !plan.characterIds.includes(characterId)) return false;
    if (view === 'active') return ['in_progress', 'paused'].includes(plan.status);
    if (view === 'upcoming') return ['draft', 'ready'].includes(plan.status) && plan.plannedFor >= today;
    if (view === 'completed') return plan.status === 'completed';
    if (view === 'abandoned') return plan.status === 'abandoned';
    return true;
  }).sort((a, b) => timestamp(b.startedAt || b.plannedFor || b.createdAt) - timestamp(a.startedAt || a.plannedFor || a.createdAt) || String(a.id).localeCompare(String(b.id)));
}

export function sessionRecommendation(plan, state, { now = new Date() } = {}) {
  const today = Core.localDateKey(now);
  if (!['in_progress', 'paused'].includes(plan.status) && !(plan.status === 'ready' && plan.plannedFor === today)) return null;
  const current = plan.items.find(item => item.id === plan.currentItemId) || plan.items.find(item => !terminalItem(item));
  const characterId = current?.characterId || plan.characterIds[0] || '';
  const character = list(state?.characters).find(item => item.id === characterId) || null;
  const rank = plan.status === 'in_progress' ? -3 : plan.status === 'paused' ? -2 : -1;
  return {
    id: `session:${plan.id}`, sourceType: 'session', sourceId: plan.id,
    title: plan.status === 'ready' ? plan.title : current?.snapshot?.title || plan.title,
    characterId, character, category: 'Session', progress: { current: plan.items.filter(terminalItem).length, target: plan.items.length },
    reason: plan.status === 'in_progress' ? 'Active session' : plan.status === 'paused' ? 'Paused session' : 'Ready for today',
    action: plan.status === 'ready' ? 'start-session' : 'open-session', actionLabel: plan.status === 'ready' ? 'Start session' : 'Resume session',
    sourceRank: rank, statusRank: 0, priority: 99, recentAt: timestamp(plan.updatedAt), activeRank: 0, actionableRank: 0, typeRank: -1
  };
}

export const SessionEngine = Object.freeze({
  SESSION_STATUSES, SESSION_ITEM_STATUSES, createSessionItem, createSavedPlan, validateSavedPlan,
  updateSavedPlan, addActivityToPlan, removeSessionItem, reorderSessionItems, updateSessionItemPlan,
  duplicateSavedPlan, selectRunningSession, selectActiveSession, elapsedSessionMs, startSession,
  pauseSession, resumeSession, setCurrentSessionItem, updateSessionItemResult, addUnplannedActivity,
  appendSessionNote, abandonSession, sessionSummary, reconcileSessionResults, finalizeSession,
  filterSessionHistory, sessionRecommendation
});

globalThis.AzerothSessions = SessionEngine;
