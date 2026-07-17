import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = await readFile(resolve('dist/index.html'), 'utf8');
const failures = [];

if (!html.includes('id="azeroth-command-center"')) failures.push('Dashboard root is missing.');
if (html.includes('<iframe')) failures.push('Unexpected iframe wrapper found.');
if (!html.includes('localStorage')) failures.push('Local persistence code is missing.');
if (!html.includes('acc-add-character')) failures.push('Multi-character controls are missing.');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
for (const [index, source] of inlineScripts.entries()) {
  try {
    new Function(source);
  } catch (error) {
    failures.push(`Inline script ${index + 1} has invalid JavaScript: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checks passed: ${inlineScripts.length} inline scripts parsed; persistence and multi-character controls present.`);
}
