import test from 'node:test';
import assert from 'node:assert/strict';

import * as Recommendation from '../src/recommendation-engine.mjs';
import * as Schedule from '../src/schedule-engine.mjs';
import { migrateState, migrateV1ToV2 } from '../src/core.mjs';

const now = new Date(2026, 6, 20, 12, 0, 0);
const at = (day, hour = 12) => new Date(2026, 6, day, hour, 0, 0);
const iso = (day, hour = 12) => at(day, hour).toISOString();
const character = (id = 'a', extra = {}) => ({ id, name: id.toUpperCase(), realm: 'Silvermoon', region: 'EU', faction: 'Alliance', race: 'Night Elf', className: 'Druid', spec: 'Guardian', professions: '', level: 80, gold: 100, playedMinutes: 60, location: 'Valdrakken', createdAt: iso(1), ...extra });
const activity = (id, extra = {}) => ({ id, characterId: 'a', kind: 'planned', title: id, description: '', category: 'Campaign', priority: 1, status: 'todo', estimatedMinutes: 30, repeatType: 'daily', tags: [], notes: '', scheduledFor: null, schedule: { type: 'daily', startDate: '2026-07-01', dueTime: null, weekdays: [], intervalValue: 1, intervalUnit: 'days', endDate: null, timezoneMode: 'local', graceMinutes: 0, paused: false, pausedUntil: null }, createdAt: iso(1), updatedAt: iso(1), completedAt: null, ...extra });
const goal = (id, extra = {}) => ({ id, characterId: 'a', scope: 'character', category: 'Campaign', title: id, status: 'todo', priority: 0, createdAt: iso(1), completedAt: null, ...extra });
const state = (extra = {}) => ({ schemaVersion: 2, activeCharacterId: 'a', preferences: {}, characters: [character()], goals: [], activities: [], progressEvents: [], collectionTrackers: [], sessionPlans: [], activityOccurrences: [], recommendationHistory: [], migration: { sourceVersion: 2, targetVersion: 2, migratedAt: iso(1) }, ...extra });
const session = (id, status, extra = {}) => ({ id, title: id, status, characterIds: ['a'], items: [], totalEstimatedMinutes: 30, plannedFor: '2026-07-20', createdAt: iso(1), updatedAt: iso(20), startedAt: status === 'in_progress' || status === 'paused' ? iso(20, 10) : null, completedAt: null, endedAt: null, activeStartedAt: status === 'in_progress' ? iso(20, 10) : null, pausedAt: status === 'paused' ? iso(20, 11) : null, accumulatedMs: 0, currentItemId: null, notes: '', reconciliation: null, ...extra });
const resultPlan = (id, activityId, results) => session(id, 'completed', { completedAt: results[0]?.at || iso(19), endedAt: results[0]?.at || iso(19), items: results.map((result, index) => ({ id: `${id}-${index}`, activityId, characterId: result.characterId || 'a', snapshot: { title: activityId, category: 'Campaign', characterId: 'a', repeatType: 'daily' }, order: index, locked: false, plannedMinutes: 30, status: result.status, actualMinutes: result.minutes || 0, startedAt: result.at, completedAt: result.at, resultNotes: '', goldEarned: result.gold || 0, goldSpent: result.spent || 0, progressMetric: '', progressGained: 0, completionQuantity: null, completeUnderlying: false, unplanned: false })) });

test('central candidate generation covers sessions, activities, goals, and collections', () => {
  const campaign = state({ activities: [activity('work')], goals: [goal('goal')], collectionTrackers: [{ id: 'mounts', scope: 'character', characterId: 'a', name: 'Mounts', owned: 2, target: 10, baseline: 0 }], sessionPlans: [session('ready', 'ready')] });
  assert.deepEqual(new Set(Recommendation.generateRecommendationCandidates(campaign, { now }).map(item => item.sourceType)), new Set(['session', 'activity', 'goal', 'collection']));
});

test('active sessions receive the strongest priority', () => {
  const campaign = state({ activities: [activity('work', { priority: 3 })], sessionPlans: [session('running', 'in_progress')] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now })[0].sourceId, 'running');
});

