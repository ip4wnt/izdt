import {Schema, DOMParser, DOMSerializer} from 'prosemirror-model';

export const DEFAULTS = {
  p: {size:2.05, leading:2.1525, indent:3.075, align:'left'},
  h1: {size:3.3825, leading:5.1752, indent:0, align:'center'},
  h2: {size:2.46, leading:3.7638, indent:0, align:'center'},
  h3: {size:2.7675, leading:4.2343, indent:0, align:'center'},
  small: {size:1.7425, leading:1.7425, indent:3.075, align:'left'},
  paragraph: {size:2.05, leading:2.1525, indent:3.075, align:'left'}
};
const uid = () => `b-${crypto.randomUUID()}`;
const cssSize = value => /^\d+(?:\.\d+)?rem$/.test(value || '') ? value : null;
const font = value => (value || '').replace(/["']/g,'').trim() || null;
const attrs = {
  id:{default:null}, kind:{default:'p'}, align:{default:null},
  size:{default:null}, family:{default:null}, leading:{default:null},
  indent:{default:null}, signature:{default:false}
};
function blockAttrs(dom) {
  return {id:dom.id || null, kind:dom.dataset.style === 'paragraph' ? 'paragraph' : dom.classList.contains('small') ? 'small' : 'p',
    align:dom.style.textAlign || null, size:cssSize(dom.style.fontSize), family:font(dom.style.fontFamily),
    leading:dom.style.lineHeight || null, indent:cssSize(dom.style.textIndent), signature:dom.classList.contains('signature')};
}
function blockDOM(node) {
  const a=node.attrs, out={};
  if(a.id)out.id=a.id;
  const classes=[a.kind==='small'?'small':'',a.signature?'signature':''].filter(Boolean);
  if(classes.length)out.class=classes.join(' ');
  if(a.kind==='paragraph')out['data-style']='paragraph';
  const styles = [['text-align',a.align],['font-size',a.size],['font-family',a.family],['line-height',a.leading],['text-indent',a.indent]]
    .filter(([,v])=>v).map(([k,v])=>`${k}:${v}`);
  if(styles.length)out.style=styles.join(';');
  return out;
}
export function imageAttrs(dom) {
  const mode = dom.classList.contains('wrap-inline') ? 'inline' : dom.classList.contains('wrap-left') || dom.classList.contains('wrap-right') ? 'square' : 'block';
  const align = dom.classList.contains('wrap-right') || dom.dataset.align==='right' ? 'right' : dom.classList.contains('wrap-left') || dom.dataset.align==='left' ? 'left' : 'center';
  const src=dom.getAttribute('src')||'', at=src.indexOf('/books/bees/img/');
  if(at<0 || !/^\/books\/bees\/img\/[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp|gif)$/.test(src.slice(at)))return false;
  return {id:dom.id||null,src:src.slice(at),alt:dom.getAttribute('alt')||'Иллюстрация',mode,align,width:parseFloat(dom.style.width)||null};
}
const imageDefaults={id:{default:null},src:{},alt:{default:''},mode:{default:'block'},align:{default:'center'},width:{default:null}};
export function imageDOM(node) {
  const a=node.attrs, cover=node.type.name==='cover_image';
  const mode=a.mode==='square'?(a.align==='right'?'wrap-right':'wrap-left'):`wrap-${a.mode}`;
  return ['img',{...(a.id?{id:a.id}:{}),src:a.src,alt:a.alt,class:cover?'frontispiece':`book-image ${mode}`,
    'data-align':a.align,...(a.width?{style:`width:${a.width}%`}:{})}];
}
export const schema = new Schema({
  nodes: {
    doc:{content:'block+'},
    paragraph:{group:'block',content:'inline*',attrs,parseDOM:[{tag:'p',getAttrs:blockAttrs}],toDOM:n=>['p',blockDOM(n),0]},
    heading:{group:'block',content:'inline*',defining:true,attrs:{...attrs,level:{default:1}},
      parseDOM:[1,2,3].map(level=>({tag:`h${level}`,getAttrs:dom=>({...blockAttrs(dom),level})})),
      toDOM:n=>[`h${n.attrs.level}`,blockDOM(n),0]},
    opening:{group:'block',content:'cover_image? opening_titles',isolating:true,
      parseDOM:[{tag:'header.opening'}],toDOM:()=>['header',{class:'opening'},0]},
    opening_titles:{content:'block+',defining:true,parseDOM:[{tag:'.opening-titles'}],toDOM:()=>['div',{class:'opening-titles'},0]},
    cover_image:{group:'block',atom:true,draggable:true,attrs:imageDefaults,parseDOM:[{tag:'img.frontispiece',priority:80,getAttrs:imageAttrs}],toDOM:imageDOM},
    image:{inline:true,group:'inline',atom:true,draggable:true,attrs:imageDefaults,parseDOM:[{tag:'img',getAttrs:imageAttrs}],toDOM:imageDOM},
    rule:{group:'block',atom:true,attrs:{kind:{default:'short'},id:{default:null}},parseDOM:[{tag:'hr',getAttrs:d=>({kind:d.classList.contains('divider-long')?'long':'short',id:d.id||null})}],toDOM:n=>['hr',{class:`divider-${n.attrs.kind}`,...(n.attrs.id?{id:n.attrs.id}:{})}]},
    blockquote:{group:'block',content:'block+',defining:true,parseDOM:[{tag:'blockquote'}],toDOM:()=>['blockquote',0]},
    bullet_list:{group:'block',content:'list_item+',parseDOM:[{tag:'ul'}],toDOM:()=>['ul',0]},
    ordered_list:{group:'block',content:'list_item+',attrs:{order:{default:1}},parseDOM:[{tag:'ol',getAttrs:d=>({order:Number(d.getAttribute('start'))||1})}],toDOM:n=>['ol',{start:n.attrs.order},0]},
    list_item:{content:'paragraph block*',defining:true,parseDOM:[{tag:'li'}],toDOM:()=>['li',0]},
    text:{group:'inline'},
    hard_break:{inline:true,group:'inline',selectable:false,parseDOM:[{tag:'br'}],toDOM:()=>['br']}
  },
  marks:{
    strong:{parseDOM:[{tag:'strong'},{tag:'b'},{style:'font-weight',getAttrs:v=>/^(bold|[6-9]00)$/.test(v)?null:false}],toDOM:()=>['strong',0]},
    em:{parseDOM:[{tag:'em'},{tag:'i'},{style:'font-style=italic'}],toDOM:()=>['em',0]},
    underline:{parseDOM:[{tag:'u'},{style:'text-decoration',getAttrs:v=>v.includes('underline')?null:false}],toDOM:()=>['u',0]},
    strike:{parseDOM:[{tag:'s'},{tag:'strike'},{style:'text-decoration',getAttrs:v=>v.includes('line-through')?null:false}],toDOM:()=>['s',0]},
    text_style:{attrs:{size:{default:null},family:{default:null}},
      parseDOM:[{tag:'span[style]',getAttrs:d=>cssSize(d.style.fontSize)||font(d.style.fontFamily)?{size:cssSize(d.style.fontSize),family:font(d.style.fontFamily)}:false}],
      toDOM:m=>['span',{style:[m.attrs.size?`font-size:${m.attrs.size}`:'',m.attrs.family?`font-family:${m.attrs.family}`:''].filter(Boolean).join(';')},0]},
    paragraph_label:{attrs:{id:{default:null}},parseDOM:[{tag:'span[data-style=paragraph]',getAttrs:d=>({id:d.id||uid()})}],
      toDOM:m=>['span',{'data-style':'paragraph',id:m.attrs.id},0]},
    link:{attrs:{href:{},title:{default:null}},inclusive:false,
      parseDOM:[{tag:'a[href]',getAttrs:d=>/^(https?:|mailto:|#)/.test(d.getAttribute('href'))?{href:d.getAttribute('href'),title:d.getAttribute('title')}:false}],
      toDOM:m=>['a',m.attrs,0]}
  }
});
export const parseDocument = dom => DOMParser.fromSchema(schema).parse(dom);
export function serializeDocument(doc) {
  const container=document.createElement('div');
  container.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return container.innerHTML;
}
export function styleName(node) {return node.type.name==='heading'?`h${node.attrs.level}`:node.attrs.kind||'p';}
