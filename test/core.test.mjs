import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  V1_STORAGE_KEY, V2_STORAGE_KEY, V1_RECOVERY_KEY, V2_RECOVERY_KEY, createStarterState, validateV2State,
  migrateV1ToV2, migrateState, loadPersistedState, persistV2, calculateGoldTotals,
  groupByLocalDate, localDateKey
} from '../src/core.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
const storage = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), dump: () => Object.fromEntries(map) };
};

test('migrates realistic v1 data without mutating it', async () => {
  const input = await fixture('realistic-v1.json');
  const before = structuredClone(input);
  const output = migrateV1ToV2(input, { now: new Date('2026-07-18T10:00:00.000Z') });
  assert.deepEqual(input, before);
  assert.equal(output.schemaVersion, 2);
  assert.equal(output.characters[0].id, 'carnitez');
  assert.equal(output.goals[0].id, 'goal-existing');
  assert.equal(output.activities.filter(x => x.kind === 'session').length, 1);
  assert.equal(output.activities.filter(x => x.kind === 'gold').length, 1);
  assert.equal(output.activities.find(x => x.kind === 'gold').gold.affectsBalance, false);
  assert.ok(output.progressEvents.some(x => x.metric === 'liquidGold' && x.value === 12500));
  assert.equal(output.collectionTrackers.find(x => x.name === 'Mounts').characterId, 'carnitez');
  assert.deepEqual(output.preferences, { density: 'compact' });
  assert.ok(output.characters[0].legacy.legacyFields.milestones);
  assert.equal(validateV2State(output).ok, true);
});

test('partial, duplicate and missing-id records are preserved safely', async () => {
  const output = migrateV1ToV2(await fixture('partial-v1.json'), { now: new Date('2026-07-18T10:00:00.000Z') });
  assert.equal(output.characters.length, 2);
  assert.match(output.characters[0].id, /^character-/);
  assert.equal(output.goals.length, 1);
  assert.equal(output.activities.filter(x => x.kind === 'session').length, 1);
  const duplicateInput = { version: 1, characters: [{ id: 'c', name: 'C', realm: 'R', goals: [], sessions: [{ id: 'same', date: '2026-01-01', minutes: 1 }, { id: 'same', date: '2026-01-01', minutes: 1 }], ledger: [], snapshots: [] }] };
  const duplicateOutput = migrateV1ToV2(duplicateInput);
  assert.equal(duplicateOutput.activities.length, 2);
  assert.equal(duplicateOutput.activities[0].id, 'same');
  assert.equal(duplicateOutput.activities[1].id, 'same');
});

test('migration output is idempotent and preserves ids and timestamps', async () => {
  const input = await fixture('realistic-v1.json');
  const now = new Date('2026-07-18T10:00:00.000Z');
  const one = migrateV1ToV2(input, { now });
  const two = migrateState(one, { now });
  assert.deepEqual(two, one);
  assert.equal(one.activities.find(x => x.id === 'session-existing').occurredAt, '2025-01-04T21:30:00+01:00');
  assert.equal(one.activities.find(x => x.id === 'ledger-existing').id, 'ledger-existing');
});

test('loading v1 creates v2 and an exact one-time recovery copy without changing v1', async () => {
  const raw = JSON.stringify(await fixture('realistic-v1.json'));
  const store = storage({ [V1_STORAGE_KEY]: raw });
  const result = loadPersistedState(store, { now: new Date('2026-07-18T10:00:00.000Z') });
  assert.equal(result.status, 'ready');
  assert.equal(store.dump()[V1_STORAGE_KEY], raw);
  assert.equal(store.dump()[V1_RECOVERY_KEY], raw);
  assert.ok(store.dump()[V2_STORAGE_KEY]);
  const firstRecovery = store.dump()[V1_RECOVERY_KEY];
  persistV2(store, result.state);
  assert.equal(store.dump()[V1_RECOVERY_KEY], firstRecovery);
});

test('valid v2 wins, while malformed and future data enter recovery without writes', async () => {
  const starter = createStarterState({ now: new Date('2026-07-18T10:00:00.000Z') });
  const validStore = storage({ [V1_STORAGE_KEY]: 'legacy', [V2_STORAGE_KEY]: JSON.stringify(starter) });
  assert.equal(loadPersistedState(validStore).source, 'v2');
  const malformedRaw = '{not json';
  const malformedStore = storage({ [V2_STORAGE_KEY]: malformedRaw });
  const malformed = loadPersistedState(malformedStore);
  assert.equal(malformed.status, 'recovery');
  assert.equal(malformedStore.dump()[V2_STORAGE_KEY], malformedRaw);
  assert.equal(malformedStore.dump()[V1_RECOVERY_KEY], undefined);
  const futureRaw = JSON.stringify(await fixture('future-v3.json'));
  const futureStore = storage({ [V2_STORAGE_KEY]: futureRaw });
  assert.equal(loadPersistedState(futureStore).status, 'recovery');
  assert.equal(futureStore.dump()[V2_STORAGE_KEY], futureRaw);
  persistV2(futureStore, starter, { overwriteInvalidV2: true });
  assert.equal(futureStore.dump()[V2_RECOVERY_KEY], futureRaw);
});

test('validation failure refuses writes', () => {
  const store = storage();
  assert.throws(() => persistV2(store, { schemaVersion: 2 }), /Refusing to save invalid/);
  assert.deepEqual(store.dump(), {});
  assert.equal(validateV2State({ schemaVersion: 2, goals: [{}] }).ok, false);
});

test('malformed legacy JSON enters recovery without starter writes', () => {
  const raw = '{broken legacy';
  const store = storage({ [V1_STORAGE_KEY]: raw });
  const result = loadPersistedState(store);
  assert.equal(result.status, 'recovery');
  assert.deepEqual(store.dump(), { [V1_STORAGE_KEY]: raw });
});

test('invalid nested v2 records are rejected for recovery', async () => {
  const raw = JSON.stringify(await fixture('malformed-nested-v2.json'));
  const store = storage({ [V2_STORAGE_KEY]: raw });
  const result = loadPersistedState(store);
  assert.equal(result.status, 'recovery');
  assert.equal(store.dump()[V2_STORAGE_KEY], raw);
});

test('gold totals include profit and time while balance-neutral transfers stay neutral', () => {
  const totals = calculateGoldTotals([
    { kind: 'gold', durationMinutes: 60, gold: { revenue: 1000, cost: 100, delta: 900, affectsBalance: false } },
    { kind: 'gold', durationMinutes: 30, gold: { revenue: 500, cost: 0, delta: 500, affectsBalance: false } }
  ]);
  assert.equal(totals.profit, 1400);
  assert.equal(totals.minutes, 90);
  assert.equal(totals.hourlyRate, 1400 / 90 * 60);
});

test('local date grouping does not use UTC day boundaries', () => {
  const late = new Date(2026, 6, 18, 23, 30, 0);
  const early = new Date(2026, 6, 19, 0, 30, 0);
  assert.equal(localDateKey(late), '2026-07-18');
  assert.equal(localDateKey(early), '2026-07-19');
  const groups = groupByLocalDate([{ occurredAt: late }, { occurredAt: early }]);
  assert.equal(Object.keys(groups).length, 2);
});