test('paused sessions outrank normal activities', () => {
  const campaign = state({ activities: [activity('work', { priority: 3 })], sessionPlans: [session('paused', 'paused')] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now })[0].sourceId, 'paused');
});

test('due-today scoring outranks ordinary available work', () => {
  const campaign = state({ activities: [activity('ordinary', { priority: 3 }), activity('due', { priority: 1, schedule: { ...activity('x').schedule, dueTime: '09:00' } })] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now }).filter(item => item.sourceType === 'activity')[0].sourceId, 'due');
});

test('due-time urgency increases as the due time approaches', () => {
  const item = activity('timed', { schedule: { ...activity('x').schedule, dueTime: '13:00' } });
  const campaign = state({ activities: [item] });
  const score = Recommendation.scoreRecommendation(Recommendation.generateRecommendationCandidates(campaign, { now })[0], campaign, { now });
  assert.ok(score.factors.some(factor => factor.key === 'dueTimeUrgency' && factor.value > 0));
});

test('in-progress activities receive an explainable boost', () => {
  const campaign = state({ activities: [activity('doing', { status: 'in_progress' }), activity('todo')] });
  const ranked = Recommendation.rankRecommendations(campaign, { now }).filter(item => item.sourceType === 'activity');
  assert.equal(ranked[0].sourceId, 'doing');
  assert.ok(ranked[0].factors.some(factor => factor.key === 'inProgress'));
});

test('active-character scoring breaks otherwise equal ties', () => {
  const campaign = state({ characters: [character('a'), character('b')], activities: [activity('b-work', { characterId: 'b' }), activity('a-work')] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now }).filter(item => item.sourceType === 'activity')[0].characterId, 'a');
});

test('character-role preference favors main over occasional characters', () => {
  const campaign = state({ characters: [character('a', { campaignRole: 'main' }), character('b', { campaignRole: 'occasional' })], activities: [activity('b-work', { characterId: 'b' }), activity('a-work')] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now }).filter(item => item.sourceType === 'activity')[0].characterId, 'a');
});

test('recently completed work receives a fatigue penalty', () => {
  const item = activity('recent');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('run', item.id, [{ status: 'completed', minutes: 20, at: iso(20, 10) }])] });
  const scored = Recommendation.scoreRecommendation(Recommendation.generateRecommendationCandidates(campaign, { now })[0], campaign, { now });
  assert.ok(scored.factors.some(factor => factor.key === 'recentlyCompleted' && factor.value < 0));
});

test('repeated skips reduce recommendation score', () => {
  const item = activity('skipped');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'skipped', at: iso(18) }, { status: 'skipped', at: iso(19) }])] });
  const scored = Recommendation.scoreRecommendation(Recommendation.generateRecommendationCandidates(campaign, { now })[0], campaign, { now });
  assert.ok(scored.factors.some(factor => factor.key === 'repeatedlySkipped' && factor.value < 0));
});

test('recent recommendation history produces bounded fatigue', () => {
  const item = activity('repeat');
  const campaign = state({ activities: [item], recommendationHistory: [{ id: 'h', entityId: item.id, recommendationType: 'activity', characterId: 'a', firstShownAt: iso(15), lastShownAt: iso(19), timesShown: 9, lastUserResponse: null, dismissedUntil: null }] });
  const scored = Recommendation.scoreRecommendation(Recommendation.generateRecommendationCandidates(campaign, { now })[0], campaign, { now });
  assert.ok(scored.factors.some(factor => factor.key === 'recentlyRecommended' && factor.value === Recommendation.SCORING_CONFIG.recentlyRecommended * 4));
});

test('snoozed activity is excluded from recommendations', () => {
  const item = activity('snoozed');
  const key = Schedule.occurrenceKeyForDate(item, '2026-07-20');
  const campaign = state({ activities: [item], activityOccurrences: [{ id: 's', activityId: item.id, characterId: 'a', occurrenceKey: key, expectedAt: iso(20, 0), status: 'snoozed', recordedAt: iso(20, 9), snoozedAt: iso(20, 9), snoozedUntil: iso(20, 16), notes: '' }] });
  assert.equal(Recommendation.rankRecommendations(campaign, { now }).some(candidate => candidate.sourceId === item.id), false);
});

