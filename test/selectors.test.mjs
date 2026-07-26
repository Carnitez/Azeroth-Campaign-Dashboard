import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectActiveGoals,
  selectGoalObjectiveCounts,
  selectLastActivityByCharacter,
  selectCharacterAttention,
  selectRecentActivity,
  localWeekBounds,
  selectWeeklyMomentum,
  selectNextUp,
  selectOnboardingState,
  selectCampaignStage,
  selectGuidedToday,
  selectCoachHint
} from '../src/selectors.mjs';

const at = (day, hour = 12, minute = 0) => new Date(2026, 6, day, hour, minute, 0);
const iso = (day, hour = 12, minute = 0) => at(day, hour, minute).toISOString();
const character = (id, overrides = {}) => ({
  id, name: id.toUpperCase(), realm: 'Silvermoon', region: 'EU', race: 'Night Elf', className: 'Druid',
  spec: 'Guardian', location: 'Valdrakken', level: 80, gold: 1000, playedMinutes: 60, createdAt: iso(1), ...overrides
});
const goal = (id, characterId, overrides = {}) => ({
  id, characterId, scope: 'character', category: 'Campaign', title: id, status: 'todo', priority: 0,
  order: 0, createdAt: iso(1), completedAt: null, ...overrides
});
const state = (overrides = {}) => ({
  schemaVersion: 2,
  activeCharacterId: 'a',
  preferences: {},
  characters: [character('a')],
  goals: [], activities: [], progressEvents: [], collectionTrackers: [],
  migration: { sourceVersion: 2, targetVersion: 2, migratedAt: iso(1) },
  ...overrides
});
const starterCharacter = (overrides = {}) => character('carnitez-silvermoon-eu', {
  name: 'Carnitez', race: 'Night Elf', className: 'Druid', spec: 'Guardian', location: 'Shadowglen', ...overrides
});
const tracker = (id, characterId, overrides = {}) => ({ id, scope: 'character', characterId, name: id, owned: 0, target: 10, baseline: 0, ...overrides });

test('Next Up prefers in-progress work, then priority, then recency', () => {
  const campaign = state({ goals: [
    goal('todo-high', 'a', { priority: 10, updatedAt: iso(22) }),
    goal('doing-low', 'a', { status: 'in_progress', priority: 0, updatedAt: iso(1) }),
    goal('todo-newer', 'a', { priority: 5, updatedAt: iso(22) }),
    goal('todo-older', 'a', { priority: 5, updatedAt: iso(20) })
  ] });
  assert.deepEqual(selectNextUp(campaign, { now: at(22) }).slice(0, 4).map(item => item.sourceId), ['doing-low', 'todo-high', 'todo-newer', 'todo-older']);
  assert.equal(selectNextUp(campaign, { now: at(22) })[0].reason, 'Already in progress');
});

test('Next Up prefers the active character when stronger rules are tied', () => {
  const campaign = state({
    characters: [character('a'), character('b')],
    goals: [goal('b-goal', 'b'), goal('a-goal', 'a')]
  });
  assert.equal(selectNextUp(campaign, { now: at(22) })[0].characterId, 'a');
  campaign.activeCharacterId = 'b';
  assert.equal(selectNextUp(campaign, { now: at(22) })[0].characterId, 'b');
});

test('Next Up does not describe a newly-created untouched goal as recently updated', () => {
  const campaign = state({ goals: [goal('untouched', 'a', { createdAt: iso(22) })] });
  assert.equal(selectNextUp(campaign, { now: at(22) })[0].reason, 'Unfinished goal');
});

test('active goals follow status, priority, order, update and creation ordering', () => {
  const campaign = state({ goals: [
    goal('done', 'a', { status: 'done', completedAt: iso(22) }),
    goal('todo-priority', 'a', { priority: 5, order: 0 }),
    goal('doing-order-2', 'a', { status: 'in_progress', priority: 2, order: 2, updatedAt: iso(22) }),
    goal('doing-order-1', 'a', { status: 'in_progress', priority: 2, order: 1, updatedAt: iso(1) }),
    goal('doing-high', 'a', { status: 'in_progress', priority: 9, order: 9 })
  ] });
  assert.deepEqual(selectActiveGoals(campaign).map(item => item.id), ['doing-high', 'doing-order-1', 'doing-order-2', 'todo-priority']);
});

