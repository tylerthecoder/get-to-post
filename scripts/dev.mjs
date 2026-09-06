import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/post.js';
import builder from '../api/builder.js';
import chunks from '../api/chunks.js';
const files = { '/sitemap.xml': ['sitemap.xml', 'application/xml'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/robots.txt': ['robots.txt', 'text/plain'], '/llms.txt': ['llms.txt', 'text/plain'] };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/builder' || path === '/api/builder') return builder(req, res);
  if (path === '/api/chunks') return chunks(req, res);
  if (path === '/api/post') return handler(req, res);
  const file = files[path];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', `${file[1]}; charset=utf-8`);
  res.end(await readFile(new URL(`../public/${file[0]}`, import.meta.url)));
}).listen(3000, '127.0.0.1', () => console.log('Local app: http://127.0.0.1:3000'));
