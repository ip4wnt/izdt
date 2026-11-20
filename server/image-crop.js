import zlib from 'node:zlib';

// Обрезка картинок без потери качества.
// PNG режется напрямую: пиксели переносятся байт в байт, служебные блоки файла (цветовой профиль iCCP,
// gAMA, cHRM, sRGB, pHYs, тексты, EXIF и прочие) сохраняются как были. Меняются только размеры и данные IDAT.
// JPEG, WebP и GIF один раз раскодируются и сохраняются в PNG: повторного сжатия с потерями нет,
// цветовой профиль и EXIF/XMP переносятся (через sharp, он подключается только для этих форматов).

const fail = (status, message) => Object.assign(new Error(message), {status});
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0;}
  return t;
})();
function crc32(...parts) {
  let c = 0xffffffff;
  for (const buf of parts) for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4), name = Buffer.from(type, 'latin1');
  head.writeUInt32BE(data.length, 0); name.copy(head, 4);
  tail.writeUInt32BE(crc32(name, data), 0);
  return Buffer.concat([head, data, tail]);
}

export function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw fail(415, 'Файл не является PNG.');
  const chunks = [];
  for (let i = 8; i + 12 <= buf.length;) {
    const length = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + length > buf.length) throw fail(422, 'PNG поврежден.');
    chunks.push({type, data: buf.subarray(i + 8, i + 8 + length)});
    i += 12 + length;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR') throw fail(422, 'PNG поврежден.');
  return chunks;
}

function header(data) {
  const h = {width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12]};
  if (!CHANNELS[h.color] || ![1, 2, 4, 8, 16].includes(h.depth) || data[10] || data[11]) throw fail(422, 'Неподдерживаемый вариант PNG.');
  h.bits = CHANNELS[h.color] * h.depth;        // бит на пиксель
  h.bpp = Math.max(1, h.bits >> 3);             // байт на пиксель для фильтров PNG
  return h;
}
const stride = (h, width) => Math.ceil(width * h.bits / 8);

function paeth(a, b, c) {const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;}
function unfilter(data, offset, h, width, rows, out) {
  const len = stride(h, width), bpp = h.bpp;
  let prev = new Uint8Array(len), at = offset;
  for (let y = 0; y < rows; y++) {
    const type = data[at++], row = data.subarray(at, at + len); at += len;
    if (row.length < len) throw fail(422, 'PNG поврежден.');
    const cur = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = row[i];
      cur[i] = type === 0 ? x : type === 1 ? x + a : type === 2 ? x + b : type === 3 ? x + ((a + b) >> 1) : type === 4 ? x + paeth(a, b, c) : (() => {throw fail(422, 'PNG поврежден.');})();
    }
    out.push(cur); prev = cur;
  }
  return at;
}
// Биты пикселя (x) строки row: для глубины меньше 8 бит пиксели упакованы по несколько в байт.
function getPixel(row, x, bits) {
  if (bits >= 8) return row.subarray(x * (bits >> 3), (x + 1) * (bits >> 3));
  const bit = x * bits, byte = row[bit >> 3], shift = 8 - bits - (bit & 7);
  return (byte >> shift) & ((1 << bits) - 1);
}
function putPixel(row, x, bits, value) {
  if (bits >= 8) {row.set(value, x * (bits >> 3)); return;}
  const bit = x * bits, shift = 8 - bits - (bit & 7);
  row[bit >> 3] |= value << shift;
}

// Все строки картинки (без фильтров), в том числе для чересстрочного PNG (Adam7).
function decodeRows(h, idat) {
  const data = zlib.inflateSync(idat), rows = [];
  if (!h.interlace) {unfilter(data, 0, h, h.width, h.height, rows); return rows;}
  const full = Array.from({length: h.height}, () => new Uint8Array(stride(h, h.width)));
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let at = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((h.width - x0) / dx), ph = Math.ceil((h.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const part = []; at = unfilter(data, at, h, pw, ph, part);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) putPixel(full[y0 + y * dy], x0 + x * dx, h.bits, getPixel(part[y], x, h.bits));
  }
  return full;
}

