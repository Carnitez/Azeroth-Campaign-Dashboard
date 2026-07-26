/*
 * Built-in World of Warcraft activity templates and packs.
 *
 * This module is data plus two pure helpers. Templates are never persisted as a
 * catalog: adding one runs it through the Activities Engine's createPlannedActivity,
 * so a template-created activity is indistinguishable from a hand-made one and is
 * fully editable afterwards.
 *
 * Pack playstyles line up one-to-one with the interest chips in the setup wizard, so
 * seeding from chosen interests is a direct lookup.
 */

const Core = globalThis.AzerothCore ?? await import('./core.mjs');
const Activities = globalThis.AzerothActivities ?? await import('./activity-engine.mjs');

// Weekly content resets Tuesday in the Americas and Wednesday in Europe/Asia.
const RESET_WEEKDAY_BY_REGION = Object.freeze({ US: 2, EU: 3, KR: 3, TW: 3 });
const DEFAULT_RESET_WEEKDAY = 3;

export function resetWeekdayForRegion(region) {
  return RESET_WEEKDAY_BY_REGION[String(region || '').toUpperCase()] ?? DEFAULT_RESET_WEEKDAY;
}

const template = (id, title, category, cadence, estimatedMinutes, description = '') =>
  Object.freeze({ id, title, category, cadence, estimatedMinutes, description });

export const ACTIVITY_TEMPLATES = Object.freeze([
  // Universal upkeep.
  template('world-quest-sweep', 'World quest sweep', 'Campaign', 'daily', 20, 'Clear the worthwhile world quests up for today.'),
  template('daily-dungeon', 'Daily dungeon or scenario', 'Campaign', 'daily', 25, 'One quick run for currency and loot.'),
  template('vault-progress', 'Fill your Great Vault slots', 'Weekly', 'weekly', 90, 'Whatever combination of content unlocks your rewards.'),
  template('weekly-world-boss', 'Weekly world boss', 'Weekly', 'weekly', 15, 'One kill per week per character.'),
  template('weekly-event', 'This week’s bonus event', 'Events', 'weekly', 30, 'The rotating weekly event quest.'),
  template('weekly-cache', 'Weekly cache and spark quest', 'Weekly', 'weekly', 20, 'Currency and crafting-spark turn-ins.'),

  // Gold.
  template('auction-house', 'Auction house: post and collect', 'Gold', 'daily', 15, 'Collect mail, repost expired listings, scan for deals.'),
  template('gather-circuit', 'Gathering circuit', 'Gold', 'manual', 45, 'A herb or ore route while you listen to something.'),
  template('old-raid-gold', 'Old raid gold run', 'Gold', 'weekly', 40, 'Solo legacy raids for vendor trash and transmog.'),
  template('craft-and-sell', 'Craft and sell', 'Gold', 'weekly', 30, 'Turn reagents into listed goods.'),

  // Professions.
  template('profession-cooldowns', 'Profession cooldowns', 'Professions', 'daily', 10, 'Everything that recharges on a daily timer.'),
  template('profession-weekly', 'Weekly profession quest', 'Professions', 'weekly', 20, 'Knowledge points and profession currency.'),
  template('work-orders', 'Work orders: fill and place', 'Professions', 'daily', 10, 'Crafting orders in both directions.'),
  template('restock-reagents', 'Restock reagents', 'Professions', 'weekly', 20, 'Buy or farm what next week needs.'),

  // Mounts.
  template('raid-mount-runs', 'Old raid mount runs', 'Mounts', 'weekly', 45, 'The weekly-locked mount bosses.'),
  template('rare-circuit', 'Rare spawn circuit', 'Mounts', 'manual', 30, 'Mount-dropping rares on your route.'),
  template('dungeon-mount-farm', 'Dungeon mount farm', 'Mounts', 'manual', 30, 'Repeatable dungeon mount drops.'),
  template('mount-vendors', 'Mount vendor check', 'Mounts', 'weekly', 15, 'Reputation and currency mount vendors.'),

  // Pets.
  template('pet-dailies', 'Pet battle dailies', 'Pets', 'daily', 20, 'Daily pet battle quests and tamers.'),
  template('pet-weekly', 'Weekly pet battle quest', 'Pets', 'weekly', 15, 'The weekly pet battle turn-in.'),
  template('wild-pet-capture', 'Wild pet capture circuit', 'Pets', 'manual', 25, 'Fill gaps in the collection.'),
  template('pet-charm-vendors', 'Pet vendor check', 'Pets', 'weekly', 10, 'Spend charms before they pile up.'),

  // Transmog.
  template('transmog-raid-run', 'Old raid transmog run', 'Transmog', 'weekly', 40, 'Legacy raids for appearances.'),
  template('transmog-dungeon-farm', 'Dungeon transmog farm', 'Transmog', 'manual', 30, 'Repeatable dungeons for missing appearances.'),
  template('transmog-vendors', 'Appearance vendor check', 'Transmog', 'weekly', 15, 'Vendors selling unlearned appearances.'),

  // Achievements.
  template('achievement-focus', 'Finish one achievement', 'Achievements', 'manual', 45, 'Pick a single achievement and close it out.'),
  template('exploration-achievements', 'Exploration achievements', 'Achievements', 'manual', 30, 'Map, treasure, and zone completion.'),
  template('holiday-achievements', 'Holiday event achievements', 'Events', 'manual', 40, 'Seasonal event progress while it is up.'),

  // Reputation.
  template('rep-world-quests', 'Reputation world quests', 'Reputation', 'daily', 20, 'World quests for the factions you are pushing.'),
  template('rep-weekly', 'Weekly reputation quest', 'Reputation', 'weekly', 20, 'The big weekly reputation turn-in.'),
  template('renown-check', 'Renown and paragon check', 'Reputation', 'weekly', 10, 'Claim anything waiting to be collected.'),

  // Raiding.
  template('raid-night', 'Raid night', 'Weekly', 'weekly', 150, 'Your scheduled group raid.'),
  template('raid-prep', 'Raid prep: consumables and repairs', 'Weekly', 'weekly', 20, 'Flasks, food, enchants, gear check.'),

  // Mythic+.
  template('mplus-vault', 'Mythic+ runs for the vault', 'Weekly', 'weekly', 120, 'Enough keys to unlock your vault slots.'),
  template('mplus-key', 'Push your keystone', 'Weekly', 'manual', 40, 'One run at your current key level.'),

  // PvP.
  template('pvp-weekly', 'Weekly PvP quest', 'Weekly', 'weekly', 45, 'The weekly honor or conquest quest.'),
  template('pvp-rated', 'Rated PvP games', 'Weekly', 'manual', 45, 'Arena or rated battleground session.'),

  // Leveling.
  template('level-campaign', 'Continue the campaign', 'Campaign', 'manual', 45, 'The next chapter of the story questline.'),
  template('level-dungeons', 'Level through dungeons', 'Campaign', 'manual', 40, 'Queue and grind levels in groups.'),
  template('level-alt', 'Level an alt', 'Campaign', 'manual', 45, 'Move a second character forward.')
]);

