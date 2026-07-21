/*
 * Deterministic recommendation, history, and planning intelligence.
 *
 * Scores are derived at read time and are never persisted. The deliberately
 * named weights below are the single product configuration shared by the
 * Command Center, Daily Agenda, and time-budget planner.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');
const Schedule = globalThis.AzerothSchedule ?? await import('./schedule-engine.mjs');

export const MIN_HISTORY_SAMPLES = 3;
export const MAX_RECOMMENDATION_HISTORY = 200;
export const RECOMMENDATION_HISTORY_DAYS = 180;
export const CHARACTER_ROLES = Object.freeze(['main', 'active_alt', 'occasional', 'resting']);
export const RECOMMENDATION_RESPONSES = Object.freeze(['opened', 'started', 'completed', 'skipped', 'dismissed', 'snoozed', 'ignored', 'useful', 'not_useful', 'not_today']);

export const SCORING_CONFIG = Object.freeze({
  activeSession: 1200,
  pausedSession: 1100,
  readySessionToday: 900,
  availableNow: 400,
  inProgress: 220,
  overdue: 210,
  dueToday: 180,
  dueSoon: 115,
  dueTimeUrgency: 80,
  priority: Object.freeze([0, 30, 80, 135]),
  activeCharacter: 45,
  characterRole: Object.freeze({ main: 40, active_alt: 24, occasional: 4, resting: -120 }),
  recentMomentum: 38,
  closeToCompletion: 45,
  fitsTimeBudget: 42,
  explicitlySelected: 160,
  explicitlyLocked: 230,
  characterNeedsPlan: 22,
  repeatedlySkipped: -70,
  recentlyCompleted: -180,
  recentlyRecommended: -30,
  feedbackUseful: 18,
  feedbackNotUseful: -55,
  snoozed: -10000,
  dismissed: -10000,
  blocked: -10000,
  unavailable: -10000,
  missingInformation: -90
});

export const PLANNING_STRATEGIES = Object.freeze({
  focused: Object.freeze({ id: 'focused', label: 'Focused', bufferMinutes: 5, characterSwitchPenalty: 120, categorySwitchPenalty: 55, shortActivityBoost: 10, campaignBoost: 10, goldBoost: 0 }),
  balanced: Object.freeze({ id: 'balanced', label: 'Balanced', bufferMinutes: 5, characterSwitchPenalty: 28, categorySwitchPenalty: 12, shortActivityBoost: 18, campaignBoost: 10, goldBoost: 0 }),
  maximum_completion: Object.freeze({ id: 'maximum_completion', label: 'Maximum completion', bufferMinutes: 3, characterSwitchPenalty: 12, categorySwitchPenalty: 5, shortActivityBoost: 95, campaignBoost: 0, goldBoost: 0 }),
  gold_focused: Object.freeze({ id: 'gold_focused', label: 'Gold focused', bufferMinutes: 5, characterSwitchPenalty: 25, categorySwitchPenalty: 10, shortActivityBoost: 15, campaignBoost: 0, goldBoost: 260 }),
  campaign_focused: Object.freeze({ id: 'campaign_focused', label: 'Campaign focused', bufferMinutes: 5, characterSwitchPenalty: 35, categorySwitchPenalty: 16, shortActivityBoost: 12, campaignBoost: 140, goldBoost: 0 })
});

const DAY_MS = 86_400_000;
const list = value => Array.isArray(value) ? value : [];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestamp = value => Core.localDateTime(value)?.getTime() || 0;
const planned = activity => activity?.kind === 'planned';
const terminal = status => ['completed', 'partial', 'skipped'].includes(status);
const activeAvailability = state => ['available_now', 'due_today', 'due_later_today', 'manual_available'].includes(state);

function median(values) {
  const sorted = list(values).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const clean = list(values).map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function addLocalDays(value, amount) {
  const date = Core.localDateTime(value) || new Date();
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + amount);
  return next;
}

function nextLocalMidnight(value = new Date()) {
  const next = addLocalDays(value, 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

function activityRuns(state, activityId) {
  const runs = [];
  for (const plan of list(state?.sessionPlans)) {
    for (const item of list(plan.items)) {
      if (item.activityId !== activityId || !terminal(item.status)) continue;
      runs.push({
        id: `session:${plan.id}:${item.id}`,
        status: item.status,
        occurredAt: item.completedAt || plan.completedAt || plan.endedAt,
        actualMinutes: number(item.actualMinutes),
        goldEarned: number(item.goldEarned),
        goldSpent: number(item.goldSpent),
        characterId: item.characterId
      });
    }
  }
  for (const record of list(state?.activityOccurrences)) {
    if (record.activityId !== activityId || record.undoneAt || !['completed', 'skipped'].includes(record.status)) continue;
    runs.push({
      id: `occurrence:${record.id}`,
      status: record.status,
      occurredAt: record.completedAt || record.skippedAt || record.recordedAt,
      actualMinutes: number(record.actualMinutes),
      goldEarned: number(record.goldEarned),
      goldSpent: number(record.goldSpent),
      characterId: record.characterId
    });
  }
  return runs.filter(run => timestamp(run.occurredAt)).sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt) || a.id.localeCompare(b.id));
}

export function historicalActivityMetrics(state, activityOrId) {
  const activity = typeof activityOrId === 'string' ? list(state?.activities).find(item => item.id === activityOrId) : activityOrId;
  const runs = activity ? activityRuns(state, activity.id) : [];
  const completed = runs.filter(run => run.status === 'completed');
  const partial = runs.filter(run => run.status === 'partial');
  const skipped = runs.filter(run => run.status === 'skipped');
  const durationRuns = runs.filter(run => run.status !== 'skipped' && run.actualMinutes > 0);
  const durations = durationRuns.map(run => run.actualMinutes);
  const goldRuns = durationRuns.filter(run => run.goldEarned || run.goldSpent);
  const goldResults = goldRuns.map(run => run.goldEarned - run.goldSpent);
  const goldRates = goldRuns.map(run => (run.goldEarned - run.goldSpent) / run.actualMinutes * 60).filter(Number.isFinite);
  const characterCounts = new Map();
  runs.forEach(run => characterCounts.set(run.characterId, (characterCounts.get(run.characterId) || 0) + 1));
  const typicalCharacterId = [...characterCounts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
  let recentStreak = 0;
  for (const run of runs) { if (run.status === 'completed') recentStreak += 1; else break; }
  const typicalDuration = median(durations);
  const estimate = number(activity?.estimatedMinutes);
  return {
    activityId: activity?.id || String(activityOrId || ''),
    runs: runs.length,
    completed: completed.length,
    skipped: skipped.length,
    partial: partial.length,
    completionRate: runs.length ? completed.length / runs.length : null,
    skipRate: runs.length ? skipped.length / runs.length : null,
    partialRate: runs.length ? partial.length / runs.length : null,
    medianDuration: typicalDuration,
    trustedDuration: durations.length >= MIN_HISTORY_SAMPLES,
    durationSamples: durations.length,
    averageGoldResult: average(goldResults),
    totalGoldEarned: runs.reduce((sum, run) => sum + run.goldEarned, 0),
    totalGoldSpent: runs.reduce((sum, run) => sum + run.goldSpent, 0),
    medianGoldPerHour: goldRates.length >= MIN_HISTORY_SAMPLES ? median(goldRates) : null,
    goldSamples: goldRates.length,
    typicalCharacterId,
    lastCompletedAt: completed[0]?.occurredAt || null,
    recentResult: runs[0] || null,
    recentStreak,
    estimateVarianceMinutes: typicalDuration === null || !estimate ? null : typicalDuration - estimate,
    planningMinutes: durations.length >= MIN_HISTORY_SAMPLES ? Math.max(1, Math.round(typicalDuration)) : Math.max(1, estimate || 30),
    usesHistoricalDuration: durations.length >= MIN_HISTORY_SAMPLES
  };
}

export function durationFit(candidate, availableMinutes, metrics = candidate?.metrics) {
  const budget = number(availableMinutes, Infinity);
  const minutes = Math.max(1, number(metrics?.planningMinutes, candidate?.estimatedMinutes || 30));
  if (!Number.isFinite(budget)) return { fits: true, minutes, ratio: 0, value: 0, usesHistoricalDuration: Boolean(metrics?.usesHistoricalDuration) };
  const remaining = budget - minutes;
  const fits = remaining >= 0;
  const closeness = fits ? Math.max(0, 1 - remaining / Math.max(1, budget)) : -Math.min(2, Math.abs(remaining) / Math.max(1, budget));
  return { fits, minutes, ratio: closeness, value: fits ? Math.round(SCORING_CONFIG.fitsTimeBudget * (0.55 + closeness * 0.45)) : Math.round(SCORING_CONFIG.unavailable / 5), usesHistoricalDuration: Boolean(metrics?.usesHistoricalDuration) };
}

export function goldEfficiency(metrics) {
  return metrics?.goldSamples >= MIN_HISTORY_SAMPLES && Number.isFinite(metrics?.medianGoldPerHour)
    ? { trusted: true, medianGoldPerHour: metrics.medianGoldPerHour, samples: metrics.goldSamples }
    : { trusted: false, medianGoldPerHour: null, samples: number(metrics?.goldSamples) };
}

function historyKey(type, entityId) { return `${type}:${entityId}`; }

export function pruneRecommendationHistory(history, { now = new Date(), maxEntries = MAX_RECOMMENDATION_HISTORY, maxAgeDays = RECOMMENDATION_HISTORY_DAYS } = {}) {
  const cutoff = timestamp(now) - Math.max(1, maxAgeDays) * DAY_MS;
  return list(history).filter(record => timestamp(record.lastShownAt || record.firstShownAt) >= cutoff)
    .sort((a, b) => timestamp(b.lastShownAt || b.firstShownAt) - timestamp(a.lastShownAt || a.firstShownAt) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, maxEntries)).map(Core.clone);
}

export function recordRecommendationImpressions(history, candidates, { now = new Date() } = {}) {
  const output = pruneRecommendationHistory(history, { now });
  const today = Core.localDateKey(now);
  let changed = output.length !== list(history).length;
  for (const candidate of list(candidates)) {
    const type = candidate.sourceType || candidate.entityType || 'unknown';
    const entityId = candidate.sourceId || candidate.entityId;
    if (!entityId) continue;
    const existing = output.find(record => record.recommendationType === type && record.entityId === entityId);
    if (existing && Core.localDateKey(existing.lastShownAt) === today) continue;
    const at = Core.isoNow(now);
    if (existing) {
      existing.lastShownAt = at;
      existing.timesShown = Math.max(1, number(existing.timesShown, 1)) + 1;
      existing.characterId = candidate.characterId || existing.characterId || null;
    } else {
      output.push({
        id: Core.deterministicId('recommendation-history', [type, entityId]),
        entityId,
        recommendationType: type,
        characterId: candidate.characterId || null,
        firstShownAt: at,
        lastShownAt: at,
        timesShown: 1,
        lastUserResponse: null,
        dismissedUntil: null
      });
    }
    changed = true;
  }
  return { history: pruneRecommendationHistory(output, { now }), changed };
}

export function applyRecommendationFeedback(history, candidate, response, { now = new Date(), dismissDays = 7 } = {}) {
  if (!RECOMMENDATION_RESPONSES.includes(response)) throw new Error('Unknown recommendation response.');
  const type = candidate?.sourceType || candidate?.entityType || 'unknown';
  const entityId = candidate?.sourceId || candidate?.entityId;
  if (!entityId) throw new Error('Recommendation feedback requires an entity.');
  const output = pruneRecommendationHistory(history, { now });
  let record = output.find(item => item.recommendationType === type && item.entityId === entityId);
  const at = Core.isoNow(now);
  if (!record) {
    record = { id: Core.deterministicId('recommendation-history', [type, entityId]), entityId, recommendationType: type, characterId: candidate.characterId || null, firstShownAt: at, lastShownAt: at, timesShown: 1, lastUserResponse: null, dismissedUntil: null };
    output.push(record);
  }
  record.lastUserResponse = response;
  record.characterId = candidate.characterId || record.characterId || null;
  if (response === 'not_today') record.dismissedUntil = nextLocalMidnight(now).toISOString();
  else if (response === 'dismissed') record.dismissedUntil = addLocalDays(now, Math.max(1, dismissDays)).toISOString();
  else if (!['snoozed'].includes(response)) record.dismissedUntil = null;
  return pruneRecommendationHistory(output, { now });
}

export function recommendationHistoryFor(history, candidate) {
  const type = candidate?.sourceType || candidate?.entityType || 'unknown';
  const entityId = candidate?.sourceId || candidate?.entityId;
  return list(history).find(record => record.recommendationType === type && record.entityId === entityId) || null;
}

export function recommendationSuppressed(history, candidate, { now = new Date() } = {}) {
  const record = recommendationHistoryFor(history, candidate);
  return Boolean(record?.dismissedUntil && timestamp(record.dismissedUntil) > timestamp(now));
}

function goalProgress(goal) {
  const current = goal?.progress?.current ?? goal?.current ?? goal?.value;
  const target = goal?.progress?.target ?? goal?.target;
  return Number.isFinite(Number(current)) && Number(target) > 0 ? { current: Number(current), target: Number(target) } : null;
}

function characterMap(state) { return new Map(list(state?.characters).map(character => [character.id, character])); }
function activeRoster(state) { return list(state?.characters).filter(character => !character.archivedAt); }

export function generateRecommendationCandidates(state, { now = new Date() } = {}) {
  const roster = activeRoster(state);
  const rosterIds = new Set(roster.map(character => character.id));
  const characters = characterMap(state);
  const output = [];
  const today = Core.localDateKey(now);

  for (const plan of list(state?.sessionPlans)) {
    if (!['in_progress', 'paused'].includes(plan.status) && !(plan.status === 'ready' && plan.plannedFor === today)) continue;
    const current = list(plan.items).find(item => item.id === plan.currentItemId) || list(plan.items).find(item => !terminal(item.status));
    const characterId = current?.characterId || plan.characterIds?.[0] || '';
    output.push({
      id: `session:${plan.id}`, sourceType: 'session', sourceId: plan.id, source: plan,
      title: plan.status === 'ready' ? plan.title : current?.snapshot?.title || plan.title,
      characterId, character: characters.get(characterId) || null, category: 'Session', priority: 3,
      status: plan.status, estimatedMinutes: number(plan.totalEstimatedMinutes), updatedAt: plan.updatedAt,
      progress: { current: list(plan.items).filter(item => terminal(item.status)).length, target: list(plan.items).length },
      action: plan.status === 'ready' ? 'start-session' : 'open-session', actionLabel: plan.status === 'ready' ? 'Start session' : 'Resume session', available: true
    });
  }

  for (const activity of list(state?.activities).filter(item => planned(item) && rosterIds.has(item.characterId))) {
    const availability = Schedule.activityAvailability(activity, state, { now });
    const metrics = historicalActivityMetrics(state, activity);
    output.push({
      id: `activity:${activity.id}`, sourceType: 'activity', sourceId: activity.id, source: activity,
      title: activity.title, characterId: activity.characterId, character: characters.get(activity.characterId) || null,
      category: activity.category || 'Activity', priority: number(activity.priority), status: activity.status,
      estimatedMinutes: number(activity.estimatedMinutes, 30), updatedAt: activity.updatedAt, progress: null,
      availability, metrics, blocked: Boolean(activity.blockedAt), available: activeAvailability(availability.state) && !activity.blockedAt,
      action: 'start-activity', actionLabel: 'Do this now'
    });
  }

  for (const goal of list(state?.goals)) {
    if (['done', 'dismissed'].includes(goal.status) || goal.done || (goal.scope !== 'account' && !rosterIds.has(goal.characterId))) continue;
    output.push({
      id: `goal:${goal.id}`, sourceType: 'goal', sourceId: goal.id, source: goal,
      title: goal.title, characterId: goal.characterId, character: characters.get(goal.characterId) || null,
      category: goal.category || 'Goal', priority: number(goal.priority), status: goal.status,
      estimatedMinutes: number(goal.estimatedMinutes), updatedAt: goal.updatedAt || goal.createdAt,
      progress: goalProgress(goal), available: true, action: 'open-goal', actionLabel: 'Open goal'
    });
  }

  for (const tracker of list(state?.collectionTrackers)) {
    if (!rosterIds.has(tracker.characterId) || number(tracker.target) <= 0 || number(tracker.owned) >= number(tracker.target)) continue;
    output.push({
      id: `collection:${tracker.id}`, sourceType: 'collection', sourceId: tracker.id, source: tracker,
      title: `${tracker.name}: ${number(tracker.target).toLocaleString()} milestone`, characterId: tracker.characterId,
      character: characters.get(tracker.characterId) || null, category: 'Collection', priority: 0, status: 'todo',
      progress: { current: number(tracker.owned), target: number(tracker.target) }, available: true,
      action: 'open-collections', actionLabel: 'Update progress'
    });
  }
  return output;
}

export function deduplicateCandidates(candidates, { excludedKeys = [] } = {}) {
  const excluded = new Set(excludedKeys);
  const seen = new Set();
  return list(candidates).filter(candidate => {
    const key = historyKey(candidate.sourceType, candidate.sourceId);
    if (excluded.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factor(listValue, key, label, value) {
  if (!value) return;
  listValue.push({ key, label, value });
}

function roleFor(character, state) {
  if (CHARACTER_ROLES.includes(character?.campaignRole)) return character.campaignRole;
  return character?.id && character.id !== state?.activeCharacterId ? 'active_alt' : 'main';
}

function mainReason(factors, candidate) {
  const positives = factors.filter(item => item.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (!positives.length) return candidate.sourceType === 'activity' ? 'Available campaign work' : 'Relevant campaign work';
  if (positives.length === 1) return positives[0].label;
  return `${positives[0].label} and ${positives[1].label.charAt(0).toLowerCase()}${positives[1].label.slice(1)}`;
}

export function scoreRecommendation(candidate, state, options = {}) {
  const now = options.now || new Date();
  const factors = [];
  const role = roleFor(candidate.character, state);
  const availability = candidate.availability;
  const metrics = candidate.metrics;
  const history = recommendationHistoryFor(state?.recommendationHistory, candidate);
  const strategy = PLANNING_STRATEGIES[options.strategy] || PLANNING_STRATEGIES.balanced;

  factor(factors, 'activeSession', 'Active session', candidate.status === 'in_progress' && candidate.sourceType === 'session' ? SCORING_CONFIG.activeSession : 0);
  factor(factors, 'pausedSession', 'Paused session ready to resume', candidate.status === 'paused' && candidate.sourceType === 'session' ? SCORING_CONFIG.pausedSession : 0);
  factor(factors, 'readySessionToday', 'Ready session planned for today', candidate.status === 'ready' && candidate.sourceType === 'session' ? SCORING_CONFIG.readySessionToday : 0);
  factor(factors, 'availableNow', 'Available now', candidate.sourceType === 'activity' && activeAvailability(availability?.state) ? SCORING_CONFIG.availableNow : 0);
  factor(factors, 'inProgress', 'Already in progress', candidate.status === 'in_progress' && candidate.sourceType !== 'session' ? SCORING_CONFIG.inProgress : 0);
  factor(factors, 'overdue', 'Missed scheduled work', availability?.state === 'missed' ? SCORING_CONFIG.overdue : 0);
  factor(factors, 'dueToday', 'Due today', availability?.state === 'due_today' ? SCORING_CONFIG.dueToday : 0);
  factor(factors, 'dueSoon', 'Due later today', availability?.state === 'due_later_today' ? SCORING_CONFIG.dueSoon : 0);
  if (availability?.dueAt) {
    const minutes = (timestamp(availability.dueAt) - timestamp(now)) / 60_000;
    if (minutes >= 0 && minutes <= 180) factor(factors, 'dueTimeUrgency', 'Due time is approaching', Math.round(SCORING_CONFIG.dueTimeUrgency * (1 - minutes / 240)));
  }
  factor(factors, 'priority', candidate.priority >= 3 ? 'Critical priority' : candidate.priority === 2 ? 'High priority' : candidate.priority === 1 ? 'Normal priority' : 'Low priority', SCORING_CONFIG.priority[Math.max(0, Math.min(3, number(candidate.priority)))]);
  factor(factors, 'activeCharacter', 'Matches the active character', candidate.characterId && candidate.characterId === state?.activeCharacterId ? SCORING_CONFIG.activeCharacter : 0);
  factor(factors, 'characterRole', role === 'main' ? 'Main character focus' : role === 'active_alt' ? 'Active alt' : role === 'resting' ? 'Character is resting' : 'Occasional character', SCORING_CONFIG.characterRole[role]);
  if ((metrics?.lastCompletedAt && timestamp(metrics.lastCompletedAt) >= timestamp(now) - 7 * DAY_MS) || (candidate.source?.updatedAt && timestamp(candidate.source.updatedAt) >= timestamp(now) - 7 * DAY_MS)) factor(factors, 'recentMomentum', 'Builds on recent activity', SCORING_CONFIG.recentMomentum);
  if (candidate.progress && candidate.progress.target > 0 && candidate.progress.current / candidate.progress.target >= 0.8) factor(factors, 'closeToCompletion', 'Close to completion', SCORING_CONFIG.closeToCompletion);
  if (options.availableMinutes && candidate.sourceType === 'activity') {
    const fit = durationFit(candidate, options.availableMinutes, metrics);
    factor(factors, 'fitsTimeBudget', fit.usesHistoricalDuration ? `Fits ${options.availableMinutes} minutes using run history` : `Fits ${options.availableMinutes} minutes`, fit.value);
  }
  factor(factors, 'explicitlySelected', 'Explicitly selected', list(options.selectedIds).includes(candidate.sourceId) ? SCORING_CONFIG.explicitlySelected : 0);
  factor(factors, 'explicitlyLocked', 'Locked into this plan', list(options.lockedIds).includes(candidate.sourceId) ? SCORING_CONFIG.explicitlyLocked : 0);
  if (metrics?.skipped >= 2) factor(factors, 'repeatedlySkipped', 'Repeatedly skipped', SCORING_CONFIG.repeatedlySkipped * Math.min(3, metrics.skipped - 1));
  if (metrics?.lastCompletedAt && timestamp(metrics.lastCompletedAt) >= timestamp(now) - DAY_MS) factor(factors, 'recentlyCompleted', 'Completed recently', SCORING_CONFIG.recentlyCompleted);
  if (history && Core.localDateKey(history.lastShownAt) !== Core.localDateKey(now) && timestamp(history.lastShownAt) >= timestamp(now) - 7 * DAY_MS) factor(factors, 'recentlyRecommended', 'Shown repeatedly recently', SCORING_CONFIG.recentlyRecommended * Math.min(4, number(history.timesShown, 1)));
  if (history?.lastUserResponse === 'useful') factor(factors, 'feedbackUseful', 'Previously marked useful', SCORING_CONFIG.feedbackUseful);
  if (history?.lastUserResponse === 'not_useful') factor(factors, 'feedbackNotUseful', 'Previously marked not useful', SCORING_CONFIG.feedbackNotUseful);
  if (strategy.id === 'campaign_focused' && ['Campaign', 'Current content'].includes(candidate.category)) factor(factors, 'strategyCampaign', 'Matches Campaign focused planning', strategy.campaignBoost);
  if (strategy.id === 'gold_focused' && candidate.sourceType === 'activity') {
    const efficiency = goldEfficiency(metrics);
    if (efficiency.trusted) factor(factors, 'strategyGold', 'Backed by repeated gold results', strategy.goldBoost + Math.min(120, Math.max(-60, Math.round(efficiency.medianGoldPerHour / 10))));
  }
  if (strategy.id === 'maximum_completion' && candidate.sourceType === 'activity') {
    const minutes = metrics?.planningMinutes || candidate.estimatedMinutes || 30;
    factor(factors, 'strategyShort', 'Short activity for more completions', Math.max(0, strategy.shortActivityBoost - Math.round(minutes * 3)));
  }

  if (availability?.reason === 'snoozed') factor(factors, 'snoozed', 'Snoozed until later', SCORING_CONFIG.snoozed);
  if (recommendationSuppressed(state?.recommendationHistory, candidate, { now })) factor(factors, 'dismissed', 'Dismissed for now', SCORING_CONFIG.dismissed);
  if (candidate.blocked) factor(factors, 'blocked', 'Marked blocked', SCORING_CONFIG.blocked);
  if (candidate.available === false || (availability && !activeAvailability(availability.state))) factor(factors, 'unavailable', 'Not currently available', SCORING_CONFIG.unavailable);
  if (candidate.sourceType === 'character' && candidate.missingInformation) factor(factors, 'missingInformation', 'Missing required profile information', SCORING_CONFIG.missingInformation);

  const score = factors.reduce((sum, item) => sum + item.value, 0);
  return { ...candidate, score, factors: factors.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.key.localeCompare(b.key)), reason: mainReason(factors, candidate) };
}

export function rankRecommendations(state, options = {}) {
  const candidates = options.candidates || generateRecommendationCandidates(state, options);
  return deduplicateCandidates(candidates, { excludedKeys: options.excludedKeys }).map(candidate => scoreRecommendation(candidate, state, options))
    .filter(candidate => candidate.score > SCORING_CONFIG.unavailable / 2)
    .sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(0, number(options.limit, 5)));
}

function missingProfileFields(character) {
  return ['name', 'realm', 'region', 'race', 'className', 'spec', 'location'].filter(field => typeof character?.[field] !== 'string' || !character[field].trim());
}

export function characterAttention(state, { now = new Date() } = {}) {
  const activities = list(state?.activities).filter(planned);
  return list(state?.characters).map(character => {
    const role = roleFor(character, state);
    const missingFields = missingProfileFields(character);
    const characterActivities = activities.filter(activity => activity.characterId === character.id);
    const availability = characterActivities.map(activity => ({ activity, availability: Schedule.activityAvailability(activity, state, { now }), metrics: historicalActivityMetrics(state, activity) }));
    const activeSession = list(state?.sessionPlans).find(plan => ['in_progress', 'paused'].includes(plan.status) && list(plan.characterIds).includes(character.id));
    const activeGoals = list(state?.goals).filter(goal => goal.characterId === character.id && !['done', 'dismissed'].includes(goal.status));
    const due = availability.filter(item => ['due_today', 'due_later_today', 'missed'].includes(item.availability.state));
    const deferred = availability.reduce((sum, item) => sum + (item.metrics.skipped >= 2 ? 1 : 0), 0);
    const latest = [...activityRunsForCharacter(state, character.id)].sort((a, b) => timestamp(b.at) - timestamp(a.at))[0] || null;
    let attention = 'On track';
    if (character.archivedAt) attention = 'Archived';
    else if (role === 'resting') attention = 'Resting';
    else if (missingFields.length) attention = 'Profile incomplete';
    else if (activeSession?.status === 'in_progress') attention = 'Active now';
    else if (deferred) attention = 'Needs a decision';
    else if (due.length) attention = 'Has work today';
    else if (!activeGoals.length && !characterActivities.length) attention = 'No current plan';
    else if (!activeGoals.length && role === 'occasional') attention = 'Resting';
    return { character, role, attention, unfinished: activeGoals.length, dueCount: due.length, deferredCount: deferred, activeSession: activeSession || null, lastActivity: latest, missingFields };
  }).sort((a, b) => (a.attention === 'Archived' ? 1 : 0) - (b.attention === 'Archived' ? 1 : 0) || (a.attention === 'Active now' ? 0 : 1) - (b.attention === 'Active now' ? 0 : 1) || String(a.character.name).localeCompare(String(b.character.name)));
}

function activityRunsForCharacter(state, characterId) {
  const values = [];
  for (const activity of list(state?.activities)) {
    if (activity.characterId !== characterId) continue;
    const at = planned(activity) ? activity.completedAt : activity.occurredAt;
    if (at) values.push({ at, source: activity });
  }
  for (const plan of list(state?.sessionPlans)) if (list(plan.characterIds).includes(characterId) && (plan.startedAt || plan.updatedAt)) values.push({ at: plan.startedAt || plan.updatedAt, source: plan });
  for (const record of list(state?.activityOccurrences)) if (record.characterId === characterId && !record.undoneAt) values.push({ at: record.completedAt || record.skippedAt || record.recordedAt, source: record });
  return values.filter(item => timestamp(item.at));
}

function contextPenalty(candidate, selected, strategy) {
  if (!selected.length) return 0;
  const characters = new Set(selected.map(item => item.activity.characterId));
  const categories = new Set(selected.map(item => item.activity.category));
  return (characters.has(candidate.characterId) ? 0 : strategy.characterSwitchPenalty) + (categories.has(candidate.category) ? 0 : strategy.categorySwitchPenalty);
}

export function planSessionWithStrategy(state, options = {}) {
  const strategy = PLANNING_STRATEGIES[options.strategy] || PLANNING_STRATEGIES.balanced;
  const budgetMinutes = Math.max(1, Math.round(number(options.budgetMinutes, 30)));
  const cap = budgetMinutes + strategy.bufferMinutes;
  const lockedIds = new Set([...list(options.lockedIds), ...list(options.selectedIds)]);
  const excludedIds = new Set(list(options.excludedIds));
  const orderIndex = new Map(list(options.currentOrder).map((id, index) => [id, index]));
  const candidates = generateRecommendationCandidates(state, { now: options.now }).filter(candidate => candidate.sourceType === 'activity' && candidate.available && !excludedIds.has(candidate.sourceId));
  const ranked = candidates.map(candidate => scoreRecommendation(candidate, state, { ...options, strategy: strategy.id, availableMinutes: budgetMinutes, lockedIds: [...lockedIds] }));
  const locked = ranked.filter(candidate => lockedIds.has(candidate.sourceId)).sort((a, b) => (orderIndex.get(a.sourceId) ?? Infinity) - (orderIndex.get(b.sourceId) ?? Infinity) || b.score - a.score);
  const pool = ranked.filter(candidate => !lockedIds.has(candidate.sourceId));
  const focusAnchor = key => [...pool.reduce((totals, candidate) => totals.set(candidate[key], (totals.get(candidate[key]) || 0) + Math.max(0, candidate.score)), new Map())]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || null;
  const focusedCharacter = strategy.id === 'focused' ? focusAnchor('characterId') : null;
  const focusedCategory = strategy.id === 'focused' ? focusAnchor('category') : null;
  const selected = [];
  let totalMinutes = 0;
  const add = candidate => {
    const minutes = candidate.metrics?.planningMinutes || Math.max(1, number(candidate.estimatedMinutes, 30));
    if (totalMinutes + minutes > cap) return false;
    const reason = candidate.status === 'in_progress' ? 'Already in progress'
      : candidate.priority >= 2 ? 'High-priority activity'
      : candidate.characterId === state?.activeCharacterId ? 'Matches the active character'
      : options.budgetMinutes <= 60 && minutes <= 30 ? 'Fits a short session'
      : candidate.reason;
    selected.push({ activity: candidate.source, candidate, locked: lockedIds.has(candidate.sourceId), plannedMinutes: minutes, usesHistoricalDuration: Boolean(candidate.metrics?.usesHistoricalDuration), reason });
    totalMinutes += minutes;
    return true;
  };
  locked.forEach(add);
  while (pool.length) {
    const adjusted = candidate => candidate.score - contextPenalty(candidate, selected, strategy)
      - (focusedCharacter && candidate.characterId !== focusedCharacter ? strategy.characterSwitchPenalty : 0)
      - (focusedCategory && candidate.category !== focusedCategory ? strategy.categorySwitchPenalty : 0);
    pool.sort((a, b) => adjusted(b) - adjusted(a) || String(a.title).localeCompare(String(b.title)));
    const next = pool.shift();
    add(next);
  }
  return { budgetMinutes, bufferMinutes: strategy.bufferMinutes, strategy: strategy.id, totalMinutes, items: selected, characterIds: [...new Set(selected.map(item => item.activity.characterId))], categories: [...new Set(selected.map(item => item.activity.category))] };
}

export function rankAgendaRows(rows, state, options = {}) {
  const mode = options.sortMode || 'recommended';
  const candidates = list(rows).map(row => ({ row, candidate: scoreRecommendation({
    id: `activity:${row.activity.id}`, sourceType: 'activity', sourceId: row.activity.id, source: row.activity,
    title: row.activity.title, characterId: row.activity.characterId, character: list(state?.characters).find(item => item.id === row.activity.characterId) || null,
    category: row.activity.category, priority: number(row.activity.priority), status: row.activity.status, estimatedMinutes: number(row.activity.estimatedMinutes),
    updatedAt: row.activity.updatedAt, availability: row.availability, metrics: historicalActivityMetrics(state, row.activity), blocked: Boolean(row.activity.blockedAt), available: activeAvailability(row.availability.state) && !row.activity.blockedAt
  }, state, options) }));
  const manualOrder = new Map(list(options.manualOrder).map((id, index) => [id, index]));
  const compare = (a, b) => {
    if (mode === 'due') {
      const aDue = a.row.availability.dueAt || a.row.availability.nextAvailable || a.row.availability.expectedDate;
      const bDue = b.row.availability.dueAt || b.row.availability.nextAvailable || b.row.availability.expectedDate;
      if (!aDue && bDue) return 1;
      if (aDue && !bDue) return -1;
      return timestamp(aDue) - timestamp(bDue);
    }
    if (mode === 'priority') return number(b.row.activity.priority) - number(a.row.activity.priority);
    if (mode === 'character') return String(a.candidate.character?.name || '').localeCompare(String(b.candidate.character?.name || '')) || String(a.row.activity.title).localeCompare(String(b.row.activity.title));
    if (mode === 'duration') return number(a.candidate.metrics?.planningMinutes, a.row.activity.estimatedMinutes) - number(b.candidate.metrics?.planningMinutes, b.row.activity.estimatedMinutes);
    if (mode === 'manual') return (manualOrder.get(a.row.activity.id) ?? Infinity) - (manualOrder.get(b.row.activity.id) ?? Infinity);
    return b.candidate.score - a.candidate.score;
  };
  return candidates.sort((a, b) => compare(a, b) || String(a.row.activity.title).localeCompare(String(b.row.activity.title)) || String(a.row.activity.id).localeCompare(String(b.row.activity.id))).map(item => ({ ...item.row, recommendation: item.candidate }));
}

export function deduplicateSections(sections, order = Object.keys(sections || {})) {
  const seen = new Set();
  const output = {};
  for (const name of order) {
    output[name] = list(sections?.[name]).filter(item => {
      const type = item.sourceType || item.entityType || item.kind || name;
      const id = item.sourceId || item.entityId || item.activity?.id || item.id;
      const key = historyKey(type, id);
      if (!id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return output;
}

export const RecommendationEngine = Object.freeze({
  MIN_HISTORY_SAMPLES, MAX_RECOMMENDATION_HISTORY, RECOMMENDATION_HISTORY_DAYS, CHARACTER_ROLES,
  RECOMMENDATION_RESPONSES, SCORING_CONFIG, PLANNING_STRATEGIES, historicalActivityMetrics,
  durationFit, goldEfficiency, pruneRecommendationHistory, recordRecommendationImpressions,
  applyRecommendationFeedback, recommendationHistoryFor, recommendationSuppressed,
  generateRecommendationCandidates, deduplicateCandidates, scoreRecommendation, rankRecommendations,
  characterAttention, planSessionWithStrategy, rankAgendaRows, deduplicateSections
});

globalThis.AzerothRecommendations = RecommendationEngine;
