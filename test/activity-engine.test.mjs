import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlannedActivity,
  updatePlannedActivity,
  setPlannedActivityStatus,
  duplicatePlannedActivity,
  effectiveActivityStatus,
  selectPlannedActivities,
  planSession,
  reorderPlan,
  buildCommandCatalog,
  searchCommands,
  recordCommandUse,
  moveCommandSelection
} from '../src/activity-engine.mjs';
import { validateV2State, persistV2, V2_STORAGE_KEY } from '../src/core.mjs';
import { selectNextUp } from '../src/selectors.mjs';

const now = new Date(2026, 6, 20, 18, 0, 0);
const iso = (day, hour = 12) => new Date(2026, 6, day, hour, 0, 0).toISOString();
const character = (id, overrides = {}) => ({
  id, name: id.toUpperCase(), realm: 'Silvermoon', region: 'EU', faction: 'Alliance', race: 'Night Elf',
  className: 'Druid', spec: 'Guardian', professions: '', level: 80, gold: 1000, playedMinutes: 60,
  location: 'Valdrakken', createdAt: iso(1), ...overrides
});
const planned = (id, overrides = {}) => createPlannedActivity({
  title: id, description: `${id} description`, characterId: 'a', category: 'Campaign', priority: 1,
  status: 'todo', estimatedMinutes: 30, repeatType: 'one_time', tags: ['campaign'], notes: '', ...overrides
}, { id, now: new Date(2026, 6, 18, 12) });
const state = (overrides = {}) => ({
  schemaVersion: 2, activeCharacterId: 'a', preferences: {}, characters: [character('a'), character('b')],
  goals: [], activities: [], progressEvents: [], collectionTrackers: [],
  migration: { sourceVersion: 2, targetVersion: 2, migratedAt: iso(1) }, ...overrides
});

test('planned activity creation produces a valid schema-v2 record', () => {
  const activity = planned('quest', { tags: 'story, zone, story', scheduledFor: '2026-07-20' });
  assert.equal(activity.kind, 'planned');
  assert.deepEqual(activity.tags, ['story', 'zone']);
  assert.equal(activity.completedAt, null);
  assert.equal(validateV2State(state({ activities: [activity] })).ok, true);
});

test('editing preserves identity and creation time while updating editable fields', () => {
  const original = planned('edit');
  const edited = updatePlannedActivity(original, { title: 'Edited', priority: 3, tags: ['new'] }, { now });
  assert.equal(edited.id, original.id);
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.updatedAt, now.toISOString());
  assert.equal(edited.title, 'Edited');
  assert.deepEqual(edited.tags, ['new']);
  assert.equal(original.title, 'edit');
});

test('completion, undo and duplication preserve safe activity semantics', () => {
  const original = planned('finish');
  const completed = setPlannedActivityStatus(original, 'completed', { now });
  const reopened = setPlannedActivityStatus(completed, 'todo', { now: new Date(2026, 6, 20, 19) });
  const copy = duplicatePlannedActivity(completed, { id: 'copy', now });
  assert.equal(completed.completedAt, now.toISOString());
  assert.equal(reopened.completedAt, null);
  assert.equal(copy.id, 'copy');
  assert.equal(copy.status, 'todo');
  assert.equal(copy.title, 'finish copy');
});

test('daily and weekly repeats become available after their local boundary', () => {
  const daily = { ...planned('daily', { repeatType: 'daily' }), status: 'completed', completedAt: iso(19, 22) };
  const weeklyOld = { ...planned('weekly', { repeatType: 'weekly' }), status: 'completed', completedAt: iso(12) };
  const weeklyCurrent = { ...planned('weekly-current', { repeatType: 'weekly' }), status: 'completed', completedAt: iso(20, 9) };
  const manual = { ...planned('manual', { repeatType: 'manual' }), status: 'completed', completedAt: iso(19) };
  assert.equal(effectiveActivityStatus(daily, now), 'todo');
  assert.equal(effectiveActivityStatus(weeklyOld, now), 'todo');
  assert.equal(effectiveActivityStatus(weeklyCurrent, now), 'completed');
  assert.equal(effectiveActivityStatus(manual, now), 'completed');
  assert.equal(setPlannedActivityStatus(daily, 'completed', { now }).completedAt, now.toISOString());
});

