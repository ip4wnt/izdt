import {open, stat} from 'node:fs/promises';
import path from 'node:path';

// Размеры картинок по заголовку файла (PNG, JPEG, GIF, WebP). Нужны, чтобы читалка и редактор
// знали пропорции <img> до загрузки файла: иначе при пересоздании картинок текст скачет.
const cache = new Map();

export function parseImageSize(buf) {
  if (buf.length >= 24 && buf.toString('latin1', 1, 4) === 'PNG') return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)};
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') return {width: buf.readUInt16LE(6), height: buf.readUInt16LE(8)};
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return {width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff};
    if (chunk === 'VP8L') {const b = buf.readUInt32LE(21); return {width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1};}
    if (chunk === 'VP8X') return {width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1};
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {i++; continue;}
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {i += 2; continue;}
      const size = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return {height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7)};
      i += 2 + size;
    }
  }
  return null;
}

export async function imageSize(file) {
  try {
    const {mtimeMs} = await stat(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.size;
    const handle = await open(file);
    try {
      const buf = Buffer.alloc(65536);
      const {bytesRead} = await handle.read(buf, 0, buf.length, 0);
      const size = parseImageSize(buf.subarray(0, bytesRead));
      cache.set(file, {mtimeMs, size});
      return size;
    } finally {await handle.close();}
  } catch {return null;}
}

// Проставляет width/height картинкам книги, у которых их ещё нет (root — разобранный DOM книги).
export async function fillImageSizes(root, bookDir) {
  let changed = false;
  for (const img of root.querySelectorAll('img[src^="/books/bees/img/"]')) {
    if (img.getAttribute('width') && img.getAttribute('height')) continue;
    const name = path.basename(img.getAttribute('src'));
    const size = await imageSize(path.join(bookDir, 'img', name));
    if (!size || !size.width || !size.height) continue;
    img.setAttribute('width', String(size.width)); img.setAttribute('height', String(size.height)); changed = true;
  }
  return changed;
}