test('future unavailable activity is excluded from recommendations', () => {
  const item = activity('future', { schedule: { ...activity('x').schedule, startDate: '2026-07-25' } });
  assert.equal(Recommendation.rankRecommendations(state({ activities: [item] }), { now }).length, 0);
});

test('recommendation explanations expose named factors without mutating state', () => {
  const campaign = state({ activities: [activity('work', { priority: 3 })] });
  const before = structuredClone(campaign);
  const result = Recommendation.rankRecommendations(campaign, { now })[0];
  assert.ok(result.reason.length > 0 && result.factors.some(factor => factor.label === 'Critical priority'));
  assert.deepEqual(campaign, before);
});

test('cross-section deduplication keeps the first visible entity only', () => {
  const duplicate = { id: 'row', sourceType: 'activity', sourceId: 'same' };
  const output = Recommendation.deduplicateSections({ today: [duplicate], nextUp: [duplicate], goals: [{ id: 'g', sourceType: 'goal', sourceId: 'g' }] }, ['today', 'nextUp', 'goals']);
  assert.equal(output.today.length, 1);
  assert.equal(output.nextUp.length, 0);
});

test('more than two identical collection-milestone recommendations collapse into one aggregate', () => {
  const trackers = ['Achievements', 'Mounts', 'Pets', 'Toys', 'Appearances', 'Reputations'].map(name => ({ id: `tracker-${name}`, scope: 'character', characterId: 'a', name, owned: 0, target: name === 'Appearances' ? 100 : 10, baseline: 0 }));
  const campaign = state({ collectionTrackers: trackers });
  const ranked = Recommendation.rankRecommendations(campaign, { now, limit: 10 });
  assert.equal(ranked.filter(item => item.sourceType === 'collection').length, 0);
  const aggregates = ranked.filter(item => item.sourceType === 'aggregate');
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0].action, 'open-collections');
  assert.match(aggregates[0].title, /6/);
});

test('exactly two matching recommendations are not collapsed', () => {
  const trackers = ['Mounts', 'Pets'].map(name => ({ id: `tracker-${name}`, scope: 'character', characterId: 'a', name, owned: 0, target: 10, baseline: 0 }));
  const campaign = state({ collectionTrackers: trackers });
  const ranked = Recommendation.rankRecommendations(campaign, { now, limit: 10 });
  assert.equal(ranked.filter(item => item.sourceType === 'collection').length, 2);
  assert.equal(ranked.filter(item => item.sourceType === 'aggregate').length, 0);
});

test('collapsed aggregate leaves room for other distinct recommendations', () => {
  const trackers = ['Achievements', 'Mounts', 'Pets', 'Toys', 'Appearances'].map(name => ({ id: `tracker-${name}`, scope: 'character', characterId: 'a', name, owned: 0, target: name === 'Appearances' ? 100 : 10, baseline: 0 }));
  const campaign = state({ collectionTrackers: trackers, activities: [activity('work', { priority: 3 })] });
  const ranked = Recommendation.rankRecommendations(campaign, { now, limit: 5 });
  assert.ok(ranked.some(item => item.sourceType === 'activity' && item.sourceId === 'work'));
  assert.equal(ranked.filter(item => item.sourceType === 'aggregate').length, 1);
});

test('diversity-guard aggregation is deterministic across repeated calls', () => {
  const trackers = ['Achievements', 'Mounts', 'Pets', 'Toys'].map(name => ({ id: `tracker-${name}`, scope: 'character', characterId: 'a', name, owned: 0, target: 10, baseline: 0 }));
  const campaign = state({ collectionTrackers: trackers });
  const first = Recommendation.rankRecommendations(campaign, { now, limit: 10 });
  const second = Recommendation.rankRecommendations(campaign, { now, limit: 10 });
  assert.deepEqual(first, second);
});

test('impressions are deduplicated by local day', () => {
  const candidate = { sourceType: 'activity', sourceId: 'work', characterId: 'a' };
  const first = Recommendation.recordRecommendationImpressions([], [candidate], { now });
  const second = Recommendation.recordRecommendationImpressions(first.history, [candidate], { now: at(20, 18) });
  assert.equal(first.history[0].timesShown, 1);
  assert.equal(second.history[0].timesShown, 1);
  assert.equal(second.changed, false);
});

