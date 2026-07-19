import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSavedPlan, validateSavedPlan, updateSavedPlan, addActivityToPlan, removeSessionItem,
  reorderSessionItems, updateSessionItemPlan, duplicateSavedPlan, startSession, pauseSession,
  resumeSession, elapsedSessionMs, updateSessionItemResult, setCurrentSessionItem,
  addUnplannedActivity, appendSessionNote, abandonSession, sessionSummary, finalizeSession,
  reconcileSessionResults, selectRunningSession, selectActiveSession, filterSessionHistory,
  sessionRecommendation
} from '../src/session-engine.mjs';
import { createPlannedActivity, effectiveActivityStatus } from '../src/activity-engine.mjs';
import { validateV2State, persistV2, migrateState, V2_STORAGE_KEY } from '../src/core.mjs';
import { selectNextUp, selectRecentActivity, selectWeeklyMomentum } from '../src/selectors.mjs';

const at = (day, hour = 12, minute = 0) => new Date(2026, 6, day, hour, minute, 0);
const iso = (day, hour = 12, minute = 0) => at(day, hour, minute).toISOString();
const character = (id = 'a', overrides = {}) => ({
  id, name: id === 'a' ? 'Carnitez' : 'Moonalt', realm: 'Silvermoon', region: 'EU', faction: 'Alliance',
  race: 'Night Elf', className: 'Druid', spec: 'Guardian', professions: '', level: 70, gold: 1000,
  playedMinutes: 60, location: 'Valdrakken', createdAt: iso(1), ...overrides
});
const activity = (id, overrides = {}) => createPlannedActivity({
  title: id, description: `${id} work`, characterId: 'a', category: 'Campaign', priority: 2,
  status: 'todo', estimatedMinutes: 30, repeatType: 'one_time', tags: [], notes: '', ...overrides
}, { id, now: at(19) });
const baseState = (overrides = {}) => ({
  schemaVersion: 2, activeCharacterId: 'a', preferences: {}, characters: [character('a'), character('b')],
  goals: [], activities: [], progressEvents: [], collectionTrackers: [], sessionPlans: [],
  migration: { sourceVersion: 2, targetVersion: 2, migratedAt: iso(1) }, ...overrides
});
const generated = (...activities) => ({ items: activities.map(item => ({ activity: item, locked: false })), totalMinutes: activities.reduce((sum, item) => sum + item.estimatedMinutes, 0) });
const savedPlan = (activities = [activity('one'), activity('two')], overrides = {}) => ({
  ...createSavedPlan(generated(...activities), { title: 'Evening route', plannedFor: '2026-07-20', status: 'ready' }, { id: 'plan-1', now: at(20, 18) }),
  ...overrides
});
const replacePlan = (state, plan) => ({ ...state, sessionPlans: state.sessionPlans.map(item => item.id === plan.id ? plan : item) });
const memoryStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, value), values };
};

test('saving a generated plan creates stable activity references and historical snapshots', () => {
  const source = activity('weekly', { category: 'Weekly', repeatType: 'weekly' });
  const plan = savedPlan([source]);
  assert.equal(plan.id, 'plan-1');
  assert.equal(plan.items[0].activityId, source.id);
  assert.deepEqual(plan.items[0].snapshot, { title: 'weekly', category: 'Weekly', characterId: 'a', repeatType: 'weekly' });
  assert.equal(plan.totalEstimatedMinutes, 30);
  assert.equal(validateSavedPlan(plan).ok, true);
});

test('saved plans persist and reload through the existing schema-v2 key', () => {
  const campaign = baseState({ activities: [activity('one')], sessionPlans: [savedPlan([activity('one')])] });
  const storage = memoryStorage();
  persistV2(storage, campaign);
  const reloaded = migrateState(JSON.parse(storage.getItem(V2_STORAGE_KEY)));
  assert.deepEqual(reloaded.sessionPlans, campaign.sessionPlans);
});

test('existing v2 data without session fields loads with an empty optional collection', () => {
  const legacyV2 = baseState();
  delete legacyV2.sessionPlans;
  assert.deepEqual(migrateState(legacyV2).sessionPlans, []);
  assert.equal(validateV2State(legacyV2).ok, true);
});

