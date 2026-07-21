/*
 * Pure, schema-v2 selectors for the Command Center.
 * Nothing in this module writes to or mutates canonical campaign state.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');
const Activities = globalThis.AzerothActivities ?? await import('./activity-engine.mjs');
const Schedule = globalThis.AzerothSchedule ?? await import('./schedule-engine.mjs');
const Recommendations = globalThis.AzerothRecommendations ?? await import('./recommendation-engine.mjs');

const DAY_MS = 86_400_000;
const RECENT_DAYS = 7;
const FINISHED_STATUSES = new Set(['done', 'dismissed']);

const list = value => Array.isArray(value) ? value : [];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestamp = value => {
  const date = Core.localDateTime(value);
  return date ? date.getTime() : 0;
};
const isFinished = goal => goal?.status === 'done' || goal?.status === 'dismissed' || goal?.done === true;
const isArchived = character => Boolean(character?.archivedAt);
const charactersById = state => new Map(list(state?.characters).map(character => [character.id, character]));
const activeCharacters = state => list(state?.characters).filter(character => !isArchived(character));

function newestDate(...values) {
  return values.filter(Boolean).sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
}

function goalUpdatedAt(goal) {
  return newestDate(goal?.updatedAt, goal?.completedAt, goal?.createdAt);
}

function statusRank(status) {
  if (status === 'in_progress') return 0;
  if (status === 'todo' || !status) return 1;
  return 2;
}

function compareGoals(a, b) {
  return statusRank(a.status) - statusRank(b.status)
    || number(b.priority) - number(a.priority)
    || number(a.order, Number.MAX_SAFE_INTEGER) - number(b.order, Number.MAX_SAFE_INTEGER)
    || timestamp(goalUpdatedAt(b)) - timestamp(goalUpdatedAt(a))
    || timestamp(b.createdAt) - timestamp(a.createdAt)
    || String(a.id).localeCompare(String(b.id));
}

export function selectActiveGoals(state, { limit = 5 } = {}) {
  const rosterIds = new Set(activeCharacters(state).map(character => character.id));
  return list(state?.goals)
    .filter(goal => !isFinished(goal) && (goal.scope === 'account' || rosterIds.has(goal.characterId)))
    .sort(compareGoals)
    .slice(0, Math.max(0, limit));
}

export function selectGoalObjectiveCounts(state) {
  const counts = Object.fromEntries(activeCharacters(state).map(character => [character.id, { unfinished: 0, completed: 0, total: 0 }]));
  for (const goal of list(state?.goals)) {
    const count = counts[goal.characterId];
    if (!count) continue;
    count.total += 1;
    if (isFinished(goal)) count.completed += 1;
    else count.unfinished += 1;
  }
  return counts;
}

function activityCandidatesForCharacter(state, characterId) {
  const candidates = [];
  for (const activity of list(state?.activities)) {
    if (activity.characterId !== characterId) continue;
    if (Activities.isPlannedActivity(activity)) {
      if (activity.status === 'completed' && activity.completedAt && timestamp(activity.completedAt)) candidates.push({ type: 'planned', id: activity.id, at: activity.completedAt, record: activity });
      continue;
    }
    if (timestamp(activity.occurredAt)) candidates.push({ type: 'activity', id: activity.id, at: activity.occurredAt, record: activity });
  }
  for (const event of list(state?.progressEvents)) {
    if (event.entityId !== characterId || ['starter', 'legacy-current-observation'].includes(event.source) || !timestamp(event.recordedAt)) continue;
    candidates.push({ type: 'progress', id: event.id, at: event.recordedAt, record: event });
  }
  for (const goal of list(state?.goals)) {
    if (goal.characterId !== characterId || !isFinished(goal) || !timestamp(goal.completedAt)) continue;
    candidates.push({ type: 'goal', id: goal.id, at: goal.completedAt, record: goal });
  }
  return candidates;
}

export function selectLastActivityByCharacter(state) {
  return Object.fromEntries(activeCharacters(state).map(character => {
    const latest = activityCandidatesForCharacter(state, character.id)
      .sort((a, b) => timestamp(b.at) - timestamp(a.at) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
    return [character.id, latest];
  }));
}

function missingProfileFields(character) {
  return ['name', 'realm', 'region', 'race', 'className', 'spec', 'location']
    .filter(field => typeof character?.[field] !== 'string' || !character[field].trim());
}

export function selectCharacterAttention(state, { now = new Date() } = {}) {
  const counts = selectGoalObjectiveCounts(state);
  const lastActivity = selectLastActivityByCharacter(state);
  const recentCutoff = timestamp(now) - RECENT_DAYS * DAY_MS;
  return activeCharacters(state).map(character => {
    const unfinished = counts[character.id]?.unfinished ?? 0;
    const latest = lastActivity[character.id];
    const recent = latest && timestamp(latest.at) >= recentCutoff;
    const missingFields = missingProfileFields(character);
    const recentCompletion = list(state?.goals).some(goal => goal.characterId === character.id && isFinished(goal) && timestamp(goal.completedAt) >= recentCutoff);
    let attention = 'No current goals';
    if (missingFields.length) attention = 'Profile incomplete';
    else if (unfinished && recent) attention = 'Active';
    else if (unfinished) attention = 'Needs attention';
    else if (recentCompletion) attention = 'Recently completed';
    return { character, attention, unfinished, lastActivity: latest, missingFields };
  });
}

function metricCollectionName(metric) {
  const match = /^collection(?::|\.)([^:]+)(?::|\.)owned$/i.exec(String(metric || ''));
  return match ? match[1] : null;
}

function formatCollectionName(value) {
  return String(value || '').replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function selectRecentActivity(state, { limit = 10 } = {}) {
  const characterMap = charactersById(state);
  const visibleIds = new Set(activeCharacters(state).map(character => character.id));
  const activities = list(state?.activities).filter(activity => visibleIds.has(activity.characterId));
  const activityIds = new Set(activities.map(activity => activity.id));
  const entries = [];

  activities.forEach((activity, index) => {
    if (Activities.isPlannedActivity(activity)) {
      if (activity.status !== 'completed' || !activity.completedAt || !timestamp(activity.completedAt)) return;
      entries.push({
        id: `planned:${activity.id}:${index}`,
        sourceId: activity.id,
        kind: 'activity', category: activity.category || 'Activity',
        characterId: activity.characterId,
        character: characterMap.get(activity.characterId) ?? null,
        occurredAt: activity.completedAt,
        title: `Completed ${activity.title}`,
        detail: activity.notes || '',
        durationMinutes: number(activity.estimatedMinutes),
        goldDelta: 0,
        relatedTab: 'activities'
      });
      return;
    }
    const profit = number(activity.gold?.revenue) - number(activity.gold?.cost);
    const goldDelta = activity.kind === 'gold' ? profit : number(activity.gold?.delta);
    const title = activity.kind === 'session' ? 'Logged a play session'
      : activity.kind === 'gold' ? (activity.title || 'Recorded gold activity')
      : activity.kind === 'collection' ? (activity.title || 'Updated collection progress')
      : (activity.title || 'Added a campaign note');
    entries.push({
      id: `activity:${activity.id}:${index}`,
      sourceId: activity.id,
      kind: activity.kind,
      category: activity.kind === 'session' ? 'Session' : activity.kind === 'gold' ? 'Gold' : activity.kind === 'collection' ? 'Collection' : 'Note',
      characterId: activity.characterId,
      character: characterMap.get(activity.characterId) ?? null,
      occurredAt: activity.occurredAt,
      title,
      detail: activity.notes || '',
      durationMinutes: number(activity.durationMinutes),
      goldDelta,
      relatedTab: activity.kind === 'gold' ? 'gold' : activity.kind === 'collection' ? 'collections' : 'journal'
    });
  });

  list(state?.activityOccurrences).forEach((record, index) => {
    if (!visibleIds.has(record.characterId) || record.undoneAt || !['completed', 'skipped'].includes(record.status) || !timestamp(record.completedAt || record.skippedAt || record.recordedAt)) return;
    const activity = activities.find(item => item.id === record.activityId);
    if (!activity) return;
    entries.push({
      id: `occurrence:${record.id}:${index}`, sourceId: activity.id, kind: 'activity', category: activity.category || 'Activity',
      characterId: record.characterId, character: characterMap.get(record.characterId) ?? null,
      occurredAt: record.completedAt || record.skippedAt || record.recordedAt,
      title: `${record.status === 'completed' ? 'Completed' : 'Skipped'} ${activity.title}`,
      detail: record.notes || record.reason || '', durationMinutes: 0, goldDelta: 0, relatedTab: 'agenda'
    });
  });

  list(state?.progressEvents).forEach((event, index) => {
    if (!visibleIds.has(event.entityId) || ['starter', 'legacy-current-observation'].includes(event.source)) return;
    if (event.sourceActivityId && activityIds.has(event.sourceActivityId)) return;
    const collectionName = metricCollectionName(event.metric);
    let title = `${event.metric} updated`;
    let category = 'Progress';
    let relatedTab = 'overview';
    if (event.metric === 'level') title = `Reached level ${number(event.value)}`;
    else if (event.metric === 'liquidGold') { title = 'Updated liquid gold'; category = 'Gold'; relatedTab = 'gold'; }
    else if (collectionName) { title = `Updated ${formatCollectionName(collectionName)} to ${number(event.value).toLocaleString()}`; category = 'Collection'; relatedTab = 'collections'; }
    entries.push({
      id: `progress:${event.id}:${index}`,
      sourceId: event.id,
      kind: 'progress', category,
      characterId: event.entityId,
      character: characterMap.get(event.entityId) ?? null,
      occurredAt: event.recordedAt,
      title,
      detail: '',
      metric: event.metric,
      value: number(event.value),
      relatedTab
    });
  });

  list(state?.goals).forEach((goal, index) => {
    if (!visibleIds.has(goal.characterId) || !isFinished(goal) || !timestamp(goal.completedAt)) return;
    entries.push({
      id: `goal:${goal.id}:${index}`,
      sourceId: goal.id,
      kind: 'goal', category: goal.category || 'Goal',
      characterId: goal.characterId,
      character: characterMap.get(goal.characterId) ?? null,
      occurredAt: goal.completedAt,
      title: `Completed ${goal.title}`,
      detail: '', relatedTab: 'overview', goalId: goal.id
    });
  });

  return entries
    .filter(entry => timestamp(entry.occurredAt))
    .sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, limit));
}

export function localWeekBounds(now = new Date()) {
  const current = Core.localDateTime(now) ?? new Date();
  const start = new Date(current.getTime());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);
  return { start, end, startKey: Core.localDateKey(start), endKey: Core.localDateKey(new Date(end.getTime() - 1)) };
}

function inCurrentWeek(value, bounds) {
  const time = timestamp(value);
  return time >= bounds.start.getTime() && time < bounds.end.getTime();
}

export function selectWeeklyMomentum(state, { scope = 'active', activeCharacterId = state?.activeCharacterId, now = new Date() } = {}) {
  const bounds = localWeekBounds(now);
  const rosterIds = new Set(activeCharacters(state).map(character => character.id));
  const selectedIds = scope === 'all' ? rosterIds : new Set(rosterIds.has(activeCharacterId) ? [activeCharacterId] : []);
  const activities = list(state?.activities).filter(activity => !Activities.isPlannedActivity(activity) && selectedIds.has(activity.characterId) && inCurrentWeek(activity.occurredAt, bounds));
  const sessions = activities.filter(activity => activity.kind === 'session');
  let goldEarned = 0;
  let goldSpent = 0;
  const activeIds = new Set();
  for (const activity of activities) {
    activeIds.add(activity.characterId);
    if (activity.kind === 'gold') {
      goldEarned += Math.max(0, number(activity.gold?.revenue));
      goldSpent += Math.max(0, number(activity.gold?.cost));
    } else {
      const delta = number(activity.gold?.delta);
      if (delta > 0) goldEarned += delta;
      if (delta < 0) goldSpent += Math.abs(delta);
    }
  }
  const completedGoals = list(state?.goals).filter(goal => selectedIds.has(goal.characterId) && isFinished(goal) && inCurrentWeek(goal.completedAt, bounds));
  completedGoals.forEach(goal => activeIds.add(goal.characterId));
  const completedActivities = list(state?.activities).filter(activity => Activities.isPlannedActivity(activity) && selectedIds.has(activity.characterId) && activity.status === 'completed' && activity.completedAt && inCurrentWeek(activity.completedAt, bounds));
  completedActivities.forEach(activity => activeIds.add(activity.characterId));
  const completedOccurrences = list(state?.activityOccurrences).filter(record => !record.undoneAt && record.status === 'completed' && selectedIds.has(record.characterId) && inCurrentWeek(record.completedAt || record.recordedAt, bounds));
  completedOccurrences.forEach(record => activeIds.add(record.characterId));
  const completionKeys = new Set();
  completedActivities.forEach(activity => completionKeys.add(`${activity.id}:${Schedule.occurrenceKeyForDate(activity, Core.localDateKey(activity.completedAt))}`));
  completedOccurrences.forEach(record => completionKeys.add(`${record.activityId}:${record.occurrenceKey}`));
  list(state?.sessionPlans).filter(plan => plan.status === 'completed' && inCurrentWeek(plan.completedAt || plan.endedAt, bounds)).forEach(plan => {
    list(plan.items).filter(item => item.status === 'completed' && selectedIds.has(item.characterId)).forEach(item => {
      const activity = list(state?.activities).find(candidate => candidate.id === item.activityId);
      const occurredAt = item.completedAt || plan.completedAt || plan.endedAt;
      completionKeys.add(activity ? `${activity.id}:${Schedule.occurrenceKeyForDate(activity, Core.localDateKey(occurredAt))}` : `session:${plan.id}:${item.id}`);
      activeIds.add(item.characterId);
    });
  });
  const collectionEvents = list(state?.progressEvents).filter(event => selectedIds.has(event.entityId) && metricCollectionName(event.metric) && inCurrentWeek(event.recordedAt, bounds));
  collectionEvents.forEach(event => activeIds.add(event.entityId));
  return {
    scope,
    bounds,
    sessions: sessions.length,
    minutesPlayed: sessions.reduce((sum, activity) => sum + Math.max(0, number(activity.durationMinutes)), 0),
    completed: completedGoals.length + completionKeys.size,
    goldEarned,
    goldSpent,
    netGold: goldEarned - goldSpent,
    collectionUpdates: collectionEvents.length,
    activeCharacters: activeIds.size
  };
}

export function selectNextUp(state, { limit = 5, now = new Date(), availableMinutes = null, strategy = state?.preferences?.planningStrategy || 'balanced', excludedKeys = [] } = {}) {
  const ranked = Recommendations.rankRecommendations(state, { limit, now, availableMinutes, strategy, excludedKeys });
  const rankedGoals = list(state?.goals).filter(goal => !isFinished(goal));
  const highestRankedPriority = rankedGoals.reduce((highest, goal) => Math.max(highest, number(goal.priority)), -Infinity);
  const rankedRecentCutoff = timestamp(now) - RECENT_DAYS * DAY_MS;
  return ranked.map(item => {
    let reason = item.reason;
    if (item.sourceType === 'session') reason = item.status === 'in_progress' ? 'Active session' : item.status === 'paused' ? 'Paused session' : 'Ready for today';
    else if (item.sourceType === 'activity') reason = item.availability?.state === 'due_today' ? 'Due today' : item.status === 'in_progress' ? 'Already in progress' : number(item.priority) >= 2 ? 'High-priority activity' : item.characterId === state?.activeCharacterId ? 'Active character activity' : 'Ready to work on';
    else if (item.sourceType === 'goal') {
      if (item.status === 'in_progress') reason = 'Already in progress';
      else if (number(item.priority) === highestRankedPriority && highestRankedPriority > 0) reason = 'Highest-priority unfinished goal';
      else if (item.source?.updatedAt && item.source.updatedAt !== item.source.createdAt && timestamp(item.source.updatedAt) >= rankedRecentCutoff) reason = 'Recently updated';
      else reason = 'Unfinished goal';
    } else if (item.sourceType === 'collection') reason = item.progress?.target && item.progress.current / item.progress.target >= 0.8 ? 'Close to the next milestone' : 'Unfinished collection milestone';
    return { ...item, reason };
  });
}

export const Selectors = Object.freeze({
  selectActiveGoals,
  selectGoalObjectiveCounts,
  selectLastActivityByCharacter,
  selectCharacterAttention,
  selectRecentActivity,
  localWeekBounds,
  selectWeeklyMomentum,
  selectNextUp
});

globalThis.AzerothSelectors = Selectors;