const TEMPLATES_BY_ID = new Map(ACTIVITY_TEMPLATES.map(item => [item.id, item]));

export function templateById(id) {
  return TEMPLATES_BY_ID.get(id) ?? null;
}

const pack = (id, name, description, playstyle, templateIds) =>
  Object.freeze({ id, name, description, playstyle, templateIds: Object.freeze(templateIds) });

export const ACTIVITY_PACKS = Object.freeze([
  pack('daily-chores', 'Daily chores', 'The short list you clear most days.', null,
    ['world-quest-sweep', 'profession-cooldowns', 'auction-house', 'daily-dungeon']),
  pack('weekly-reset', 'Weekly reset', 'Everything that comes back each reset.', null,
    ['vault-progress', 'weekly-world-boss', 'weekly-event', 'weekly-cache']),
  pack('gold-farming', 'Gold farming', 'Ways to make gold on a schedule.', 'gold',
    ['auction-house', 'gather-circuit', 'old-raid-gold', 'craft-and-sell']),
  pack('professions', 'Professions', 'Keep crafting moving forward.', 'professions',
    ['profession-cooldowns', 'profession-weekly', 'work-orders', 'restock-reagents']),
  pack('mounts', 'Mount farming', 'Weekly locks and repeatable drops.', 'mounts',
    ['raid-mount-runs', 'rare-circuit', 'dungeon-mount-farm', 'mount-vendors']),
  pack('pets', 'Pet collecting', 'Battles, captures, and vendors.', 'pets',
    ['pet-dailies', 'pet-weekly', 'wild-pet-capture', 'pet-charm-vendors']),
  pack('transmog', 'Transmog hunting', 'Appearances from raids, dungeons, vendors.', 'transmog',
    ['transmog-raid-run', 'transmog-dungeon-farm', 'transmog-vendors']),
  pack('achievements', 'Achievement hunting', 'Close out the ones you keep almost finishing.', 'achievements',
    ['achievement-focus', 'exploration-achievements', 'holiday-achievements']),
  pack('reputation', 'Reputation grind', 'Steady faction progress.', 'reputation',
    ['rep-world-quests', 'rep-weekly', 'renown-check']),
  pack('raiding', 'Raiding', 'Your raid night and the prep around it.', 'raiding',
    ['raid-night', 'raid-prep', 'vault-progress']),
  pack('mythics', 'Mythic+', 'Keys and vault progress.', 'mythics',
    ['mplus-vault', 'mplus-key', 'vault-progress']),
  pack('pvp', 'PvP', 'Rated play and the weekly quest.', 'pvp',
    ['pvp-weekly', 'pvp-rated']),
  pack('leveling', 'Leveling', 'Move a character forward.', 'leveling',
    ['level-campaign', 'level-dungeons', 'level-alt'])
]);