test('draft plan editing supports title, date, notes, add, remove, order, lock and estimates', () => {
  const first = activity('first');
  const second = activity('second', { characterId: 'b' });
  let plan = savedPlan([first]);
  plan = updateSavedPlan(plan, { title: 'Edited plan', plannedFor: '2026-07-21', notes: 'Bring flasks', status: 'draft' }, { now: at(20, 19) });
  plan = addActivityToPlan(plan, second, { now: at(20, 19) });
  plan = updateSessionItemPlan(plan, plan.items[1].id, { locked: true, plannedMinutes: 45 }, { now: at(20, 19) });
  plan = reorderSessionItems(plan, 1, 0, { now: at(20, 19) });
  plan = removeSessionItem(plan, plan.items[1].id, { now: at(20, 19) });
  assert.equal(plan.title, 'Edited plan');
  assert.equal(plan.plannedFor, '2026-07-21');
  assert.equal(plan.items[0].snapshot.title, 'second');
  assert.equal(plan.items[0].locked, true);
  assert.equal(plan.items[0].plannedMinutes, 45);
  assert.deepEqual(plan.characterIds, ['b']);
});

test('duplicating a completed plan produces an independent clean draft', () => {
  const completed = savedPlan(undefined, { status: 'completed', completedAt: iso(20, 20) });
  const copy = duplicateSavedPlan(completed, { id: 'copy', now: at(21) });
  assert.equal(copy.id, 'copy');
  assert.equal(copy.status, 'draft');
  assert.equal(copy.items.every(item => item.status === 'pending' && item.actualMinutes === 0), true);
  assert.notEqual(copy.items[0].id, completed.items[0].id);
});

test('starting a session selects the first item and records a stable timing segment', () => {
  const plan = savedPlan();
  const running = startSession(plan, baseState({ sessionPlans: [plan] }), { now: at(20, 19) });
  assert.equal(running.status, 'in_progress');
  assert.equal(running.currentItemId, running.items[0].id);
  assert.equal(running.items[0].status, 'current');
  assert.equal(running.startedAt, iso(20, 19));
  assert.equal(selectRunningSession(baseState({ sessionPlans: [running] })).id, running.id);
});

test('a second running session is rejected until the first is paused or ended', () => {
  const first = startSession(savedPlan(), baseState(), { now: at(20, 18) });
  const second = savedPlan([activity('other')], { id: 'plan-2' });
  assert.throws(() => startSession(second, baseState({ sessionPlans: [first, second] }), { now: at(20, 19) }), /Pause, finish, or abandon/);
  const paused = pauseSession(first, { now: at(20, 18, 30) });
  assert.equal(startSession(second, baseState({ sessionPlans: [paused, second] }), { now: at(20, 19) }).status, 'in_progress');
});

test('pause and resume exclude paused time from elapsed duration', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 18) });
  const paused = pauseSession(running, { now: at(20, 18, 20) });
  assert.equal(elapsedSessionMs(paused, at(20, 19)), 20 * 60_000);
  const resumed = resumeSession(paused, baseState({ sessionPlans: [paused] }), { now: at(20, 19) });
  assert.equal(elapsedSessionMs(resumed, at(20, 19, 10)), 30 * 60_000);
});

test('reloading an active session restores elapsed time from persisted timestamps', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 23, 50) });
  const reloaded = JSON.parse(JSON.stringify(running));
  assert.equal(elapsedSessionMs(reloaded, at(21, 0, 10)), 20 * 60_000);
});

test('reloading a paused session keeps elapsed time frozen', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 22) });
  const paused = pauseSession(running, { now: at(20, 22, 12) });
  const reloaded = JSON.parse(JSON.stringify(paused));
  assert.equal(elapsedSessionMs(reloaded, at(22)), 12 * 60_000);
});

test('sessions crossing midnight preserve exact timestamps and positive duration', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 23, 55) });
  const paused = pauseSession(running, { now: at(21, 0, 5) });
  assert.equal(paused.startedAt, iso(20, 23, 55));
  assert.equal(paused.pausedAt, iso(21, 0, 5));
  assert.equal(elapsedSessionMs(paused), 10 * 60_000);
});

test('completing an item records results and advances to the next item', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 18) });
  const updated = updateSessionItemResult(running, running.currentItemId, { status: 'completed', actualMinutes: 25, resultNotes: 'Done', goldEarned: 100 }, { now: at(20, 18, 25) });
  assert.equal(updated.items[0].status, 'completed');
  assert.equal(updated.items[0].actualMinutes, 25);
  assert.equal(updated.items[1].status, 'current');
  assert.equal(updated.currentItemId, updated.items[1].id);
});