test('character attention states and counts are deterministic', () => {
  const campaign = state({
    characters: [
      character('active'), character('idle'), character('empty'),
      character('incomplete', { className: '' }), character('complete'), character('archived', { archivedAt: iso(20) })
    ],
    activeCharacterId: 'active',
    goals: [
      goal('active-goal', 'active'), goal('idle-goal', 'idle'), goal('incomplete-goal', 'incomplete'),
      goal('finished', 'complete', { status: 'done', completedAt: iso(21) }), goal('archived-goal', 'archived')
    ],
    activities: [{ id: 'recent', characterId: 'active', kind: 'session', occurredAt: iso(21), durationMinutes: 20, gold: { delta: 0 } }]
  });
  const attention = Object.fromEntries(selectCharacterAttention(campaign, { now: at(22) }).map(item => [item.character.id, item.attention]));
  assert.deepEqual(attention, {
    active: 'Active', idle: 'Needs attention', empty: 'No current goals',
    incomplete: 'Profile incomplete', complete: 'Recently completed'
  });
  assert.equal('archived' in attention, false);
  assert.equal(selectGoalObjectiveCounts(campaign).idle.unfinished, 1);
});

test('last activity uses the latest real record and ignores starter observations', () => {
  const campaign = state({
    activities: [{ id: 'session', characterId: 'a', kind: 'session', occurredAt: iso(19), durationMinutes: 10 }],
    progressEvents: [
      { id: 'starter', entityId: 'a', metric: 'level', value: 1, recordedAt: iso(22), source: 'starter' },
      { id: 'level', entityId: 'a', metric: 'level', value: 80, recordedAt: iso(20), source: 'current-observation' }
    ]
  });
  const latest = selectLastActivityByCharacter(campaign).a;
  assert.equal(latest.id, 'level');
  assert.equal(latest.type, 'progress');
});

test('recent activity deduplicates progress linked to an activity', () => {
  const campaign = state({
    activities: [{ id: 'session-1', characterId: 'a', kind: 'session', occurredAt: iso(22), durationMinutes: 30, notes: 'Questing', gold: { delta: 50 } }],
    progressEvents: [
      { id: 'linked-gold', entityId: 'a', metric: 'liquidGold', value: 1050, recordedAt: iso(22), sourceActivityId: 'session-1' },
      { id: 'level', entityId: 'a', metric: 'level', value: 80, recordedAt: iso(21) }
    ]
  });
  const feed = selectRecentActivity(campaign);
  assert.equal(feed.length, 2);
  assert.equal(feed.filter(item => item.sourceId === 'session-1').length, 1);
  assert.equal(feed.some(item => item.sourceId === 'linked-gold'), false);
});

test('weekly momentum respects local Monday boundaries', () => {
  const campaign = state({ activities: [
    { id: 'before', characterId: 'a', kind: 'session', occurredAt: at(19, 23, 59), durationMinutes: 5, gold: { delta: 1 } },
    { id: 'monday', characterId: 'a', kind: 'session', occurredAt: at(20, 0, 0), durationMinutes: 30, gold: { delta: 20 } },
    { id: 'sunday', characterId: 'a', kind: 'session', occurredAt: at(26, 23, 59), durationMinutes: 60, gold: { delta: -5 } },
    { id: 'after', characterId: 'a', kind: 'session', occurredAt: at(27, 0, 0), durationMinutes: 10, gold: { delta: 99 } }
  ] });
  const bounds = localWeekBounds(at(22));
  assert.equal(bounds.startKey, '2026-07-20');
  assert.equal(bounds.endKey, '2026-07-26');
  const momentum = selectWeeklyMomentum(campaign, { now: at(22) });
  assert.equal(momentum.sessions, 2);
  assert.equal(momentum.minutesPlayed, 90);
  assert.equal(momentum.goldEarned, 20);
  assert.equal(momentum.goldSpent, 5);
  assert.equal(momentum.netGold, 15);
});