export function packById(id) {
  return ACTIVITY_PACKS.find(item => item.id === id) ?? null;
}

export function templatesForPack(id) {
  return (packById(id)?.templateIds ?? []).map(templateById).filter(Boolean);
}

export function packsForPlaystyles(playstyles) {
  const wanted = new Set(Array.isArray(playstyles) ? playstyles : []);
  return ACTIVITY_PACKS.filter(item => item.playstyle === null || wanted.has(item.playstyle));
}

const CADENCE_TO_SCHEDULE = Object.freeze({
  daily: () => ({ type: 'daily' }),
  weekly: resetWeekday => ({ type: 'weekly', weekdays: [resetWeekday] }),
  manual: () => ({ type: 'manual' }),
  one_time: () => null
});

// Turns a template into the plain input object createPlannedActivity expects. Weekly
// templates anchor to the character's regional reset day.
export function templateToActivityInput(item, { characterId, region } = {}) {
  const scheduleFor = CADENCE_TO_SCHEDULE[item.cadence] ?? CADENCE_TO_SCHEDULE.manual;
  const schedule = scheduleFor(resetWeekdayForRegion(region));
  return {
    title: item.title,
    description: item.description,
    characterId,
    category: item.category,
    priority: 1,
    status: 'todo',
    estimatedMinutes: item.estimatedMinutes,
    repeatType: item.cadence === 'one_time' ? 'one_time' : item.cadence,
    tags: [],
    notes: '',
    ...(schedule ? { schedule } : {})
  };
}

const normalizedTitle = value => String(value ?? '').trim().toLowerCase();

/*
 * Adds templates to a character, skipping any whose title the character already has.
 * Pure: returns a new state plus what happened, so the caller controls persistence and
 * can offer undo by keeping the previous state.
 */
export function addTemplatesToState(state, templateIds, { characterId, now = new Date() } = {}) {
  const base = Core.clone(state);
  const targetId = characterId || base.activeCharacterId;
  const character = (base.characters || []).find(item => item.id === targetId) || null;
  const existing = new Set((base.activities || [])
    .filter(item => item.characterId === targetId && Activities.isPlannedActivity(item))
    .map(item => normalizedTitle(item.title)));
  const added = [];
  const skipped = [];
  for (const id of Array.isArray(templateIds) ? templateIds : []) {
    const item = templateById(id);
    if (!item) continue;
    if (existing.has(normalizedTitle(item.title))) { skipped.push(item); continue; }
    existing.add(normalizedTitle(item.title));
    const input = templateToActivityInput(item, { characterId: targetId, region: character?.region });
    added.push(Activities.createPlannedActivity(input, { id: Core.createId('activity-planned'), now }));
  }
  base.activities = [...(base.activities || []), ...added];
  return { state: base, added, skipped };
}

export const Templates = Object.freeze({
  ACTIVITY_TEMPLATES, ACTIVITY_PACKS, templateById, packById, templatesForPack,
  packsForPlaystyles, templateToActivityInput, addTemplatesToState, resetWeekdayForRegion
});

globalThis.AzerothTemplates = Templates;