// Фильтры строк: для палитры и глубины меньше 8 бит без фильтра, иначе лучший по сумме модулей (как в libpng).
function encodeRows(h, rows, width) {
  const len = stride(h, width), bpp = h.bpp, simple = h.color === 3 || h.depth < 8;
  const out = Buffer.alloc(rows.length * (len + 1));
  let prev = new Uint8Array(len), at = 0;
  const candidate = new Uint8Array(len);
  for (const cur of rows) {
    let bestType = 0, best = null, bestScore = Infinity;
    for (const type of simple ? [0] : [0, 1, 2, 3, 4]) {
      let score = 0;
      for (let i = 0; i < len; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = cur[i];
        const v = (type === 0 ? x : type === 1 ? x - a : type === 2 ? x - b : type === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c)) & 0xff;
        candidate[i] = v; score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {bestScore = score; bestType = type; best = Uint8Array.from(candidate);}
    }
    out[at++] = bestType; out.set(best, at); at += len; prev = cur;
  }
  return zlib.deflateSync(out, {level: 9, memLevel: 9});
}

export function pngInfo(buf) {return header(readChunks(buf)[0].data);}

export function cropPNG(buf, {x, y, width, height}) {
  const chunks = readChunks(buf), h = header(chunks[0].data);
  if (chunks.some(c => c.type === 'acTL')) throw fail(422, 'Анимированные PNG обрезать нельзя.');
  if (!(x >= 0 && y >= 0 && width >= 1 && height >= 1 && x + width <= h.width && y + height <= h.height)) throw fail(400, 'Рамка обрезки выходит за пределы картинки.');
  const rows = decodeRows(h, Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  const len = stride(h, width), cropped = [];
  for (let r = y; r < y + height; r++) {
    const src = rows[r];
    if (h.bits >= 8) {const b = h.bits >> 3; cropped.push(src.slice(x * b, (x + width) * b)); continue;}
    const row = new Uint8Array(len);
    for (let c = 0; c < width; c++) putPixel(row, c, h.bits, getPixel(src, x + c, h.bits));
    cropped.push(row);
  }
  const ihdr = Buffer.from(chunks[0].data); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[12] = 0;
  const idat = encodeRows(h, cropped, width), parts = [SIGNATURE, chunk('IHDR', ihdr)];
  let wroteData = false;
  for (const c of chunks.slice(1)) {
    if (c.type === 'IDAT') {
      if (!wroteData) for (let i = 0; i < idat.length; i += 1 << 18) parts.push(chunk('IDAT', idat.subarray(i, i + (1 << 18))));
      wroteData = true; continue;
    }
    parts.push(chunk(c.type, c.data));   // служебные блоки и IEND — без изменений, на своих местах
  }
  return Buffer.concat(parts);
}

// Сборка PNG из исходных блоков: меняются только переданные (IHDR, IDAT, tRNS, sBIT, bKGD), остальные — как были и на своих местах.
function rebuild(chunks, {ihdr, idat, trns, sbit, bkgd} = {}) {
  const parts = [SIGNATURE, chunk('IHDR', ihdr || chunks[0].data)];
  let wroteData = false, wroteTRNS = false;
  const replaced = {tRNS: trns, sBIT: sbit, bKGD: bkgd};
  for (const c of chunks.slice(1)) {
    if (c.type === 'IDAT') {
      if (trns && !wroteTRNS) {parts.push(chunk('tRNS', trns)); wroteTRNS = true;}
      if (!idat) {parts.push(chunk('IDAT', c.data)); continue;}
      if (!wroteData) for (let i = 0; i < idat.length; i += 1 << 18) parts.push(chunk('IDAT', idat.subarray(i, i + (1 << 18))));
      wroteData = true; continue;
    }
    if (c.type in replaced && replaced[c.type] !== undefined) {
      if (c.type === 'tRNS') {if (trns && !wroteTRNS) {parts.push(chunk('tRNS', trns)); wroteTRNS = true;} continue;}
      if (replaced[c.type]) parts.push(chunk(c.type, replaced[c.type]));
      continue;
    }
    parts.push(chunk(c.type, c.data));
  }
  return Buffer.concat(parts);
}
const sample = (px, i, depth) => depth === 16 ? (px[i * 2] << 8) | px[i * 2 + 1] : px[i];

// Прозрачный цвет: пиксели, у которых каждый канал отличается от цвета точки (x, y) не больше чем на tolerance
// (в шкале 0–255), становятся прозрачными; остальные не меняются. tolerance 0 — ровно этот цвет.
// Палитра, а также серый и RGB с одним подходящим цветом — меняется только блок tRNS, IDAT остается байт в байт.
export function transparentPNG(buf, {x, y, tolerance = 0}) {
  const chunks = readChunks(buf), h = header(chunks[0].data);
  if (chunks.some(c => c.type === 'acTL')) throw fail(422, 'Анимированные PNG менять нельзя.');
  if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < h.width && y < h.height)) throw fail(400, 'Точка вне картинки.');
  if (!(Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 255)) throw fail(400, 'Неверный допуск.');
  const rows = decodeRows(h, Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  const oldTRNS = chunks.find(c => c.type === 'tRNS')?.data;
  const px = getPixel(rows[y], x, h.bits), max = (1 << h.depth) - 1;
  // Сравнение в шкале 0–255, как видит браузер: у 16 бит берется старший байт, серый 1–4 бита растягивается до 0–255.
  const tol = tolerance, low = h.bits < 8, to8 = h.depth === 16 ? v => v >> 8 : v => v;
  const near = (vals, target) => vals.every((v, i) => Math.abs(to8(v) - to8(target[i])) <= tol);
  if (h.color === 3) {
    const plte = chunks.find(c => c.type === 'PLTE')?.data; if (!plte) throw fail(422, 'PNG поврежден.');
    const index = px, alpha = Buffer.alloc(plte.length / 3, 255); if (oldTRNS) oldTRNS.copy(alpha, 0, 0, Math.min(oldTRNS.length, alpha.length));
    if (alpha[index] === 0) throw fail(409, 'Этот цвет уже прозрачный.');
    const target = [...plte.subarray(index * 3, index * 3 + 3)];
    let last = 0, changed = 0;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 0 && near([...plte.subarray(i * 3, i * 3 + 3)], target)) {alpha[i] = 0; changed++;}
    if (!changed) throw fail(409, 'Ничего не меняется.');
    for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) last = i;
    return rebuild(chunks, {trns: alpha.subarray(0, last + 1)});
  }
  if (h.color === 0 || h.color === 2) {
    const n = h.color === 0 ? 1 : 3, scale = low ? 255 / max : 1;
    const values = p => low ? [Math.round(p * scale)] : Array.from({length: n}, (_, i) => sample(p, i, h.depth));
    const raw = p => low ? [p] : Array.from({length: n}, (_, i) => sample(p, i, h.depth));
    const target = values(px), oldValue = oldTRNS && Array.from({length: n}, (_, i) => oldTRNS.readUInt16BE(i * 2));
    const isOld = p => !!oldValue && raw(p).every((v, i) => v === oldValue[i]);
    if (isOld(px)) throw fail(409, 'Этот цвет уже прозрачный.');
    // Какие разные цвета попадают в допуск: если один и своей прозрачности нет — хватит блока tRNS.
    const hits = new Set(); let changed = 0;
    for (let r = 0; r < h.height; r++) for (let c = 0; c < h.width; c++) {
      const p = getPixel(rows[r], c, h.bits);
      if (!isOld(p) && near(values(p), target)) {changed++; if (hits.size < 2) hits.add(raw(p).join(','));}
    }
    if (!changed) throw fail(409, 'Ничего не меняется.');
    if (!oldTRNS && hits.size === 1) {
      const value = Buffer.alloc(n * 2), only = [...hits][0].split(',').map(Number);
      only.forEach((v, i) => value.writeUInt16BE(v, i * 2));
      return rebuild(chunks, {trns: value});
    }
    // Несколько цветов: добавляем канал прозрачности (серый → серый+альфа, RGB → RGBA), значения цветов те же.
    const depth = Math.max(8, h.depth), out = [], bytes = depth >> 3;
    for (let r = 0; r < h.height; r++) {
      const row = new Uint8Array(h.width * (n + 1) * bytes);
      for (let c = 0; c < h.width; c++) {
        const p = getPixel(rows[r], c, h.bits), vals = values(p);
        const clear = isOld(p) || near(vals, target);
        const all = [...(low ? vals : raw(p)), clear ? 0 : (1 << depth) - 1];
        all.forEach((v, i) => {const o = (c * (n + 1) + i) * bytes; if (bytes === 2) {row[o] = v >> 8; row[o + 1] = v & 255;} else row[o] = v;});
      }
      out.push(row);
    }
    const ihdr = Buffer.from(chunks[0].data); ihdr[8] = depth; ihdr[9] = h.color === 0 ? 4 : 6; ihdr[12] = 0;
    const next = header(ihdr), sbitOld = chunks.find(c => c.type === 'sBIT')?.data;
    const bkgdOld = chunks.find(c => c.type === 'bKGD')?.data;
    return rebuild(chunks, {ihdr, idat: encodeRows(next, out, h.width), trns: oldTRNS ? null : undefined,
      sbit: sbitOld ? Buffer.concat([sbitOld, Buffer.from([depth])]) : undefined,
      bkgd: bkgdOld && low ? (() => {const b = Buffer.alloc(2); b.writeUInt16BE(Math.round(bkgdOld.readUInt16BE(0) * scale)); return b;})() : undefined});
  }
  // Серый+альфа и RGBA: меняется только альфа у подходящих пикселей.
  const n = h.color === 4 ? 1 : 3, bytes = h.depth >> 3, size = (n + 1) * bytes;
  const target = Array.from({length: n}, (_, i) => sample(px, i, h.depth));
  if (sample(px, n, h.depth) === 0) throw fail(409, 'Этот пиксель уже прозрачный.');
  let changed = 0;
  for (const row of rows) for (let c = 0; c < h.width; c++) {
    const p = row.subarray(c * size, (c + 1) * size);
    if (sample(p, n, h.depth) !== 0 && near(Array.from({length: n}, (_, i) => sample(p, i, h.depth)), target)) {p.fill(0, n * bytes, size); changed++;}
  }
  if (!changed) throw fail(409, 'Ничего не меняется.');
  const ihdr = Buffer.from(chunks[0].data); ihdr[12] = 0;
  return rebuild(chunks, {ihdr, idat: encodeRows(h, rows, h.width)});
}

