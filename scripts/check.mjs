import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = await readFile(resolve('dist/index.html'), 'utf8');
const failures = [];

if (!html.includes('id="azeroth-command-center"')) failures.push('Dashboard root is missing.');
if (html.includes('<iframe')) failures.push('Unexpected iframe wrapper found.');
if (!html.includes('localStorage')) failures.push('Local persistence code is missing.');
if (!html.includes('acc-add-character')) failures.push('Multi-character controls are missing.');
if (!html.includes('acc-toast-region')) failures.push('Save and deletion feedback is missing.');
if (!html.includes('acc-delete-character-dialog')) failures.push('Character deletion confirmation is missing.');
if (/\b(?:alert|confirm)\s*\(/.test(html)) failures.push('Native alert or confirm prompts found.');
if (!html.includes('acc-sidebar')) failures.push('Application sidebar is missing.');
if (!html.includes('classThemes')) failures.push('Character class theme configuration is missing.');
if (!html.includes("'night-elf'")) failures.push('Night Elf theme influence is missing.');

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)].map(match => ({ attrs: match[1], source: match[2] }));
for (const [index, script] of inlineScripts.entries()) {
  if (/\btype=["']module["']/i.test(script.attrs)) continue;
  try {
    new Function(script.source);
  } catch (error) {
    failures.push(`Inline script ${index + 1} has invalid JavaScript: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checks passed: ${inlineScripts.length} inline scripts found; persistence and multi-character controls present.`);
}