test('skipping an item records no rewards and never completes its source activity', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 18) });
  const skipped = updateSessionItemResult(running, running.currentItemId, { status: 'skipped', goldEarned: 500, progressMetric: 'level', progressGained: 1, completeUnderlying: true }, { now: at(20, 18, 1) });
  assert.equal(skipped.items[0].status, 'skipped');
  assert.equal(skipped.items[0].goldEarned, 0);
  assert.equal(skipped.items[0].completeUnderlying, false);
});

test('partial completion preserves the reusable activity as unfinished', () => {
  const source = activity('partial-source');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'partial', actualMinutes: 10, completionQuantity: 3, completeUnderlying: true }, { now: at(20, 18, 10) });
  const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 11) });
  assert.equal(finalized.activities.find(item => item.id === source.id).status, 'todo');
  assert.equal(finalized.sessionPlans[0].items[0].completionQuantity, 3);
});

test('one-time activity completion can update the underlying activity when confirmed', () => {
  const source = activity('once');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', actualMinutes: 20, completeUnderlying: true }, { now: at(20, 18, 20) });
  const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 21) });
  assert.equal(finalized.activities.find(item => item.id === source.id).status, 'completed');
});

for (const repeatType of ['daily', 'weekly', 'manual']) {
  test(`${repeatType} activity runs log without completing the reusable activity by default`, () => {
    const source = activity(`${repeatType}-source`, { repeatType });
    let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
    running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', actualMinutes: 15, completeUnderlying: false }, { now: at(20, 18, 15) });
    const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 16) });
    assert.equal(finalized.activities.find(item => item.id === source.id).status, 'todo');
  });
}

test('a confirmed daily completion becomes available on the next local day', () => {
  const source = activity('daily-confirmed', { repeatType: 'daily' });
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', completeUnderlying: true }, { now: at(20, 18, 5) });
  const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 6) });
  const updatedSource = finalized.activities.find(item => item.id === source.id);
  assert.equal(effectiveActivityStatus(updatedSource, at(20, 20)), 'completed');
  assert.equal(effectiveActivityStatus(updatedSource, at(21, 8)), 'todo');
});

test('unplanned activities and quick notes remain part of the saved runner state', () => {
  const plan = startSession(savedPlan([activity('planned')]), baseState(), { now: at(20, 18) });
  const withExtra = addUnplannedActivity(plan, activity('extra', { characterId: 'b' }), { now: at(20, 18, 1) });
  const noted = appendSessionNote(withExtra, 'Rare spawned', { now: at(20, 18, 2) });
  assert.equal(noted.items.at(-1).unplanned, true);
  assert.match(noted.notes, /Rare spawned/);
});

test('gold results create one linked record and update balance and economy totals', () => {
  const source = activity('gold-run');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', actualMinutes: 30, goldEarned: 500.5, goldSpent: 100.25 }, { now: at(20, 18, 30) });
  const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 31) });
  const linkedGold = finalized.activities.filter(item => item.sourceSessionId === running.id && item.kind === 'gold');
  assert.equal(linkedGold.length, 1);
  assert.equal(finalized.characters[0].gold, 1400.25);
  assert.equal(linkedGold[0].gold.delta, 400.25);
});

test('editing gold results reconciles the linked record without double counting', () => {
  const source = activity('gold-edit');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', goldEarned: 500 }, { now: at(20, 18, 10) });
  let state = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 11) });
  let completed = state.sessionPlans[0];
  completed = updateSessionItemResult(completed, completed.items[0].id, { status: 'completed', goldEarned: 300, goldSpent: 50 }, { now: at(20, 18, 12), advance: false });
  state = replacePlan(state, completed);
  const reconciled = reconcileSessionResults(state, completed, { now: at(20, 18, 13) });
  reconciled.state.sessionPlans[0] = reconciled.plan;
  assert.equal(reconciled.state.characters[0].gold, 1250);
  assert.equal(reconciled.state.activities.filter(item => item.sourceSessionId === completed.id && item.kind === 'gold').length, 1);
});

test('linked progress events are stable and reconcile edits without duplicates', () => {
  const source = activity('level-run');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', progressMetric: 'level', progressGained: 1 }, { now: at(20, 18, 10) });
  let state = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 11) });
  assert.equal(state.characters[0].level, 71);
  let completed = updateSessionItemResult(state.sessionPlans[0], state.sessionPlans[0].items[0].id, { status: 'completed', progressMetric: 'level', progressGained: 2 }, { now: at(20, 18, 12), advance: false });
  state = replacePlan(state, completed);
  const reconciled = reconcileSessionResults(state, completed, { now: at(20, 18, 13) });
  assert.equal(reconciled.state.characters[0].level, 72);
  assert.equal(reconciled.state.progressEvents.filter(event => event.sourceSessionId === completed.id).length, 1);
  assert.equal(reconciled.state.progressEvents.find(event => event.sourceSessionId === completed.id).value, 72);
});

