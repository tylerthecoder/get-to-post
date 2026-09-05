import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/post.js';
const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/robots.txt': ['robots.txt', 'text/plain'], '/llms.txt': ['llms.txt', 'text/plain'] };
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/post') return handler(req, res);
  const file = files[path];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', `${file[1]}; charset=utf-8`);
  res.end(await readFile(new URL(`../public/${file[0]}`, import.meta.url)));
}).listen(3000, '127.0.0.1', () => console.log('Local app: http://127.0.0.1:3000'));
