/*
 * Pure schema-v2 activity, session-planning, and command-palette logic.
 * UI state is derived from canonical campaign data; these functions never mutate input.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');

export const ACTIVITY_CATEGORIES = Object.freeze([
  'Campaign', 'Weekly', 'Gold', 'Reputation', 'Professions', 'Mounts',
  'Transmog', 'Achievements', 'Events', 'Custom'
]);
export const ACTIVITY_STATUSES = Object.freeze(['todo', 'in_progress', 'completed', 'skipped']);
export const ACTIVITY_REPEAT_TYPES = Object.freeze(['one_time', 'daily', 'weekly', 'manual']);
export const ACTIVITY_PRIORITIES = Object.freeze([0, 1, 2, 3]);

const DAY_MS = 86_400_000;
const list = value => Array.isArray(value) ? value : [];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestamp = value => Core.localDateTime(value)?.getTime() ?? 0;
const normalizeText = value => String(value ?? '').trim().toLowerCase();
const normalizeTags = tags => [...new Set((Array.isArray(tags) ? tags : String(tags ?? '').split(','))
  .map(tag => String(tag).trim()).filter(Boolean))];
const activeCharacters = state => list(state?.characters).filter(character => !character.archivedAt);

export function isPlannedActivity(activity) {
  return activity?.kind === 'planned';
}

export function createPlannedActivity(input, { id = Core.createId('activity-plan'), now = new Date() } = {}) {
  const nowIso = Core.isoNow(now);
  const status = ACTIVITY_STATUSES.includes(input?.status) ? input.status : 'todo';
  const repeatType = ACTIVITY_REPEAT_TYPES.includes(input?.repeatType) ? input.repeatType : 'one_time';
  const category = ACTIVITY_CATEGORIES.includes(input?.category) ? input.category : 'Custom';
  return {
    id,
    kind: 'planned',
    title: String(input?.title ?? '').trim(),
    description: String(input?.description ?? '').trim(),
    characterId: String(input?.characterId ?? ''),
    category,
    priority: Math.max(0, Math.min(3, number(input?.priority))),
    status,
    estimatedMinutes: Math.max(1, Math.round(number(input?.estimatedMinutes, 30))),
    repeatType,
    tags: normalizeTags(input?.tags),
    notes: String(input?.notes ?? '').trim(),
    scheduledFor: /^\d{4}-\d{2}-\d{2}$/.test(String(input?.scheduledFor ?? '')) ? String(input.scheduledFor) : null,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: status === 'completed' ? nowIso : null
  };
}

export function updatePlannedActivity(activity, changes, { now = new Date() } = {}) {
  if (!isPlannedActivity(activity)) throw new Error('Only planned activities can be edited by the Activities Engine.');
  const merged = createPlannedActivity({ ...activity, ...changes }, { id: activity.id, now });
  const status = ACTIVITY_STATUSES.includes(changes?.status) ? changes.status : activity.status;
  return {
    ...merged,
    createdAt: activity.createdAt,
    updatedAt: Core.isoNow(now),
    completedAt: status === 'completed' ? (activity.status === 'completed' ? activity.completedAt : Core.isoNow(now)) : null
  };
}

export function setPlannedActivityStatus(activity, status, { now = new Date() } = {}) {
  if (!ACTIVITY_STATUSES.includes(status)) throw new Error(`Unknown activity status: ${status}`);
  // Completing a repeating activity after its cadence rolls over starts a new
  // cycle, so record the new completion time rather than retaining the old one.
  if (status === 'completed' && effectiveActivityStatus(activity, now) !== 'completed') {
    return updatePlannedActivity({ ...activity, status: 'todo', completedAt: null }, { status }, { now });
  }
  return updatePlannedActivity(activity, { status }, { now });
}

export function duplicatePlannedActivity(activity, { id = Core.createId('activity-plan'), now = new Date() } = {}) {
  if (!isPlannedActivity(activity)) throw new Error('Only planned activities can be duplicated.');
  return createPlannedActivity({ ...activity, title: `${activity.title} copy`, status: 'todo' }, { id, now });
}

export function localWeekStart(value = new Date()) {
  const date = Core.localDateTime(value) ?? new Date();
  const start = new Date(date.getTime());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function effectiveActivityStatus(activity, now = new Date()) {
  if (!isPlannedActivity(activity)) return activity?.status ?? 'completed';
  if (activity.status !== 'completed') return activity.status;
  if (!activity.completedAt) return 'todo';
  if (activity.repeatType === 'daily' && Core.localDateKey(activity.completedAt) !== Core.localDateKey(now)) return 'todo';
  if (activity.repeatType === 'weekly' && timestamp(activity.completedAt) < localWeekStart(now).getTime()) return 'todo';
  return 'completed';
}

function compareActivities(a, b, sort) {
  if (sort === 'recent') return timestamp(b.updatedAt) - timestamp(a.updatedAt) || String(a.id).localeCompare(String(b.id));
  if (sort === 'estimated') return number(a.estimatedMinutes, Infinity) - number(b.estimatedMinutes, Infinity) || String(a.title).localeCompare(String(b.title));
  if (sort === 'alphabetical') return String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));
  return number(b.priority) - number(a.priority)
    || (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
    || timestamp(b.updatedAt) - timestamp(a.updatedAt)
    || String(a.title).localeCompare(String(b.title));
}

export function selectPlannedActivities(state, filters = {}) {
  const now = filters.now ?? new Date();
  const today = Core.localDateKey(now);
  const rosterIds = new Set(activeCharacters(state).map(character => character.id));
  const search = normalizeText(filters.search);
  const tagFilters = normalizeTags(filters.tags).map(normalizeText);
  return list(state?.activities)
    .filter(activity => isPlannedActivity(activity) && rosterIds.has(activity.characterId))
    .map(activity => ({ ...activity, effectiveStatus: effectiveActivityStatus(activity, now) }))
    .filter(activity => {
      if (filters.view === 'today' && (['completed', 'skipped'].includes(activity.effectiveStatus) || (activity.scheduledFor && activity.scheduledFor > today))) return false;
      if (filters.view === 'upcoming' && (!activity.scheduledFor || activity.scheduledFor <= today || ['completed', 'skipped'].includes(activity.effectiveStatus))) return false;
      if (filters.view === 'completed' && activity.effectiveStatus !== 'completed') return false;
      if (filters.characterId && activity.characterId !== filters.characterId) return false;
      if (filters.category && activity.category !== filters.category) return false;
      if (filters.priority !== undefined && filters.priority !== '' && number(activity.priority) !== number(filters.priority)) return false;
      if (filters.status && activity.effectiveStatus !== filters.status) return false;
      if (tagFilters.length && !tagFilters.every(tag => activity.tags.some(activityTag => normalizeText(activityTag).includes(tag)))) return false;
      if (search) {
        const haystack = normalizeText([activity.title, activity.description, activity.category, activity.notes, ...activity.tags].join(' '));
        if (!search.split(/\s+/).every(token => haystack.includes(token))) return false;
      }
      return true;
    })
    .sort((a, b) => compareActivities(a, b, filters.sort || 'priority'));
}

function plannerComparator(activeCharacterId, limitedTime) {
  return (a, b) => (a.effectiveStatus === 'in_progress' ? 0 : 1) - (b.effectiveStatus === 'in_progress' ? 0 : 1)
    || number(b.priority) - number(a.priority)
    || (a.characterId === activeCharacterId ? 0 : 1) - (b.characterId === activeCharacterId ? 0 : 1)
    || (limitedTime ? number(a.estimatedMinutes) - number(b.estimatedMinutes) : 0)
    || timestamp(b.updatedAt) - timestamp(a.updatedAt)
    || number(a.estimatedMinutes) - number(b.estimatedMinutes)
    || String(a.title).localeCompare(String(b.title))
    || String(a.id).localeCompare(String(b.id));
}

function plannerReason(activity, activeCharacterId, limitedTime) {
  if (activity.effectiveStatus === 'in_progress') return 'Already in progress';
  if (number(activity.priority) >= 2) return 'High-priority activity';
  if (activity.characterId === activeCharacterId) return 'Matches the active character';
  if (limitedTime && number(activity.estimatedMinutes) <= 30) return 'Fits a short session';
  return 'Builds on recent campaign momentum';
}

export function planSession(state, options = {}) {
  const budgetMinutes = Math.max(1, Math.round(number(options.budgetMinutes, 30)));
  const cap = budgetMinutes + 5;
  const lockedIds = new Set(list(options.lockedIds));
  const excludedIds = new Set(list(options.excludedIds));
  const order = list(options.currentOrder);
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const eligible = selectPlannedActivities(state, { view: 'today', now: options.now ?? new Date() })
    .filter(activity => !excludedIds.has(activity.id) && !['completed', 'skipped'].includes(activity.effectiveStatus));
  const locked = eligible.filter(activity => lockedIds.has(activity.id))
    .sort((a, b) => (orderIndex.get(a.id) ?? Infinity) - (orderIndex.get(b.id) ?? Infinity));
  const unlocked = eligible.filter(activity => !lockedIds.has(activity.id))
    .sort(plannerComparator(options.activeCharacterId ?? state?.activeCharacterId, budgetMinutes <= 60));
  const selected = [];
  let totalMinutes = 0;
  for (const activity of [...locked, ...unlocked]) {
    const minutes = Math.max(1, number(activity.estimatedMinutes, 30));
    if (totalMinutes + minutes > cap) continue;
    selected.push({
      activity,
      locked: lockedIds.has(activity.id),
      reason: plannerReason(activity, options.activeCharacterId ?? state?.activeCharacterId, budgetMinutes <= 60)
    });
    totalMinutes += minutes;
  }
  return {
    budgetMinutes,
    totalMinutes,
    items: selected,
    characterIds: [...new Set(selected.map(item => item.activity.characterId))],
    categories: [...new Set(selected.map(item => item.activity.category))]
  };
}

export function reorderPlan(items, fromIndex, toIndex) {
  const output = [...list(items)];
  if (fromIndex < 0 || fromIndex >= output.length || toIndex < 0 || toIndex >= output.length) return output;
  const [item] = output.splice(fromIndex, 1);
  output.splice(toIndex, 0, item);
  return output;
}

export function fuzzyScore(query, value) {
  const needle = normalizeText(query);
  const haystack = normalizeText(value);
  if (!needle) return 0;
  if (haystack === needle) return 120;
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return 90 - contiguous;
  let position = -1;
  let gaps = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, position + 1);
    if (next < 0) return -Infinity;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return 55 - gaps;
}

const fixedCommands = Object.freeze([
  ['nav-home', 'Go Home', 'Navigation', 'home', 'navigate', 'overview', 'command center dashboard'],
  ['nav-campaign', 'Open Campaign', 'Navigation', 'map', 'navigate-focus', 'campaign', 'campaign next up'],
  ['nav-activities', 'Open Activities', 'Navigation', 'list-checks', 'navigate', 'activities', 'tasks planner'],
  ['nav-characters', 'Open Characters', 'Navigation', 'users', 'focus-characters', '', 'roster switch character'],
  ['nav-collections', 'Open Collections', 'Navigation', 'gem', 'navigate', 'collections', 'mounts appearances pets'],
  ['nav-economy', 'Open Economy', 'Navigation', 'coins', 'navigate', 'gold', 'gold ledger'],
  ['nav-analytics', 'Open Analytics', 'Navigation', 'chart-no-axes-combined', 'navigate-focus', 'analytics', 'weekly momentum'],
  ['nav-settings', 'Open Settings', 'Navigation', 'settings', 'navigate-focus', 'settings', 'backup import export'],
  ['character-edit', 'Edit active character', 'Character', 'pencil', 'edit-character', '', 'profile'],
  ['character-add', 'Add character', 'Character', 'user-plus', 'add-character', '', 'new alt'],
  ['create-goal', 'Add goal', 'Creation', 'target', 'add-goal', '', 'objective outcome'],
  ['create-objective', 'Add objective', 'Creation', 'circle-dot-dashed', 'add-objective', '', 'campaign task'],
  ['create-session', 'Log session', 'Creation', 'timer', 'log-session', '', 'play journal'],
  ['create-gold', 'Log gold', 'Creation', 'coins', 'log-gold', '', 'economy revenue costs'],
  ['create-collection', 'Update collection', 'Creation', 'gem', 'update-collection', '', 'mount pet appearance'],
  ['create-activity', 'Create activity', 'Creation', 'list-plus', 'create-activity', '', 'planned work task'],
  ['session-plan', 'Plan a session', 'Session', 'calendar-clock', 'plan-session', '', 'generate play plan'],
  ['session-save-current', 'Save current plan', 'Session', 'save', 'save-current-plan', '', 'planner draft'],
  ['session-start-next', 'Start session', 'Session', 'play', 'start-next-session', '', 'ready saved plan'],
  ['session-history', 'Open session history', 'Session', 'history', 'session-history', '', 'saved completed abandoned'],
  ['utility-export', 'Export backup', 'Utility', 'download', 'export', '', 'data safety'],
  ['utility-import', 'Import backup', 'Utility', 'upload', 'import', '', 'restore data'],
  ['utility-sidebar', 'Toggle sidebar', 'Utility', 'panel-left-close', 'toggle-sidebar', '', 'collapse navigation'],
  ['utility-shortcuts', 'Open keyboard shortcuts', 'Utility', 'keyboard', 'shortcuts', '', 'help keys']
].map(([id, label, category, icon, action, target, keywords]) => ({ id, label, category, icon, action, target, keywords })));

export function buildCommandCatalog(state) {
  const characterMap = new Map(activeCharacters(state).map(character => [character.id, character]));
  const items = [...fixedCommands];
  for (const character of characterMap.values()) {
    items.push({ id: `switch:${character.id}`, label: `Switch to ${character.name}`, category: 'Character', icon: 'user-round', action: 'switch-character', target: character.id, character: character.name, keywords: `${character.race} ${character.className} ${character.realm}` });
    items.push({ id: `edit:${character.id}`, label: `Edit ${character.name}`, category: 'Character', icon: 'pencil', action: 'edit-specific-character', target: character.id, character: character.name, keywords: `${character.race} ${character.className} profile` });
  }
  for (const goal of list(state?.goals).filter(goal => characterMap.has(goal.characterId))) {
    items.push({ id: `goal:${goal.id}`, label: goal.title, category: goal.category === 'Current content' ? 'Objective' : 'Goal', icon: 'target', action: 'open-goal', target: goal.id, character: characterMap.get(goal.characterId)?.name, keywords: `${goal.category} ${goal.status}` });
  }
  for (const activity of list(state?.activities).filter(activity => characterMap.has(activity.characterId))) {
    const character = characterMap.get(activity.characterId);
    if (isPlannedActivity(activity)) items.push({ id: `activity:${activity.id}`, label: activity.title, category: 'Activity', icon: 'list-checks', action: 'open-activity', target: activity.id, character: character?.name, keywords: `${activity.category} ${activity.status} ${list(activity.tags).join(' ')}` });
    else if (activity.kind === 'gold') items.push({ id: `gold:${activity.id}`, label: activity.title || 'Gold activity', category: 'Gold', icon: 'coins', action: 'open-gold', target: activity.id, character: character?.name, keywords: activity.notes || '' });
  }
  for (const tracker of list(state?.collectionTrackers).filter(tracker => characterMap.has(tracker.characterId))) {
    items.push({ id: `collection:${tracker.id}`, label: `${tracker.name} collection`, category: 'Collection', icon: 'gem', action: 'open-collection', target: tracker.id, character: characterMap.get(tracker.characterId)?.name, keywords: `${tracker.owned} ${tracker.target}` });
  }
  const activeSession = list(state?.sessionPlans).find(plan => plan.status === 'in_progress') || list(state?.sessionPlans).find(plan => plan.status === 'paused');
  if (activeSession) {
    items.push({ id: `session-resume:${activeSession.id}`, label: activeSession.status === 'paused' ? 'Resume active session' : 'Open active session', category: 'Session', icon: 'play', action: activeSession.status === 'paused' ? 'resume-session' : 'open-session', target: activeSession.id, keywords: `${activeSession.title} ${activeSession.status}` });
    if (activeSession.status === 'in_progress') items.push({ id: `session-pause:${activeSession.id}`, label: 'Pause session', category: 'Session', icon: 'pause', action: 'pause-session', target: activeSession.id, keywords: activeSession.title });
    items.push({ id: `session-finish:${activeSession.id}`, label: 'Finish session', category: 'Session', icon: 'flag', action: 'finish-session', target: activeSession.id, keywords: activeSession.title });
  }
  for (const plan of list(state?.sessionPlans)) {
    items.push({ id: `session:${plan.id}`, label: plan.title, category: 'Saved session', icon: plan.status === 'completed' ? 'circle-check-big' : 'calendar-clock', action: 'open-session', target: plan.id, keywords: `${plan.status} ${plan.plannedFor} ${list(plan.characterIds).map(id => characterMap.get(id)?.name || '').join(' ')}` });
  }
  return items;
}

function commandUsage(history, id) {
  return number(history?.usage?.[id]);
}

export function searchCommands(items, query = '', { history = {}, limit = 12 } = {}) {
  const recent = list(history?.recent);
  const recentRank = new Map(recent.map((entry, index) => [typeof entry === 'string' ? entry : entry.id, index]));
  const needle = normalizeText(query);
  if (!needle) {
    return [...list(items)].sort((a, b) => (recentRank.get(a.id) ?? Infinity) - (recentRank.get(b.id) ?? Infinity)
      || commandUsage(history, b.id) - commandUsage(history, a.id)
      || String(a.category).localeCompare(String(b.category))
      || String(a.label).localeCompare(String(b.label))).slice(0, limit);
  }
  return list(items).map(item => {
    const labelScore = fuzzyScore(needle, item.label);
    const contextScore = fuzzyScore(needle, `${item.category} ${item.character || ''} ${item.keywords || ''}`) - 15;
    return { ...item, score: Math.max(labelScore, contextScore) + Math.min(12, commandUsage(history, item.id) * 1.5), matchedText: item.label };
  }).filter(item => Number.isFinite(item.score)).sort((a, b) => b.score - a.score
    || (recentRank.get(a.id) ?? Infinity) - (recentRank.get(b.id) ?? Infinity)
    || String(a.label).localeCompare(String(b.label))).slice(0, limit);
}

export function recordCommandUse(preferences, commandId, { now = new Date() } = {}) {
  const output = { ...(preferences || {}) };
  const existing = output.commandPalette || {};
  const recent = list(existing.recent).filter(entry => (typeof entry === 'string' ? entry : entry.id) !== commandId);
  output.commandPalette = {
    ...existing,
    recent: [{ id: commandId, usedAt: Core.isoNow(now) }, ...recent].slice(0, 8),
    usage: { ...(existing.usage || {}), [commandId]: number(existing.usage?.[commandId]) + 1 }
  };
  return output;
}

export function moveCommandSelection(index, direction, count) {
  if (count <= 0) return -1;
  if (direction > 0) return (Math.max(-1, index) + 1) % count;
  return (index <= 0 ? count : index) - 1;
}

export const ActivityEngine = Object.freeze({
  ACTIVITY_CATEGORIES, ACTIVITY_STATUSES, ACTIVITY_REPEAT_TYPES, ACTIVITY_PRIORITIES,
  isPlannedActivity, createPlannedActivity, updatePlannedActivity, setPlannedActivityStatus,
  duplicatePlannedActivity, effectiveActivityStatus, selectPlannedActivities, planSession,
  reorderPlan, fuzzyScore, buildCommandCatalog, searchCommands, recordCommandUse,
  moveCommandSelection, localWeekStart
});

globalThis.AzerothActivities = ActivityEngine;