test('recommendation-history pruning bounds age and size', () => {
  const history = Array.from({ length: 250 }, (_, index) => ({ id: `h${index}`, entityId: `e${index}`, recommendationType: 'activity', firstShownAt: iso(index === 249 ? 1 : 19), lastShownAt: iso(index === 249 ? 1 : 19), timesShown: 1 }));
  const pruned = Recommendation.pruneRecommendationHistory(history, { now, maxEntries: 40, maxAgeDays: 10 });
  assert.equal(pruned.length, 40);
  assert.equal(pruned.some(record => record.id === 'h249'), false);
});

test('Not today suppresses only the current local day', () => {
  const candidate = { sourceType: 'activity', sourceId: 'work', characterId: 'a' };
  const history = Recommendation.applyRecommendationFeedback([], candidate, 'not_today', { now });
  assert.equal(Recommendation.recommendationSuppressed(history, candidate, { now: at(20, 20) }), true);
  assert.equal(Recommendation.recommendationSuppressed(history, candidate, { now: at(21, 1) }), false);
});

test('dismissal expires without deleting its source', () => {
  const candidate = { sourceType: 'activity', sourceId: 'work', characterId: 'a' };
  const history = Recommendation.applyRecommendationFeedback([], candidate, 'dismissed', { now, dismissDays: 2 });
  assert.equal(Recommendation.recommendationSuppressed(history, candidate, { now: at(21) }), true);
  assert.equal(Recommendation.recommendationSuppressed(history, candidate, { now: at(23) }), false);
});

test('Focused planning minimizes character switching', () => {
  const campaign = state({ characters: [character('a'), character('b')], activities: [activity('a1', { estimatedMinutes: 20 }), activity('a2', { estimatedMinutes: 20 }), activity('b1', { characterId: 'b', estimatedMinutes: 20, priority: 2 })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 40, strategy: 'focused' });
  assert.equal(new Set(plan.items.map(item => item.activity.characterId)).size, 1);
});

test('Balanced planning includes urgent work across contexts when useful', () => {
  const campaign = state({ characters: [character('a'), character('b')], activities: [activity('a1', { estimatedMinutes: 20 }), activity('b-due', { characterId: 'b', priority: 3, estimatedMinutes: 20, schedule: { ...activity('x').schedule, dueTime: '09:00' } })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 40, strategy: 'balanced' });
  assert.deepEqual(new Set(plan.items.map(item => item.activity.characterId)), new Set(['a', 'b']));
});

test('Maximum-completion planning prefers shorter activities', () => {
  const campaign = state({ activities: [activity('long', { estimatedMinutes: 50, priority: 2 }), activity('short', { estimatedMinutes: 10, priority: 1 })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 55, strategy: 'maximum_completion' });
  assert.equal(plan.items[0].activity.id, 'short');
});

test('Gold-focused planning uses sufficient real run history', () => {
  const gold = activity('gold', { category: 'Gold' });
  const campaign = state({ activities: [activity('campaign', { priority: 2 }), gold], sessionPlans: [resultPlan('r1', gold.id, [{ status: 'completed', minutes: 30, gold: 100, at: iso(17) }]), resultPlan('r2', gold.id, [{ status: 'completed', minutes: 30, gold: 110, at: iso(18) }]), resultPlan('r3', gold.id, [{ status: 'completed', minutes: 30, gold: 120, at: iso(19) }])] });
  assert.equal(Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'gold_focused' }).items[0].activity.id, 'gold');
});

test('Gold-focused planning falls back safely with insufficient history', () => {
  const gold = activity('gold', { category: 'Gold', priority: 0 });
  const campaign = state({ activities: [activity('campaign', { priority: 3 }), gold], sessionPlans: [resultPlan('r1', gold.id, [{ status: 'completed', minutes: 30, gold: 100, at: iso(19) }])] });
  assert.equal(Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'gold_focused' }).items[0].activity.id, 'campaign');
});

test('Campaign-focused planning prioritizes campaign work', () => {
  const campaign = state({ activities: [activity('gold', { category: 'Gold', priority: 2 }), activity('campaign', { category: 'Campaign', priority: 1 })] });
  assert.equal(Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'campaign_focused' }).items[0].activity.id, 'campaign');
});