export async function transparentImage(buf, point) {
  const isPNG = buf.subarray(0, 8).equals(SIGNATURE);
  if (isPNG && pngOrientation(readChunks(buf)) === 1) return transparentPNG(buf, point);
  let sharp;
  try {sharp = (await import('sharp')).default;}
  catch {throw fail(501, 'Для JPEG, WebP и GIF на сервере нужен модуль sharp (npm install sharp).');}
  const meta = await sharp(buf, {pages: 1}).metadata();
  if ((meta.pages || 1) > 1) throw fail(422, 'Анимированные картинки менять нельзя.');
  // Цвета читаются без перевода в sRGB (профиль сохраняется), маска прозрачности добавляется к тем же пикселям.
  const {data, info} = await sharp(buf).rotate().keepIccProfile().ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const {x, y, tolerance = 0} = point, ch = info.channels, n = ch - 1;
  if (!(Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 255)) throw fail(400, 'Неверный допуск.');
  if (!(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < info.width && y < info.height)) throw fail(400, 'Точка вне картинки.');
  const at = (y * info.width + x) * ch, target = data.subarray(at, at + n), alpha = Buffer.alloc(info.width * info.height);
  if (data[at + n] === 0) throw fail(409, 'Этот пиксель уже прозрачный.');
  let changed = 0;
  for (let p = 0, i = 0; p < alpha.length; p++, i += ch) {
    let same = data[i + n] !== 0; for (let k = 0; same && k < n; k++) if (Math.abs(data[i + k] - target[k]) > tolerance) same = false;
    alpha[p] = same ? 0 : data[i + n]; if (same) changed++;
  }
  if (!changed) throw fail(409, 'Ничего не меняется.');
  const png = {compressionLevel: 9, adaptiveFiltering: true}, rawAlpha = {raw: {width: info.width, height: info.height, channels: 1}};
  // Без своей прозрачности (обычный JPEG): канал альфа просто добавляется к тем же цветам.
  if (!meta.hasAlpha) return sharp(buf).rotate().joinChannel(alpha, rawAlpha).keepMetadata().png(png).toBuffer();
  // Со своей прозрачностью: маска 0/255 умножается на имеющуюся альфу (dest-in), цвета остаются.
  const mask = Buffer.alloc(info.width * info.height * 4, 255);
  for (let p = 0; p < alpha.length; p++) if (alpha[p] === 0 && data[p * ch + n] !== 0) mask[p * 4 + 3] = 0;
  return sharp(buf).rotate().composite([{input: mask, raw: {width: info.width, height: info.height, channels: 4}, blend: 'dest-in'}])
    .keepMetadata().png(png).toBuffer();
}

