/** File format v1. Stable IDs survive text, format and TOC edits. */
export const BOOK_ID = 'bees';
export const MAX_HTML = 2 * 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
export const READER_PATTERN = /^[0-9a-f-]{36}$/;
export const escapeHTML = (text = '') => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function makeTOC(root, overrides = {}) {
  let part = '';
  return [...root.querySelectorAll('h1,h2,h3,[data-style="paragraph"]')].flatMap(el => {
    if (el.tagName === 'H1') { part = el.textContent.trim(); return []; }
    const level = el.tagName === 'H2' ? 1 : el.tagName === 'H3' ? 2 : 3;
    const autoTitle = (level === 1 ? `${part} ` : '') + el.textContent.trim().replace(/^\d+\.\s*/, '');
    const override = overrides[el.id] || {};
    return [{id:el.id, level, autoTitle, title:override.title ?? autoTitle, hidden:!!override.hidden, manual:Object.keys(override).length > 0}];
  });
}
export function sectionFor(root, blockId) {
  let part = '', chapter = '', partNumber = '';
  for (const el of root.querySelectorAll('[id]')) {
    if (el.tagName === 'H1') partNumber = el.textContent.trim();
    if (el.tagName === 'H2') part = `${partNumber} ${el.textContent.trim()}`.trim();
    if (el.tagName === 'H3') chapter = el.textContent.trim();
    if (el.id === blockId) break;
  }
  return {part, chapter};
}

// Именованные стили книги: базовые значения повторяют style.css, поверх них лежат правки редактора из styles.json.
export const STYLE_KEYS = ['p','h1','h2','h3','small','paragraph'];
export const STYLE_FAMILIES = ['TT Marxiana','Akzidenz-Grotesk Pro','Georgia','Arial'];
export const STYLE_ALIGNS = ['left','center','justify','right'];
export const BASE_STYLES = {
  p: {family:'TT Marxiana', size:2.05, leading:2.1525, indent:3.075, align:'left'},
  h1: {family:'TT Marxiana', size:3.3825, leading:5.1752, indent:0, align:'center'},
  h2: {family:'TT Marxiana', size:2.46, leading:3.7638, indent:0, align:'center'},
  h3: {family:'TT Marxiana', size:2.7675, leading:4.2343, indent:0, align:'center'},
  small: {family:'TT Marxiana', size:1.7425, leading:1.7425, indent:3.075, align:'left'},
  paragraph: {family:'TT Marxiana', size:2.05, leading:2.1525, indent:3.075, align:'left'}
};
const STYLE_RANGES = {size:[.5,8], leading:[.5,16], indent:[0,10]};
/** Отбрасывает всё лишнее; возвращает только допустимые правки. */
export function sanitizeStyles(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of STYLE_KEYS) {
    const raw = input[key];
    if (!raw || typeof raw !== 'object') continue;
    const clean = {};
    if (STYLE_FAMILIES.includes(raw.family)) clean.family = raw.family;
    if (STYLE_ALIGNS.includes(raw.align)) clean.align = raw.align;
    for (const [prop,[min,max]] of Object.entries(STYLE_RANGES)) {
      const value = Number(raw[prop]);
      if (raw[prop] !== undefined && raw[prop] !== null && Number.isFinite(value) && value >= min && value <= max) clean[prop] = Number(value.toFixed(4));
    }
    for (const prop of Object.keys(clean)) if (clean[prop] === BASE_STYLES[key][prop]) delete clean[prop]; // хранятся только отличия от базы
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}
export const mergeStyles = overrides => Object.fromEntries(STYLE_KEYS.map(key => [key, {...BASE_STYLES[key], ...(overrides?.[key] || {})}]));
const FAMILY_CSS = {'TT Marxiana':'var(--serif)','Akzidenz-Grotesk Pro':'var(--sans)',Georgia:'Georgia,serif',Arial:'Arial,sans-serif'};
const SELECTORS = {
  p:'.book p:not(.small):not(.signature):not([data-style=paragraph])', small:'.book p.small:not(.signature)', paragraph:'.book p[data-style=paragraph]',
  h1:'.book h1', h2:'.book h2', h3:'.book h3'
};
/** CSS только для изменённых стилей; подписи и прямое форматирование абзацев остаются сильнее. */
export function stylesCSS(overrides) {
  const merged = mergeStyles(overrides);
  return STYLE_KEYS.filter(key => overrides?.[key] && Object.keys(overrides[key]).length).map(key => {
    const s = merged[key];
    return `${SELECTORS[key]}{font-family:${FAMILY_CSS[s.family] || 'var(--serif)'};font-size:${s.size}rem;line-height:${s.leading}rem;text-indent:${s.indent}rem;text-align:${s.align}}`;
  }).join('\n');
}