test('unfinished planned activities do not count as weekly activity', () => {
  const campaign = state({ activities: [{
    id: 'planned', kind: 'planned', characterId: 'a', title: 'Future work', description: '',
    category: 'Weekly', priority: 2, status: 'todo', estimatedMinutes: 30,
    repeatType: 'one_time', tags: [], notes: '', scheduledFor: null,
    createdAt: iso(20), updatedAt: iso(20), completedAt: null
  }, {
    id: 'incomplete-completion', kind: 'planned', characterId: 'a', title: 'Missing timestamp', description: '',
    category: 'Weekly', priority: 1, status: 'completed', estimatedMinutes: 15,
    repeatType: 'one_time', tags: [], notes: '', scheduledFor: null,
    createdAt: iso(20), updatedAt: iso(20)
  }] });
  const momentum = selectWeeklyMomentum(campaign, { now: at(22) });
  assert.equal(momentum.sessions, 0);
  assert.equal(momentum.completed, 0);
  assert.equal(momentum.activeCharacters, 0);
});

test('weekly gold totals combine recorded revenue, costs and session balance changes', () => {
  const campaign = state({ activities: [
    { id: 'farm', characterId: 'a', kind: 'gold', occurredAt: iso(21), durationMinutes: 60, gold: { revenue: 1000, cost: 250, delta: 750, affectsBalance: false } },
    { id: 'session', characterId: 'a', kind: 'session', occurredAt: iso(22), durationMinutes: 30, gold: { delta: -100, affectsBalance: true } }
  ] });
  const momentum = selectWeeklyMomentum(campaign, { now: at(22) });
  assert.equal(momentum.goldEarned, 1000);
  assert.equal(momentum.goldSpent, 350);
  assert.equal(momentum.netGold, 650);
  assert.equal(momentum.activeCharacters, 1);
});

test('weekly all-character scope and collection updates use active roster only', () => {
  const campaign = state({
    characters: [character('a'), character('b'), character('archived', { archivedAt: iso(1) })],
    activities: [
      { id: 'a', characterId: 'a', kind: 'session', occurredAt: iso(22), durationMinutes: 10, gold: { delta: 0 } },
      { id: 'b', characterId: 'b', kind: 'session', occurredAt: iso(22), durationMinutes: 20, gold: { delta: 0 } },
      { id: 'x', characterId: 'archived', kind: 'session', occurredAt: iso(22), durationMinutes: 90, gold: { delta: 0 } }
    ],
    progressEvents: [
      { id: 'collection', entityId: 'b', metric: 'collection:mounts:owned', value: 5, recordedAt: iso(22) },
      { id: 'archived-collection', entityId: 'archived', metric: 'collection:pets:owned', value: 5, recordedAt: iso(22) }
    ]
  });
  const momentum = selectWeeklyMomentum(campaign, { scope: 'all', now: at(22) });
  assert.equal(momentum.minutesPlayed, 30);
  assert.equal(momentum.collectionUpdates, 1);
  assert.equal(momentum.activeCharacters, 2);
});

test('empty selectors return useful empty collections without invented records', () => {
  const empty = state({ goals: [], activities: [], progressEvents: [], collectionTrackers: [], characters: [] });
  assert.deepEqual(selectActiveGoals(empty), []);
  assert.deepEqual(selectNextUp(empty), []);
  assert.deepEqual(selectRecentActivity(empty), []);
  assert.deepEqual(selectCharacterAttention(empty), []);
  assert.deepEqual(selectGoalObjectiveCounts(empty), {});
});

test('archived characters are excluded from goals, recommendations, feed and roster', () => {
  const campaign = state({
    characters: [character('a'), character('archived', { archivedAt: iso(20) })],
    goals: [goal('visible', 'a'), goal('hidden', 'archived', { status: 'in_progress', priority: 99 })],
    activities: [{ id: 'hidden-session', characterId: 'archived', kind: 'session', occurredAt: iso(22), durationMinutes: 10 }]
  });
  assert.equal(selectActiveGoals(campaign).some(item => item.characterId === 'archived'), false);
  assert.equal(selectNextUp(campaign, { now: at(22) }).some(item => item.characterId === 'archived'), false);
  assert.equal(selectRecentActivity(campaign).length, 0);
  assert.equal(selectCharacterAttention(campaign, { now: at(22) }).length, 1);
});