test('locked session items survive regeneration', () => {
  const campaign = state({ activities: [activity('locked', { priority: 0 }), activity('other', { priority: 3 })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'balanced', lockedIds: ['locked'], currentOrder: ['locked'] });
  assert.equal(plan.items[0].activity.id, 'locked');
  assert.equal(plan.items[0].locked, true);
});

test('Focused context-switch penalty keeps a coherent category', () => {
  const campaign = state({ activities: [activity('campaign1', { estimatedMinutes: 15 }), activity('campaign2', { estimatedMinutes: 15 }), activity('gold', { category: 'Gold', estimatedMinutes: 15, priority: 2 })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'focused' });
  assert.equal(new Set(plan.items.map(item => item.activity.category)).size, 1);
});

test('time-buffer handling remains inside the configured allowance', () => {
  const campaign = state({ activities: [activity('one', { estimatedMinutes: 32 }), activity('two', { estimatedMinutes: 10 })] });
  const plan = Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 30, strategy: 'balanced' });
  assert.ok(plan.totalMinutes <= plan.budgetMinutes + plan.bufferMinutes);
});

test('historical metrics use median actual duration', () => {
  const item = activity('history');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'completed', minutes: 10, at: iso(17) }, { status: 'completed', minutes: 20, at: iso(18) }, { status: 'completed', minutes: 30, at: iso(19) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).medianDuration, 20);
});

test('duration median resists large outliers', () => {
  const item = activity('history');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'completed', minutes: 10, at: iso(17) }, { status: 'completed', minutes: 11, at: iso(18) }, { status: 'completed', minutes: 500, at: iso(19) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).medianDuration, 11);
});

test('completion rate is derived from canonical run outcomes', () => {
  const item = activity('rates');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'completed', minutes: 10, at: iso(17) }, { status: 'skipped', at: iso(18) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).completionRate, 0.5);
});

test('skip rate is derived from canonical run outcomes', () => {
  const item = activity('rates');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'completed', minutes: 10, at: iso(17) }, { status: 'skipped', at: iso(18) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).skipRate, 0.5);
});

test('partial-completion rate is derived from canonical run outcomes', () => {
  const item = activity('rates');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'partial', minutes: 10, at: iso(17) }, { status: 'completed', minutes: 10, at: iso(18) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).partialRate, 0.5);
});

test('median gold per hour uses measured completed runs', () => {
  const item = activity('gold');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('runs', item.id, [{ status: 'completed', minutes: 60, gold: 100, at: iso(17) }, { status: 'completed', minutes: 30, gold: 100, at: iso(18) }, { status: 'completed', minutes: 60, gold: 300, at: iso(19) }])] });
  assert.equal(Recommendation.historicalActivityMetrics(campaign, item).medianGoldPerHour, 200);
});

test('minimum sample threshold prevents one run from becoming trusted history', () => {
  const item = activity('thin');
  const campaign = state({ activities: [item], sessionPlans: [resultPlan('run', item.id, [{ status: 'completed', minutes: 5, gold: 500, at: iso(19) }])] });
  const metrics = Recommendation.historicalActivityMetrics(campaign, item);
  assert.equal(metrics.trustedDuration, false);
  assert.equal(metrics.medianGoldPerHour, null);
});

test('character attention recognizes active, due, incomplete, and unplanned states', () => {
  const characters = [character('active'), character('due'), character('incomplete', { spec: '' }), character('empty')];
  const campaign = state({ activeCharacterId: 'active', characters, activities: [activity('active-work', { characterId: 'active' }), activity('due-work', { characterId: 'due', schedule: { ...activity('x').schedule, dueTime: '09:00' } })], sessionPlans: [session('running', 'in_progress', { characterIds: ['active'] })] });
  const labels = Object.fromEntries(Recommendation.characterAttention(campaign, { now }).map(item => [item.character.id, item.attention]));
  assert.equal(labels.active, 'Active now');
  assert.equal(labels.due, 'Has work today');
  assert.equal(labels.incomplete, 'Profile incomplete');
  assert.equal(labels.empty, 'No current plan');
});

