import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_TEMPLATES, ACTIVITY_PACKS, templateById, packById, templatesForPack,
  packsForPlaystyles, templateToActivityInput, addTemplatesToState, resetWeekdayForRegion
} from '../src/templates.mjs';
import { createPlannedActivity, isPlannedActivity } from '../src/activity-engine.mjs';
import { normalizeSchedule, validateSchedule } from '../src/schedule-engine.mjs';
import { validateV2State } from '../src/core.mjs';

const now = new Date(2026, 6, 20, 12, 0, 0);
const iso = (day, hour = 12) => new Date(2026, 6, day, hour, 0, 0).toISOString();
const character = (id = 'a', extra = {}) => ({
  id, name: id.toUpperCase(), realm: 'Silvermoon', region: 'EU', faction: 'Alliance', race: 'Night Elf',
  className: 'Druid', spec: 'Guardian', professions: '', level: 80, gold: 100, playedMinutes: 60,
  location: 'Valdrakken', createdAt: iso(1), ...extra
});
const state = (extra = {}) => ({
  schemaVersion: 2, activeCharacterId: 'a', preferences: {}, characters: [character()],
  goals: [], activities: [], progressEvents: [], collectionTrackers: [], sessionPlans: [],
  activityOccurrences: [], recommendationHistory: [],
  migration: { sourceVersion: 2, targetVersion: 2, migratedAt: iso(1) }, ...extra
});

test('every template produces a valid planned activity', () => {
  for (const item of ACTIVITY_TEMPLATES) {
    const activity = createPlannedActivity(templateToActivityInput(item, { characterId: 'a', region: 'EU' }), { id: item.id, now });
    assert.equal(isPlannedActivity(activity), true, `${item.id} is not a planned activity`);
    assert.equal(activity.title, item.title);
    assert.ok(activity.estimatedMinutes > 0, `${item.id} has no duration`);
  }
});

test('every template schedule survives normalization and validation', () => {
  for (const item of ACTIVITY_TEMPLATES) {
    const activity = createPlannedActivity(templateToActivityInput(item, { characterId: 'a', region: 'EU' }), { id: item.id, now });
    const schedule = normalizeSchedule(activity);
    const result = validateSchedule(schedule);
    assert.equal(result.ok, true, `${item.id} schedule invalid: ${(result.errors || []).join(', ')}`);
  }
});

test('template ids are unique and every pack references real templates', () => {
  const ids = ACTIVITY_TEMPLATES.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate template id');
  const packIds = ACTIVITY_PACKS.map(item => item.id);
  assert.equal(new Set(packIds).size, packIds.length, 'duplicate pack id');
  for (const item of ACTIVITY_PACKS) {
    assert.ok(item.templateIds.length > 0, `${item.id} is empty`);
    for (const id of item.templateIds) assert.ok(templateById(id), `${item.id} references missing template ${id}`);
  }
});

test('weekly templates anchor to the regional reset day', () => {
  assert.equal(resetWeekdayForRegion('EU'), 3);
  assert.equal(resetWeekdayForRegion('US'), 2);
  assert.equal(resetWeekdayForRegion('unknown'), 3);
  const weekly = ACTIVITY_TEMPLATES.find(item => item.cadence === 'weekly');
  assert.deepEqual(templateToActivityInput(weekly, { characterId: 'a', region: 'US' }).schedule.weekdays, [2]);
  assert.deepEqual(templateToActivityInput(weekly, { characterId: 'a', region: 'EU' }).schedule.weekdays, [3]);
});

test('universal packs apply to everyone while playstyle packs are opt-in', () => {
  const none = packsForPlaystyles([]).map(item => item.id);
  assert.deepEqual(none, ['daily-chores', 'weekly-reset']);
  const gold = packsForPlaystyles(['gold']).map(item => item.id);
  assert.ok(gold.includes('gold-farming'));
  assert.ok(!gold.includes('pets'));
});

test('adding a pack creates one activity per template and keeps state valid', () => {
  const campaign = state();
  const ids = packById('daily-chores').templateIds;
  const result = addTemplatesToState(campaign, ids, { characterId: 'a', now });
  assert.equal(result.added.length, ids.length);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.state.activities.length, ids.length);
  assert.equal(validateV2State(result.state).ok, true);
});

test('adding the same pack twice never duplicates activities', () => {
  const ids = packById('daily-chores').templateIds;
  const first = addTemplatesToState(state(), ids, { characterId: 'a', now });
  const second = addTemplatesToState(first.state, ids, { characterId: 'a', now });
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, ids.length);
  assert.equal(second.state.activities.length, ids.length);
});

test('packs that share a template do not create it twice', () => {
  const withMythics = addTemplatesToState(state(), packById('mythics').templateIds, { characterId: 'a', now });
  // 'vault-progress' belongs to weekly-reset, raiding and mythics alike.
  const withWeekly = addTemplatesToState(withMythics.state, packById('weekly-reset').templateIds, { characterId: 'a', now });
  const titles = withWeekly.state.activities.map(item => item.title);
  assert.equal(new Set(titles).size, titles.length, 'a shared template was added twice');
});

test('adding templates never mutates the input state', () => {
  const campaign = state();
  const before = structuredClone(campaign);
  addTemplatesToState(campaign, packById('gold-farming').templateIds, { characterId: 'a', now });
  assert.deepEqual(campaign, before);
});

test('templates are added to the requested character, not just the active one', () => {
  const campaign = state({ characters: [character('a'), character('b', { region: 'US' })] });
  const result = addTemplatesToState(campaign, ['world-quest-sweep'], { characterId: 'b', now });
  assert.equal(result.added[0].characterId, 'b');
});

test('unknown template ids are ignored rather than throwing', () => {
  const result = addTemplatesToState(state(), ['not-a-real-template', 'world-quest-sweep'], { characterId: 'a', now });
  assert.equal(result.added.length, 1);
});

test('templatesForPack resolves in declared order', () => {
  const ids = templatesForPack('daily-chores').map(item => item.id);
  assert.deepEqual(ids, [...packById('daily-chores').templateIds]);
  assert.deepEqual(templatesForPack('nope'), []);
});
