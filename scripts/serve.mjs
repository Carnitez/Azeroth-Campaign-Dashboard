import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import './build.mjs';

const port = Number(process.env.PORT || 4173);
const file = resolve('dist/index.html');

createServer(async (request, response) => {
  if (request.url !== '/' && request.url !== '/index.html') {
    response.writeHead(404).end('Not found');
    return;
  }
  const html = await readFile(file);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}).listen(port, '127.0.0.1', () => {
  console.log(`Azeroth Campaign Dashboard: http://127.0.0.1:${port}`);
});
