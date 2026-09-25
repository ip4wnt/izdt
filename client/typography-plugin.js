import {Plugin} from 'prosemirror-state';
import {Mapping} from 'prosemirror-transform';
import {NBSP, nbspIndices, signature} from './typography.js';

/**
 * Текст блока и позиции обычных пробелов в документе.
 * Вложенные атомы (картинки, переносы) занимают одну позицию и кодируются символом-заглушкой.
 */
function blockText(node) {
  let text = '';
  const spots = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      for (let i = 0; i < child.text.length; i++) if (child.text[i] === ' ') spots.push({index:text.length + i, pos:offset + i, marks:child.marks});
      text += child.text;
    } else text += '\uFFFC';
  });
  return {text, spots};
}
/**
 * Проверяет один абзац. Если его текст совпадает с ранее проверенным (подпись data-typo),
 * ничего не делает. Иначе меняет нужные пробелы на неразрывные и записывает новую подпись.
 * Возвращает true, если транзакция получила изменения.
 */
export function retypeBlock(tr, node, pos, schema) {
  const {text, spots} = blockText(node);
  if (node.attrs.typo === signature(text)) return false;
  const wanted = new Set(nbspIndices(text));
  const chars = text.split('');
  for (const spot of spots) if (wanted.has(spot.index)) {
    chars[spot.index] = NBSP;
    tr.replaceWith(pos + 1 + spot.pos, pos + 2 + spot.pos, schema.text(NBSP, spot.marks));
  }
  tr.setNodeMarkup(pos, undefined, {...node.attrs, typo:signature(chars.join(''))});
  return true;
}
const isTracked = node => node.isTextblock && 'typo' in node.attrs;
/** Плагин: после каждого изменения перепроверяет только затронутые абзацы. */
export const typography = new Plugin({
  appendTransaction(transactions, oldState, newState) {
    if (!transactions.some(tr => tr.docChanged)) return null;
    const maps = transactions.flatMap(tr => tr.mapping.maps);
    const blocks = new Map();
    maps.forEach((map, i) => map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      let from = newStart, to = newEnd;
      for (let j = i + 1; j < maps.length; j++) { from = maps[j].map(from, -1); to = maps[j].map(to, 1); }
      newState.doc.nodesBetween(Math.max(0, from - 1), Math.min(newState.doc.content.size, to + 1), (node, pos) => {
        if (node.isTextblock) { if (isTracked(node)) blocks.set(pos, node); return false; }
      });
    }));
    // Смена стиля, выравнивания или отступов текст не меняет — такие абзацы не трогаем, только те, где текст другой.
    const back = new Mapping(maps).invert();
    for (const [pos, node] of blocks) {
      const before = oldState.doc.nodeAt(back.map(pos, -1));
      if (before && before.isTextblock && before.attrs.id === node.attrs.id && blockText(before).text === blockText(node).text) blocks.delete(pos);
    }
    const tr = newState.tr;
    let changed = 0;
    for (const [pos, node] of blocks) if (retypeBlock(tr, node, pos, newState.schema)) changed++;
    return changed ? tr : null;
  }
});
/** Проверка всей книги по кнопке; null, если менять нечего. */
export function retypeAll(state) {
  const tr = state.tr;
  let changed = 0;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    if (isTracked(node) && retypeBlock(tr, node, pos, state.schema)) changed++;
    return false;
  });
  return changed ? tr.setMeta('typographyChanged', changed) : null;
}
