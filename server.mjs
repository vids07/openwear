import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif' };

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const target = join(root, relative);
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
  createReadStream(target).pipe(response);
}).listen(5173, '127.0.0.1', () => console.log('Openwear running at http://127.0.0.1:5173'));