test('session completion summary and linked timeline refresh existing selectors', () => {
  const source = activity('summary-run');
  let running = startSession(savedPlan([source]), baseState({ activities: [source] }), { now: at(20, 18) });
  running = updateSessionItemResult(running, running.currentItemId, { status: 'completed', actualMinutes: 20, goldEarned: 200 }, { now: at(20, 18, 20) });
  const summary = sessionSummary(running, { now: at(20, 18, 20) });
  assert.equal(summary.completed, 1);
  assert.equal(summary.netGold, 200);
  const finalized = finalizeSession(baseState({ activities: [source], sessionPlans: [running] }), running.id, { now: at(20, 18, 21) });
  assert.ok(selectRecentActivity(finalized).some(item => item.sourceId.startsWith('session-timeline-')));
  assert.equal(selectWeeklyMomentum(finalized, { now: at(20, 18, 22) }).sessions, 1);
});

test('abandon flow freezes elapsed timing and remains filterable history', () => {
  const running = startSession(savedPlan(), baseState(), { now: at(20, 18) });
  const abandoned = abandonSession(running, { now: at(20, 18, 15) });
  const state = baseState({ sessionPlans: [abandoned] });
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(elapsedSessionMs(abandoned, at(21)), 15 * 60_000);
  assert.deepEqual(filterSessionHistory(state, { view: 'abandoned', now: at(20) }).map(plan => plan.id), [abandoned.id]);
});

test('session history filters active, upcoming, completed, abandoned and all', () => {
  const ready = savedPlan();
  const active = startSession(savedPlan([activity('active')], { id: 'active' }), baseState(), { now: at(20, 18) });
  const completed = { ...savedPlan([activity('done')], { id: 'done' }), status: 'completed', completedAt: iso(20, 19) };
  const abandoned = { ...savedPlan([activity('gone')], { id: 'gone' }), status: 'abandoned', endedAt: iso(20, 19) };
  const state = baseState({ sessionPlans: [ready, active, completed, abandoned] });
  assert.equal(filterSessionHistory(state, { view: 'active', now: at(20) }).length, 1);
  assert.equal(filterSessionHistory(state, { view: 'upcoming', now: at(20) }).length, 1);
  assert.equal(filterSessionHistory(state, { view: 'completed', now: at(20) }).length, 1);
  assert.equal(filterSessionHistory(state, { view: 'abandoned', now: at(20) }).length, 1);
  assert.equal(filterSessionHistory(state, { view: 'all', now: at(20) }).length, 4);
});

test('active, paused and ready sessions outrank activities and goals in Next Up', () => {
  const ready = savedPlan();
  const paused = pauseSession(startSession(savedPlan([activity('paused-item')], { id: 'paused-plan' }), baseState(), { now: at(20, 17) }), { now: at(20, 17, 5) });
  const running = startSession(savedPlan([activity('running-item')], { id: 'running-plan' }), baseState({ sessionPlans: [paused] }), { now: at(20, 18) });
  const state = baseState({ activities: [activity('normal')], sessionPlans: [ready, paused, running] });
  assert.deepEqual(selectNextUp(state, { limit: 3, now: at(20, 18, 1) }).map(item => item.sourceId), [running.id, paused.id, ready.id]);
});

test('missing source activities retain understandable snapshots and can be reviewed', () => {
  const plan = savedPlan([activity('removed-later')]);
  const state = baseState({ activities: [], sessionPlans: [plan] });
  assert.equal(state.sessionPlans[0].items[0].snapshot.title, 'removed-later');
  assert.equal(validateV2State(state).ok, true);
});

test('session selectors and transitions never mutate canonical input', () => {
  const plan = savedPlan();
  const state = baseState({ sessionPlans: [plan] });
  const before = JSON.stringify(state);
  selectActiveSession(state);
  filterSessionHistory(state, { view: 'all', now: at(20) });
  sessionRecommendation(plan, state, { now: at(20) });
  selectNextUp(state, { now: at(20) });
  const running = startSession(plan, state, { now: at(20, 18) });
  setCurrentSessionItem(running, running.items[1].id, { now: at(20, 18, 1) });
  assert.equal(JSON.stringify(state), before);
});
