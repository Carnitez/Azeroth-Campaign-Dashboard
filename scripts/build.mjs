import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const [baseCss, dashboard, core, schedule, recommendations, activities, sessions, selectors] = await Promise.all([
  readFile(resolve(root, 'src/base.css'), 'utf8'),
  readFile(resolve(root, 'src/dashboard.html'), 'utf8'),
  readFile(resolve(root, 'src/core.mjs'), 'utf8'),
  readFile(resolve(root, 'src/schedule-engine.mjs'), 'utf8'),
  readFile(resolve(root, 'src/recommendation-engine.mjs'), 'utf8'),
  readFile(resolve(root, 'src/activity-engine.mjs'), 'utf8'),
  readFile(resolve(root, 'src/session-engine.mjs'), 'utf8'),
  readFile(resolve(root, 'src/selectors.mjs'), 'utf8'),
]);

// Every icon name referenced anywhere via data-lucide (including dynamic/ternary
// branches in dashboard.html) or via an `icon:` field surfaced through the command
// palette catalog in activity-engine.mjs. There is no static analysis that can find
// these automatically across template-literal expressions and data objects, so this
// list is maintained by hand — add a name here whenever a new data-lucide value is
// introduced anywhere in src/.
const ICON_NAMES = [
  'arrow-right', 'book-open', 'calendar-clock', 'calendar-cog', 'calendar-days', 'calendar-plus',
  'calendar-range', 'calendar-x', 'chart-no-axes-combined', 'check', 'chevron-down', 'chevron-up',
  'circle', 'circle-check', 'circle-check-big', 'circle-dot', 'circle-dot-dashed', 'circle-play',
  'circle-plus', 'circle-slash', 'clock-3', 'coins', 'copy', 'download', 'ellipsis', 'flag', 'gem',
  'history', 'house', 'keyboard', 'layout-dashboard', 'list-checks', 'list-plus', 'lock-keyhole',
  'lock-keyhole-open', 'map', 'map-pin', 'notebook-pen', 'panel-left-close', 'pause', 'pencil',
  'play', 'plus', 'refresh-cw', 'rotate-ccw', 'save', 'search', 'settings', 'skip-forward',
  'sparkles', 'target', 'timer', 'trash-2', 'trending-up', 'upload', 'user-plus', 'user-round',
  'users', 'x'
];

function attrsToString(attrs) {
  return Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ');
}

function iconNodeToSymbol(name, [, attrs, children]) {
  const inner = children.map(([tag, childAttrs]) => `<${tag} ${attrsToString(childAttrs)}/>`).join('');
  return `<symbol id="lucide-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`;
}

const iconModules = await Promise.all(ICON_NAMES.map(name => import(`lucide/dist/esm/icons/${name}.js`)));
const sprite = `<svg id="lucide-sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${
  iconModules.map((module, index) => iconNodeToSymbol(ICON_NAMES[index], module.default)).join('')
}</svg>`;

const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Track World of Warcraft characters, collection milestones, play sessions, goals, and gold-making experiments.">
  <meta name="theme-color" content="#0c0f0d">
  <title>Azeroth Campaign Dashboard</title>
  <style>
${baseCss}
html, body { margin: 0; min-height: 100%; }
body { box-sizing: border-box; min-width: 320px; background: #0c0f0d; color: var(--foreground); }
  </style>
</head>
<body>
${sprite}
<script type="module">
${core}
</script>
<script type="module">
${schedule}
</script>
<script type="module">
${recommendations}
</script>
<script type="module">
${activities}
</script>
<script type="module">
${sessions}
</script>
<script type="module">
${selectors}
</script>
${dashboard}
</body>
</html>
`;

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), document, 'utf8');
console.log('Built dist/index.html');