test('resting characters are never flagged negatively', () => {
  const campaign = state({ characters: [character('a'), character('rest', { campaignRole: 'resting' })], goals: [goal('rest-goal', { characterId: 'rest' })] });
  assert.equal(Recommendation.characterAttention(campaign, { now }).find(item => item.character.id === 'rest').attention, 'Resting');
});

test('agenda recommended order uses the shared score', () => {
  const ordinary = activity('ordinary', { priority: 3 });
  const due = activity('due', { priority: 1, schedule: { ...activity('x').schedule, dueTime: '09:00' } });
  const campaign = state({ activities: [ordinary, due] });
  const rows = [ordinary, due].map(item => ({ activity: item, availability: Schedule.activityAvailability(item, campaign, { now }) }));
  assert.equal(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'recommended' })[0].activity.id, 'due');
});

test('manual agenda sorting follows stored manual order', () => {
  const first = activity('first');
  const second = activity('second');
  const campaign = state({ activities: [first, second] });
  const rows = [first, second].map(item => ({ activity: item, availability: Schedule.activityAvailability(item, campaign, { now }) }));
  assert.deepEqual(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'manual', manualOrder: ['second', 'first'] }).map(row => row.activity.id), ['second', 'first']);
});

test('agenda due, priority, character, and duration modes use their named field', () => {
  const later = activity('later', { characterId: 'b', priority: 3, estimatedMinutes: 60, schedule: { ...activity('x').schedule, dueTime: '14:00' } });
  const sooner = activity('sooner', { priority: 1, estimatedMinutes: 10, schedule: { ...activity('x').schedule, dueTime: '13:00' } });
  const campaign = state({ characters: [character('a', { name: 'Zed' }), character('b', { name: 'Ada' })], activities: [later, sooner] });
  const rows = [later, sooner].map(item => ({ activity: item, availability: Schedule.activityAvailability(item, campaign, { now }) }));
  assert.equal(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'due' })[0].activity.id, 'sooner');
  assert.equal(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'priority' })[0].activity.id, 'later');
  assert.equal(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'character' })[0].activity.id, 'later');
  assert.equal(Recommendation.rankAgendaRows(rows, campaign, { now, sortMode: 'duration' })[0].activity.id, 'sooner');
});

test('feedback application stores only structured local response data', () => {
  const candidate = { sourceType: 'activity', sourceId: 'work', characterId: 'a' };
  const history = Recommendation.applyRecommendationFeedback([], candidate, 'not_useful', { now });
  assert.equal(history[0].lastUserResponse, 'not_useful');
  assert.equal(history[0].entityId, 'work');
});

test('all recommendation selectors keep canonical input immutable', () => {
  const campaign = state({ activities: [activity('work')], goals: [goal('goal')] });
  const before = structuredClone(campaign);
  const candidates = Recommendation.generateRecommendationCandidates(campaign, { now });
  Recommendation.rankRecommendations(campaign, { now, candidates });
  Recommendation.characterAttention(campaign, { now });
  Recommendation.planSessionWithStrategy(campaign, { now, budgetMinutes: 60 });
  assert.deepEqual(campaign, before);
});

test('existing v1 migration gains empty recommendation history', () => {
  const migrated = migrateV1ToV2({ version: 1, activeId: 'a', characters: [{ id: 'a', name: 'A', realm: 'R', region: 'EU', faction: 'Alliance', race: 'Human', className: 'Warrior', spec: '', professions: '', level: 1, gold: 0, playedMinutes: 0, location: '', sessions: [], ledger: [], snapshots: [], collections: {}, goals: [] }] }, { now });
  assert.deepEqual(migrated.recommendationHistory, []);
});

test('existing v2 loads without recommendation history', () => {
  const existing = state();
  delete existing.recommendationHistory;
  assert.deepEqual(migrateState(existing, { now }).recommendationHistory, []);
});

test('existing saved sessions and schedules survive v2 normalization', () => {
  const existing = state({ activities: [activity('scheduled')], sessionPlans: [session('saved', 'ready')] });
  delete existing.recommendationHistory;
  const loaded = migrateState(existing, { now });
  assert.equal(loaded.activities[0].schedule.type, 'daily');
  assert.equal(loaded.sessionPlans[0].id, 'saved');
});