// EXIF-поворот в PNG (блок eXIf): браузер показывает картинку повернутой, координаты рамки — по повернутой.
function pngOrientation(chunks) {
  const exif = chunks.find(c => c.type === 'eXIf')?.data;
  if (!exif || exif.length < 14) return 1;
  const le = exif.toString('latin1', 0, 2) === 'II', u16 = o => le ? exif.readUInt16LE(o) : exif.readUInt16BE(o), u32 = o => le ? exif.readUInt32LE(o) : exif.readUInt32BE(o);
  try {const ifd = u32(4), n = u16(ifd); for (let i = 0; i < n; i++) {const e = ifd + 2 + i * 12; if (u16(e) === 0x112) return u16(e + 8);}} catch {}
  return 1;
}

export async function cropImage(buf, rect) {
  const isPNG = buf.subarray(0, 8).equals(SIGNATURE);
  if (isPNG && pngOrientation(readChunks(buf)) === 1) return cropPNG(buf, rect);
  let sharp;
  try {sharp = (await import('sharp')).default;}
  catch {throw fail(501, 'Для обрезки JPEG, WebP и GIF на сервере нужен модуль sharp (npm install sharp).');}
  const meta = await sharp(buf, {pages: 1}).metadata();
  if ((meta.pages || 1) > 1) throw fail(422, 'Анимированные картинки обрезать нельзя.');
  // rotate() — по EXIF, как показывает браузер; затем вырезаем и сохраняем в PNG со всеми метаданными (профиль, EXIF, XMP).
  const turned = (meta.orientation || 1) >= 5, w = turned ? meta.height : meta.width, h = turned ? meta.width : meta.height;
  if (!(rect.x + rect.width <= w && rect.y + rect.height <= h)) throw fail(400, 'Рамка обрезки выходит за пределы картинки.');
  return sharp(buf).rotate().extract({left: rect.x, top: rect.y, width: rect.width, height: rect.height})
    .keepMetadata().png({compressionLevel: 9, adaptiveFiltering: true}).toBuffer();
}