test('activity filters cover views, character, category, priority, status, tags and search', () => {
  const campaign = state({ activities: [
    planned('today', { category: 'Weekly', priority: 3, tags: ['raid', 'weekly'], scheduledFor: '2026-07-20' }),
    planned('future', { characterId: 'b', category: 'Gold', priority: 1, tags: ['farm'], scheduledFor: '2026-07-22' }),
    { ...planned('done', { tags: ['raid'] }), status: 'completed', completedAt: iso(20) }
  ] });
  assert.deepEqual(selectPlannedActivities(campaign, { view: 'today', now }).map(x => x.id), ['today']);
  assert.deepEqual(selectPlannedActivities(campaign, { view: 'upcoming', now }).map(x => x.id), ['future']);
  assert.deepEqual(selectPlannedActivities(campaign, { view: 'completed', now }).map(x => x.id), ['done']);
  assert.deepEqual(selectPlannedActivities(campaign, { characterId: 'b', category: 'Gold', now }).map(x => x.id), ['future']);
  assert.deepEqual(selectPlannedActivities(campaign, { priority: 3, status: 'todo', tags: 'raid', search: 'weekly', now }).map(x => x.id), ['today']);
});

test('activity sorting supports priority, recently updated, estimate and alphabetic order', () => {
  const campaign = state({ activities: [
    { ...planned('Bravo', { priority: 1, estimatedMinutes: 60 }), updatedAt: iso(18) },
    { ...planned('Alpha', { priority: 3, estimatedMinutes: 15 }), updatedAt: iso(17) },
    { ...planned('Charlie', { priority: 0, estimatedMinutes: 30 }), updatedAt: iso(20) }
  ] });
  assert.deepEqual(selectPlannedActivities(campaign, { sort: 'priority', now }).map(x => x.id), ['Alpha', 'Bravo', 'Charlie']);
  assert.deepEqual(selectPlannedActivities(campaign, { sort: 'recent', now }).map(x => x.id), ['Charlie', 'Bravo', 'Alpha']);
  assert.deepEqual(selectPlannedActivities(campaign, { sort: 'estimated', now }).map(x => x.id), ['Alpha', 'Charlie', 'Bravo']);
  assert.deepEqual(selectPlannedActivities(campaign, { sort: 'alphabetical', now }).map(x => x.id), ['Alpha', 'Bravo', 'Charlie']);
});

test('session planner follows status, priority, active character and short-session rules', () => {
  const campaign = state({ activities: [
    planned('doing', { status: 'in_progress', priority: 0, estimatedMinutes: 30, characterId: 'b' }),
    planned('critical', { priority: 3, estimatedMinutes: 20, characterId: 'a' }),
    planned('active', { priority: 1, estimatedMinutes: 10, characterId: 'a' }),
    planned('other', { priority: 1, estimatedMinutes: 10, characterId: 'b' })
  ] });
  const plan = planSession(campaign, { budgetMinutes: 60, activeCharacterId: 'a', now });
  assert.deepEqual(plan.items.map(item => item.activity.id), ['doing', 'critical', 'active']);
  assert.equal(plan.totalMinutes, 60);
  assert.ok(plan.totalMinutes <= 65);
  assert.equal(plan.items[0].reason, 'Already in progress');
});

test('planner never exceeds the five-minute allowance', () => {
  const campaign = state({ activities: [planned('a20', { estimatedMinutes: 20 }), planned('b20', { estimatedMinutes: 20 }), planned('c20', { estimatedMinutes: 20 })] });
  const plan = planSession(campaign, { budgetMinutes: 30, now });
  assert.equal(plan.totalMinutes, 20);
  assert.ok(plan.totalMinutes <= 35);
});