test('all Command Center selectors leave canonical state untouched', () => {
  const campaign = state({
    characters: [character('a'), character('b')],
    goals: [goal('goal-a', 'a', { status: 'in_progress', priority: 2 })],
    activities: [{ id: 'session', characterId: 'a', kind: 'session', occurredAt: iso(22), durationMinutes: 10, gold: { delta: 5 } }],
    collectionTrackers: [{ id: 'mounts', scope: 'character', characterId: 'a', name: 'Mounts', owned: 8, target: 10, baseline: 2 }]
  });
  const before = structuredClone(campaign);
  selectActiveGoals(campaign);
  selectGoalObjectiveCounts(campaign);
  selectLastActivityByCharacter(campaign);
  selectCharacterAttention(campaign, { now: at(22) });
  selectRecentActivity(campaign);
  selectWeeklyMomentum(campaign, { scope: 'all', now: at(22) });
  selectNextUp(campaign, { now: at(22) });
  assert.deepEqual(campaign, before);
});

test('onboarding checklist shows all steps incomplete on a fresh campaign', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()] });
  const onboarding = selectOnboardingState(campaign);
  assert.equal(onboarding.visible, true);
  assert.equal(onboarding.allComplete, false);
  assert.deepEqual(onboarding.steps.map(step => step.complete), [false, false, false, false]);
});

test('editing the starter character completes the character step only', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter({ name: 'Thrall' })] });
  const onboarding = selectOnboardingState(campaign);
  assert.deepEqual(onboarding.steps.map(step => step.complete), [true, false, false, false]);
});

test('a positive collection count completes the collections step only', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu', { owned: 3 })]
  });
  const onboarding = selectOnboardingState(campaign);
  assert.deepEqual(onboarding.steps.map(step => step.complete), [false, true, false, false]);
});

test('a set baseline also completes the collections step', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu', { owned: 0, baseline: 0 }), tracker('pets', 'carnitez-silvermoon-eu', { owned: 5, baseline: 5 })]
  });
  const onboarding = selectOnboardingState(campaign);
  assert.equal(onboarding.steps[1].complete, true);
});

test('having a planned activity completes the activity step only', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'act', characterId: 'carnitez-silvermoon-eu', kind: 'planned', title: 'Work', status: 'todo', priority: 0 }]
  });
  const onboarding = selectOnboardingState(campaign);
  assert.deepEqual(onboarding.steps.map(step => step.complete), [false, false, true, false]);
});

test('having a saved session plan completes the session step and hides the fresh-campaign card', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    sessionPlans: [{ id: 'plan', title: 'Plan', status: 'draft', characterIds: ['carnitez-silvermoon-eu'], items: [] }]
  });
  const onboarding = selectOnboardingState(campaign);
  assert.equal(onboarding.steps[3].complete, true);
  assert.equal(onboarding.visible, false);
});

test('the dismissed preference hides the checklist regardless of progress', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()], preferences: { onboardingDismissed: true } });
  assert.equal(selectOnboardingState(campaign).visible, false);
});

test('a save without the onboarding preference still validates and defaults to not dismissed', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()], preferences: {} });
  const onboarding = selectOnboardingState(campaign);
  assert.equal(onboarding.dismissed, false);
  assert.equal(onboarding.visible, true);
});

test('onboarding selector never mutates canonical state', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()], collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu')] });
  const before = structuredClone(campaign);
  selectOnboardingState(campaign);
  assert.deepEqual(campaign, before);
});

test('a brand new campaign with no logged activity is classified fresh', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()] });
  assert.equal(selectCampaignStage(campaign), 'fresh');
});

test('any planned activity marks the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'act', characterId: 'carnitez-silvermoon-eu', kind: 'planned', title: 'Work', status: 'todo', priority: 0 }]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('a logged play session marks the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(1), durationMinutes: 30 }]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('a saved session plan marks the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    sessionPlans: [{ id: 'plan', title: 'Plan', status: 'draft', characterIds: ['carnitez-silvermoon-eu'], items: [] }]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('a logged gold entry marks the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'gold', characterId: 'carnitez-silvermoon-eu', kind: 'gold', occurredAt: iso(1), gold: { revenue: 10, cost: 0, delta: 10 } }]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('a non-zero collection count marks the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu', { owned: 1 })]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('a v1-migrated play session alone still classifies fresh', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'legacy-sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(1), durationMinutes: 45, gold: { revenue: 0, cost: 0, delta: 0, affectsBalance: true }, source: 'legacy-v1' }]
  });
  assert.equal(selectCampaignStage(campaign), 'fresh');
});

