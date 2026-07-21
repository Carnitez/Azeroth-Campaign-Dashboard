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
<script id="lucide-library" src="https://unpkg.com/lucide@0.468.0/dist/umd/lucide.min.js"></script>
<script>
document.getElementById('lucide-library')?.addEventListener('load', () => {
  globalThis.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
}, { once: true });
</script>
</body>
</html>
`;

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), document, 'utf8');
console.log('Built dist/index.html');
