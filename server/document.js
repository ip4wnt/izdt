import sanitize from 'sanitize-html';
import {parseHTML} from 'linkedom';
import {randomUUID} from 'node:crypto';
import {ID_PATTERN, makeTOC, sectionFor} from '../shared/model.js';

const rem = [/^(?:\d{1,2}(?:\.\d{1,4})?)rem$/];
export function parseFragment(html) {
  return parseHTML(`<html><body><article>${html}</article></body></html>`).document.querySelector('article');
}
export function normalize(html) {
  const clean = sanitize(html, {
    allowedTags: ['div','section','header','h1','h2','h3','p','span','em','i','strong','b','u','s','br','hr','img','figure','figcaption','blockquote','ul','ol','li','a'],
    allowedAttributes: {
      '*':['id','class','style','data-style','data-typo'],
      img:['src','alt','width','height','data-align'], a:['href','title']
    },
    allowedClasses: {'*':['opening','frontispiece','opening-titles','paragraph','small','signature','divider-short','divider-long','wrap-left','wrap-right','wrap-block','wrap-inline','book-image','image-figure','figure-image','image-overlay']},
    allowedStyles: {'*':{
      'font-size':rem, 'line-height':[/^\d(?:\.\d{1,4})?$/, ...rem],
      'text-indent':rem, 'font-family':[/^["']?(?:TT Marxiana|Old Standard TT|Akzidenz-Grotesk Pro|Roboto Condensed|Georgia|Arial|serif|sans-serif)["']?$/],
      'text-align':[/^(left|right|center|justify)$/], 'font-style':[/^(normal|italic)$/],
      'font-weight':[/^(normal|bold|400|700)$/], 'width':[/^(?:[1-9]\d?(?:\.\d{1,2})?|100)%$/],
      'margin-left':[/^(?:\d{1,2}|100)%$/], 'margin-top':[/^(?:\d{1,2}|[12]\d{2}|300)%$/]
    }},
    allowedSchemes:['https','http','mailto'],
    transformTags: {
      img: (tagName, attribs) => {
        if (!/^\/books\/bees\/img\/[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp|gif)$/.test(attribs.src || '')) delete attribs.src;
        return {tagName, attribs};
      },
      a: (tagName, attribs) => ({tagName, attribs:{...attribs, href:/^(https?:|mailto:|#[\w-]+$)/.test(attribs.href || '') ? attribs.href : '#'}})
    }
  });
  const root = parseFragment(clean);
  const seen = new Set();
  for (const el of root.querySelectorAll('[id],h1,h2,h3,p,li,blockquote,[data-style="paragraph"]')) {
    if (!ID_PATTERN.test(el.id) || seen.has(el.id)) el.id = `b-${randomUUID()}`;
    seen.add(el.id);
  }
  return {html:root.innerHTML, root};
}
export function resolveNote(root, note) {
  const block = root.querySelector(`[id="${note.blockId}"]`);
  if (!block) return {...note, orphan:true};
  // Неразрывные и обычные пробелы считаются равными: типографика редактора не должна терять заметки.
  const plain = s => s.replace(/\u00A0/g, ' ');
  const text = plain(block.textContent), quote = plain(note.quote);
  let start = note.start;
  if (text.slice(start, start + quote.length) !== quote) {
    const at = text.indexOf(quote);
    if (at < 0 || text.indexOf(quote, at + 1) >= 0) return {...note, orphan:true};
    start = at;
  }
  return {...note, start, end:start + note.quote.length, ...sectionFor(root, note.blockId), orphan:false};
}
export function annotate(html, notes) {
  const root = parseFragment(html);
  const order = new Map([...root.querySelectorAll('[id]')].map((el,index)=>[el.id,index]));
  const resolved = notes.map(n => resolveNote(root,n)).sort((a,b)=>
    (order.get(a.blockId)??Number.MAX_SAFE_INTEGER)-(order.get(b.blockId)??Number.MAX_SAFE_INTEGER)||a.start-b.start);
  const groups = new Map();
  for (const n of resolved.filter(n=>!n.orphan)) groups.set(n.blockId,[...(groups.get(n.blockId)||[]),n]);
  for (const [id, group] of groups) {
    const block = root.querySelector(`[id="${id}"]`);
    const nodes = [];
    const walk = n => { for (const child of [...n.childNodes]) { if (child.nodeType === 3) nodes.push(child); else walk(child); } };
    walk(block);
    let offset = 0;
    for (const node of nodes) {
      const text = node.textContent, from = offset, to = from + text.length;
      offset = to;
      const cuts = new Set([0,text.length]);
      for (const note of group) if (note.start < to && note.end > from) {
        cuts.add(Math.max(0,note.start-from)); cuts.add(Math.min(text.length,note.end-from));
      }
      const points = [...cuts].sort((a,b)=>a-b);
      if (points.length === 2 && !group.some(n=>n.start<to&&n.end>from)) continue;
      for (let i=0;i<points.length-1;i++) {
        const a=points[i], b=points[i+1], active=group.filter(n=>n.start<from+b&&n.end>from+a);
        const child = root.ownerDocument.createTextNode(text.slice(a,b));
        if (active.length) {
          const mark=root.ownerDocument.createElement('mark');
          mark.setAttribute('data-notes',active.map(n=>n.id).join(' ')); mark.appendChild(child); node.before(mark);
        } else node.before(child);
      }
      node.remove();
    }
  }
  return {html:root.innerHTML, notes:resolved};
}
export {makeTOC};