test('a v1-migrated gold entry alone still classifies fresh', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'legacy-gold', characterId: 'carnitez-silvermoon-eu', kind: 'gold', occurredAt: iso(1), durationMinutes: 20, gold: { revenue: 10, cost: 0, delta: 10 }, source: 'legacy-v1' }]
  });
  assert.equal(selectCampaignStage(campaign), 'fresh');
});

test('a user-logged session still marks the campaign active alongside migrated history', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [
      { id: 'legacy-sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(1), durationMinutes: 45, gold: { delta: 0 }, source: 'legacy-v1' },
      { id: 'real-sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(2), durationMinutes: 30, gold: { delta: 0 } }
    ]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('migrated collection counts are real data and still mark the campaign active', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [{ id: 'legacy-sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(1), durationMinutes: 45, gold: { delta: 0 }, source: 'legacy-v1' }],
    collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu', { owned: 42 })]
  });
  assert.equal(selectCampaignStage(campaign), 'active');
});

test('campaign stage selector never mutates canonical state', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()], collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu')] });
  const before = structuredClone(campaign);
  selectCampaignStage(campaign);
  assert.deepEqual(campaign, before);
});

const plannedActivity = (id, characterId, overrides = {}) => ({
  id, characterId, kind: 'planned', title: id, description: '', category: 'Campaign', priority: 1,
  status: 'todo', estimatedMinutes: 30, repeatType: 'daily', tags: [], notes: '', scheduledFor: null,
  schedule: { type: 'daily', startDate: '2026-07-01', dueTime: null, weekdays: [], intervalValue: 1, intervalUnit: 'days', endDate: null, timezoneMode: 'local', graceMinutes: 0, paused: false, pausedUntil: null },
  createdAt: iso(1), updatedAt: iso(1), completedAt: null, ...overrides
});
const sessionPlan = (id, status, overrides = {}) => ({
  id, title: id, status, characterIds: ['carnitez-silvermoon-eu'], items: [], totalEstimatedMinutes: 30,
  plannedFor: '2026-07-22', createdAt: iso(1), updatedAt: iso(1), startedAt: null, completedAt: null,
  endedAt: null, activeStartedAt: null, pausedAt: null, accumulatedMs: 0, currentItemId: null,
  notes: '', reconciliation: null, ...overrides
});

test('guided today asks for setup while the campaign is fresh', () => {
  const campaign = state({ activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()] });
  const view = selectGuidedToday(campaign, { now: at(22) });
  assert.equal(view.mode, 'setup');
  assert.deepEqual(view.recommendations, []);
});

test('guided today offers recommendations once there is real work', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')]
  });
  const view = selectGuidedToday(campaign, { minutes: 30, now: at(22) });
  assert.equal(view.mode, 'choose');
  assert.equal(view.minutes, 30);
  assert.ok(view.recommendations.length >= 1);
});

test('guided today hands over to a running session', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')],
    sessionPlans: [sessionPlan('running', 'in_progress', { startedAt: iso(22, 10), activeStartedAt: iso(22, 10) })]
  });
  const view = selectGuidedToday(campaign, { now: at(22) });
  assert.equal(view.mode, 'session');
  assert.equal(view.activeSession.id, 'running');
});

test('guided today treats a paused session as the session to continue', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')],
    sessionPlans: [sessionPlan('paused', 'paused', { startedAt: iso(22, 10), pausedAt: iso(22, 11) })]
  });
  assert.equal(selectGuidedToday(campaign, { now: at(22) }).mode, 'session');
});

test('guided today falls back to the saved session length', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    preferences: { defaultSessionMinutes: 90 },
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')]
  });
  assert.equal(selectGuidedToday(campaign, { now: at(22) }).minutes, 90);
  assert.equal(selectGuidedToday(campaign, { minutes: 15, now: at(22) }).minutes, 15);
});

test('guided today reports nothing to do when work exists but none is available', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [plannedActivity('done', 'carnitez-silvermoon-eu', { status: 'completed', completedAt: iso(22) })],
    collectionTrackers: [tracker('mounts', 'carnitez-silvermoon-eu', { owned: 5, target: 5 })]
  });
  const view = selectGuidedToday(campaign, { minutes: 30, now: at(22) });
  assert.equal(view.mode, 'clear');
  assert.deepEqual(view.recommendations, []);
});