test('planner regeneration preserves locked items and replaces removed items', () => {
  const campaign = state({ activities: [planned('first', { priority: 3, estimatedMinutes: 20 }), planned('second', { priority: 2, estimatedMinutes: 20 }), planned('third', { priority: 1, estimatedMinutes: 20 })] });
  const regenerated = planSession(campaign, { budgetMinutes: 40, lockedIds: ['second'], excludedIds: ['first'], currentOrder: ['second', 'first'], now });
  assert.deepEqual(regenerated.items.map(item => item.activity.id), ['second', 'third']);
  assert.equal(regenerated.items[0].locked, true);
});

test('plan reordering is pure and bounded', () => {
  const input = ['a', 'b', 'c'];
  assert.deepEqual(reorderPlan(input, 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(input, ['a', 'b', 'c']);
  assert.deepEqual(reorderPlan(input, 5, 0), input);
});

test('command search supports partial and subsequence matches across real records', () => {
  const campaign = state({
    activities: [planned('activity-one', { title: 'Dragonflight weekly sweep' })],
    goals: [{ id: 'goal-1', characterId: 'a', scope: 'character', category: 'Gold', title: 'Reach 20k gold', status: 'todo', priority: 1, createdAt: iso(1), completedAt: null }]
  });
  const catalog = buildCommandCatalog(campaign);
  assert.equal(searchCommands(catalog, 'dragon weekly')[0].id, 'activity:activity-one');
  assert.equal(searchCommands(catalog, '20k')[0].id, 'goal:goal-1');
  assert.ok(searchCommands(catalog, 'op act').some(item => item.id === 'nav-activities'));
});

test('the command palette never offers to switch to the already-active character', () => {
  const campaign = state({ activeCharacterId: 'a', characters: [character('a'), character('b')] });
  const catalog = buildCommandCatalog(campaign);
  assert.equal(catalog.some(item => item.id === 'switch:a'), false);
  assert.equal(catalog.some(item => item.id === 'switch:b'), true);
});

test('recent and frequently used commands rise before default commands', () => {
  const items = buildCommandCatalog(state());
  let preferences = recordCommandUse({}, 'create-activity', { now });
  preferences = recordCommandUse(preferences, 'nav-activities', { now });
  preferences = recordCommandUse(preferences, 'create-activity', { now });
  const results = searchCommands(items, '', { history: preferences.commandPalette });
  assert.equal(results[0].id, 'create-activity');
  assert.equal(results[1].id, 'nav-activities');
  assert.equal(preferences.commandPalette.usage['create-activity'], 2);
});

test('keyboard command selection wraps in both directions', () => {
  assert.equal(moveCommandSelection(-1, 1, 3), 0);
  assert.equal(moveCommandSelection(2, 1, 3), 0);
  assert.equal(moveCommandSelection(0, -1, 3), 2);
  assert.equal(moveCommandSelection(0, 1, 0), -1);
});

test('planned activities persist through the existing schema-v2 storage path', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const campaign = state({ activities: [planned('persisted')] });
  persistV2(storage, campaign);
  assert.equal(JSON.parse(store.get(V2_STORAGE_KEY)).activities[0].id, 'persisted');
});

test('Next Up places existing planned activities before goals without mutating state', () => {
  const campaign = state({
    activities: [planned('planned-next', { priority: 0 })],
    goals: [{ id: 'goal-high', characterId: 'a', scope: 'character', category: 'Campaign', title: 'Goal', status: 'in_progress', priority: 3, createdAt: iso(1), completedAt: null }]
  });
  const before = structuredClone(campaign);
  const next = selectNextUp(campaign, { now });
  assert.equal(next[0].sourceType, 'activity');
  assert.equal(next[1].sourceType, 'goal');
  assert.deepEqual(campaign, before);
});
