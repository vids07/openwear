import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm' };

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const target = join(root, relative);
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
  response.setHeader('Accept-Ranges', 'bytes');
  // Browsers (Safari especially) need byte-range responses to play video.
  const { size } = statSync(target);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(target, { start, end }).pipe(response);
    return;
  }
  response.setHeader('Content-Length', size);
  createReadStream(target).pipe(response);
}).listen(5173, '127.0.0.1', () => console.log('Openwear running at http://127.0.0.1:5173'));