test('guided today never mutates canonical state', () => {
  const campaign = state({
    activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()],
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')]
  });
  const before = structuredClone(campaign);
  selectGuidedToday(campaign, { minutes: 60, now: at(22) });
  assert.deepEqual(campaign, before);
});

const coachState = (extra = {}) => state({
  activeCharacterId: 'carnitez-silvermoon-eu', characters: [starterCharacter()], ...extra
});

test('the coach sends a fresh campaign to the setup wizard', () => {
  assert.equal(selectCoachHint(coachState(), { now: at(22) }).id, 'run-setup');
});

test('the coach asks for a first plan once activities exist', () => {
  const campaign = coachState({ activities: [plannedActivity('work', 'carnitez-silvermoon-eu')] });
  assert.equal(selectCoachHint(campaign, { now: at(22) }).id, 'plan-first-session');
});

test('the coach points at a ready plan for today', () => {
  const campaign = coachState({
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')],
    sessionPlans: [sessionPlan('ready', 'ready', { plannedFor: '2026-07-22' })]
  });
  assert.equal(selectCoachHint(campaign, { now: at(22) }).id, 'start-ready-plan');
});

test('a paused session outranks everything else', () => {
  const campaign = coachState({
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')],
    sessionPlans: [sessionPlan('paused', 'paused', { startedAt: iso(22, 10), pausedAt: iso(22, 11) })]
  });
  assert.equal(selectCoachHint(campaign, { now: at(22) }).id, 'resume-session');
});

test('the coach nudges about stale gold only once sessions are being played', () => {
  const stale = coachState({
    activities: [
      plannedActivity('work', 'carnitez-silvermoon-eu'),
      { id: 'sess', characterId: 'carnitez-silvermoon-eu', kind: 'session', occurredAt: iso(21), durationMinutes: 40, gold: { delta: 0 } },
      { id: 'gold', characterId: 'carnitez-silvermoon-eu', kind: 'gold', occurredAt: iso(1), durationMinutes: 10, gold: { revenue: 5, cost: 0, delta: 5 } }
    ],
    sessionPlans: [sessionPlan('done', 'completed', { completedAt: iso(21) })]
  });
  assert.equal(selectCoachHint(stale, { now: at(22) }).id, 'log-gold');
});

test('the coach stays quiet when the campaign is healthy', () => {
  const campaign = coachState({
    activities: [
      plannedActivity('work', 'carnitez-silvermoon-eu'),
      { id: 'gold', characterId: 'carnitez-silvermoon-eu', kind: 'gold', occurredAt: iso(21), durationMinutes: 10, gold: { revenue: 5, cost: 0, delta: 5 } }
    ],
    sessionPlans: [sessionPlan('done', 'completed', { completedAt: iso(21) })]
  });
  assert.equal(selectCoachHint(campaign, { now: at(22) }), null);
});

test('a dismissed hint stays gone for seven days and then returns', () => {
  const campaign = coachState({ activities: [plannedActivity('work', 'carnitez-silvermoon-eu')] });
  const dismissed = { ...campaign, preferences: { coachDismissals: { 'plan-first-session': iso(20) } } };
  assert.equal(selectCoachHint(dismissed, { now: at(22) }), null);
  assert.equal(selectCoachHint(dismissed, { now: at(28) })?.id, 'plan-first-session');
});

test('dismissing one hint does not silence the others', () => {
  const campaign = coachState({
    activities: [plannedActivity('work', 'carnitez-silvermoon-eu')],
    sessionPlans: [sessionPlan('paused', 'paused', { startedAt: iso(22, 10), pausedAt: iso(22, 11) })],
    preferences: { coachDismissals: { 'resume-session': iso(22) } }
  });
  // The next applicable rule takes over. It is not plan-first-session: a session plan
  // already exists, so that rule correctly does not apply.
  assert.equal(selectCoachHint(campaign, { now: at(22) })?.id, 'log-gold');
});

test('the coach never mutates canonical state', () => {
  const campaign = coachState({ activities: [plannedActivity('work', 'carnitez-silvermoon-eu')] });
  const before = structuredClone(campaign);
  selectCoachHint(campaign, { now: at(22) });
  assert.deepEqual(campaign, before);
});
