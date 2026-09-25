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
