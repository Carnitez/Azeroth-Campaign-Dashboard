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
  selectNextUp
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
      character('incomplete', { spec: '' }), character('complete'), character('archived', { archivedAt: iso(20) })
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
