import {EditorState, Plugin, TextSelection, NodeSelection} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {baseKeymap, toggleMark} from 'prosemirror-commands';
import {history, undo, redo, closeHistory} from 'prosemirror-history';
import {keymap} from 'prosemirror-keymap';
import {schema, parseDocument, serializeDocument, DEFAULTS, applyStyles, styleName, imageDOM} from './schema.js';
import {STYLE_KEYS, stylesCSS} from '../shared/model.js';
import {api, applyAssetURLs, notify, base, storage} from '../public/js/api.js';
import {makeTOC} from '../shared/model.js';
import {typography, retypeAll} from './typography-plugin.js';

const $=id=>document.getElementById(id);
const uid=()=>`b-${crypto.randomUUID()}`;
const imageTypes=new Set(['image','figure_image']);
const controlIds=['text-style','font-family','font-size','line-height','text-indent','text-align'];
const clampRound=(v,min,max)=>Math.round(Math.min(max,Math.max(min,v)));
/** Блок без плашки и подписи снова становится обычной картинкой с тем же обтеканием и шириной. Возвращает позицию картинки. */
function unwrapBare(tr,figurePos) {
  const node=tr.doc.nodeAt(figurePos);
  if(!node||node.type!==schema.nodes.figure||node.childCount!==1)return null;
  const image=node.firstChild, square=node.attrs.mode==='square';
  const inline=schema.nodes.image.create({...image.attrs,mode:square?'square':'block',
    align:square?(node.attrs.align==='right'?'right':'left'):image.attrs.align,width:image.attrs.width||100});
  tr.replaceWith(figurePos,figurePos+node.nodeSize,schema.nodes.paragraph.create({id:uid()},inline));
  return figurePos+1;
}
/** Пересчет плашки при смене обтекания: в «Сверху и снизу» проценты считаются от колонки, при обтекании — от самой картинки. */
function convertOverlay(o,toSquare,width,align) {
  const w=width||100, offset=align==='right'?100-w:align==='center'?(100-w)/2:0;
  if(toSquare){const size=clampRound(o.width/w*100,10,100);return {...o,width:size,x:clampRound((o.x-offset)/w*100,0,100-size),y:clampRound(o.y/w*100,0,300)};}
  const size=clampRound(o.width*w/100,10,100);return {...o,width:size,x:clampRound(offset+o.x*w/100,0,100-size),y:clampRound(o.y*w/100,0,300)};
}
/**
 * Порядок в картинках-блоках после любой правки (кнопки, удаление текста, отмена):
 * блок без плашки и подписи разворачивается в обычную картинку, ширина и положение блока повторяют картинку.
 */
const figures=new Plugin({
  appendTransaction(transactions,old,state) {
    if(!transactions.some(tr=>tr.docChanged))return null;
    const found=[];
    state.doc.descendants((node,pos)=>{if(node.type===schema.nodes.figure){found.push({node,pos});return false;}});
    if(!found.length)return null;
    const tr=state.tr;
    for(const {node,pos} of found.reverse()) {
      const image=node.firstChild;
      if(!image||image.type!==schema.nodes.figure_image)continue;
      if(node.childCount===1){unwrapBare(tr,pos);continue;}
      const square=node.attrs.mode==='square';
      const align=square&&image.attrs.align==='center'?'left':image.attrs.align, width=image.attrs.width||null;
      if(node.attrs.align!==align||node.attrs.width!==width)tr.setNodeMarkup(pos,undefined,{...node.attrs,align,width});
    }
    return tr.docChanged?tr:null;
  }
});
export function createEditor(state,book,panels) {
  let view=null, dirty=false, flight=null, timer=null, conflict=false, uploadCount=0, draftTimer=null;
  // Обрезанные картинки: старый адрес → новый файл. Отмена (Ctrl+Z) не возвращает удаленный файл.
  const replacedImages=new Map();let cropping=null;
  const replaced=new Plugin({
    appendTransaction(transactions,old,state){
      if(!replacedImages.size||!transactions.some(tr=>tr.docChanged))return null;
      const tr=state.tr;
      state.doc.descendants((node,pos)=>{
        const next=imageTypes.has(node.type.name)&&replacedImages.get(node.attrs.src);
        if(next)tr.setNodeMarkup(pos,undefined,{...node.attrs,...next});
      });
      return tr.docChanged?tr.setMeta('addToHistory',false):null;
    }
  });
  // Обрезка и прозрачный цвет: сервер пишет новый PNG, в книге меняется адрес (и ширина — только при обрезке).
  async function replaceImageAt(pos,endpoint,payload,label,scale=1){
    if(typeof pos!=='number')throw new Error('Картинка не найдена.');
    const node=view.state.doc.nodeAt(pos);if(!node||!imageTypes.has(node.type.name))throw new Error('Картинка не найдена.');
    let uses=0;view.state.doc.descendants(n=>{if(imageTypes.has(n.type.name)&&n.attrs.src===node.attrs.src)uses++;});
    const was=$('save-status').textContent;uploadCount++;status(label);
    let result;
    try{result=await api(endpoint,{method:'POST',data:{src:node.attrs.src,...payload,keep:uses>1}});}
    catch(err){status(was);throw err;}
    finally{uploadCount--;}
    // Ширина на странице уменьшается вместе с картинкой: рисунок остается того же масштаба, только без полей.
    const current=view.state.doc.nodeAt(pos)?.attrs.src===node.attrs.src?pos:null;
    let at=current;if(at===null)view.state.doc.descendants((n,p)=>{if(at===null&&n.attrs?.id&&n.attrs.id===node.attrs.id)at=p;});
    if(at===null)throw new Error('Картинка не найдена.');
    const fresh=view.state.doc.nodeAt(at),before=fresh.attrs.width||(fresh.type.name==='figure_image'?100:45);
    const width=scale===1?fresh.attrs.width:Math.max(5,Math.min(100,Math.round(before*scale)));
    // Отмена ранних шагов (Ctrl+Z) не возвращает ни старый файл, ни прежнюю ширину обрезанной картинки.
    if(uses<=1){replacedImages.set(node.attrs.src,{src:result.url,w:result.w,h:result.h,width});for(const [k,v] of replacedImages)if(v.src===node.attrs.src)replacedImages.set(k,{src:result.url,w:result.w,h:result.h,width});}
    const tr=view.state.tr.setNodeMarkup(at,undefined,{...fresh.attrs,src:result.url,w:result.w,h:result.h,width}).setMeta('addToHistory',false);
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc,at)));view.focus();syncToolbar();
    clearTimeout(timer);timer=setTimeout(save,200);
  }
  // Черновик в localStorage: несохранённый текст переживает закрытие вкладки, сбой сервера и подмену файла.
  const DRAFT_KEY='izdt:bees:draft';
  const writeDraft=()=>{draftTimer=null;if(!dirty||!view)return;storage.set(DRAFT_KEY,JSON.stringify({html:currentHTML(),revision:state.revision,time:Date.now()}));};
  const clearDraft=()=>{clearTimeout(draftTimer);draftTimer=null;storage.remove(DRAFT_KEY);};
  const readDraft=()=>{try{const d=JSON.parse(storage.get(DRAFT_KEY));return d&&typeof d.html==='string'&&d.html.trim()?d:null;}catch{return null;}};
  const uploads=new Set();
  const status=(text,error=false)=>{$('save-status').textContent=text;$('save-status').classList.toggle('error',error);};
  const currentHTML=()=>view?serializeDocument(view.state.doc):book.innerHTML;
  function selectedBlocks() {
    if(!view)return [];
    const {from,to,$from,empty}=view.state.selection, blocks=[];
    if(empty&&$from.parent.isTextblock)blocks.push({node:$from.parent,pos:$from.before()});
    else view.state.doc.nodesBetween(from,to,(node,pos)=>{if(node.isTextblock){blocks.push({node,pos});return false;}});
    return blocks;
  }
  function selectedImage() {
    const sel=view?.state.selection;
    return sel instanceof NodeSelection && imageTypes.has(sel.node.type.name)?{node:sel.node,pos:sel.from}:null;
  }
  function overlayAt() {
    if(!view)return null;
    const {$from}=view.state.selection;
    for(let depth=$from.depth;depth>0;depth--)if($from.node(depth).type===schema.nodes.overlay)return {node:$from.node(depth),pos:$from.before(depth),figure:$from.node(depth-1),figurePos:$from.before(depth-1)};
    return null;
  }
  function figureOf(image) {
    if(!image||image.node.type.name!=='figure_image')return null;
    const $pos=view.state.doc.resolve(image.pos), node=$pos.parent, pos=$pos.before();
    const out={node,pos,overlay:null,caption:null};
    node.forEach((child,offset)=>{
      if(child.type===schema.nodes.overlay)out.overlay={node:child,pos:pos+1+offset};
      if(child.type===schema.nodes.figcaption)out.caption={node:child,pos:pos+1+offset};
    });
    return out;
  }
  function captureNativeSelection() {
    const native=getSelection();
    if(view&&!(view.state.selection instanceof NodeSelection)&&native.rangeCount&&book.contains(native.anchorNode)&&book.contains(native.focusNode)){
      try{
        const anchor=view.posAtDOM(native.anchorNode,native.anchorOffset),head=view.posAtDOM(native.focusNode,native.focusOffset);
        if(anchor!==view.state.selection.anchor||head!==view.state.selection.head)view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,anchor,head)));
      }catch{}
    }
  }
  function setControl(id,value) {
    const el=$(id);
    if(document.activeElement===el)return;
    el.value=value??'';
    if(el.tagName==='INPUT')el.placeholder=value==null?'Разные':'';
  }
  const common=values=>values.length && values.every(v=>v===values[0])?values[0]:null;
  function syncToolbar() {
    if(!view)return;
    const blocks=selectedBlocks(), image=selectedImage(), {selection,storedMarks}=view.state;
    $('editor-toolbar').dataset.blockId=blocks[0]?.node.attrs.id||'';
    $('editor-toolbar').dataset.selectionText=view.state.doc.textBetween(selection.from,selection.to,'\n');
    const types=blocks.map(({node})=>styleName(node));
    const runs=[];
    if(selection.empty&&selection.$from.parent.isTextblock)runs.push({node:selection.$from.parent,marks:storedMarks||selection.$from.marks()});
    else for(const {node,pos} of blocks)node.descendants((child,offset)=>{
      if(child.isText&&child.text.trim()&&pos+offset+1<selection.to&&pos+offset+1+child.nodeSize>selection.from)runs.push({node,marks:child.marks});
    });
    const valueFor=(run,key)=>{
      const d=DEFAULTS[styleName(run.node)]||DEFAULTS.p;
      const direct=run.marks.find(m=>m.type===schema.marks.text_style)?.attrs;
      return key==='size'?parseFloat(direct?.size||run.node.attrs.size||d.size):direct?.family||run.node.attrs.family||d.family;
    };
    const marker=runs.length&&runs.every(r=>r.marks.some(m=>m.type===schema.marks.paragraph_label));
    setControl('text-style',marker?'paragraph':common(types));
    setControl('font-size',common(runs.map(r=>valueFor(r,'size'))));
    setControl('font-family',common(runs.map(r=>valueFor(r,'family'))));
    setControl('line-height',common(blocks.map(({node})=>{
      const d=DEFAULTS[styleName(node)]||DEFAULTS.p, leading=node.attrs.leading;
      return leading?Number((parseFloat(leading)*(leading.endsWith('rem')?1:parseFloat(node.attrs.size)||d.size)).toFixed(4)):d.leading;
    })));
    setControl('text-indent',common(blocks.map(({node})=>parseFloat(node.attrs.indent??DEFAULTS[styleName(node)]?.indent??3.075))));
    setControl('text-align',common(blocks.map(({node})=>node.attrs.align||(node.attrs.signature?'right':DEFAULTS[styleName(node)]?.align)||'left')));
    for(const [command,mark] of Object.entries({bold:'strong',italic:'em',underline:'underline',strikeThrough:'strike'})){
      const active=runs.length&&runs.every(r=>r.marks.some(m=>m.type===schema.marks[mark])||(mark==='em'&&(styleName(r.node)==='paragraph'||r.node.attrs.signature||r.marks.some(m=>m.type===schema.marks.paragraph_label))));
      const button=document.querySelector(`[data-command="${command}"]`);
      button.setAttribute('aria-pressed',String(!!active));
    }
    for(const id of controlIds)$(id).disabled=!!image||!blocks.length;
    for(const b of document.querySelectorAll('[data-command]:not([data-command=undo]):not([data-command=redo])'))b.disabled=!!image||!blocks.length;
    document.querySelector('[data-command=undo]').disabled=!undo(view.state);
    document.querySelector('[data-command=redo]').disabled=!redo(view.state);
    const figure=figureOf(image), overlay=overlayAt();
    $('image-tools').classList.toggle('has-image',!!image);
    $('image-tools').hidden=!image;$('text-tools').hidden=!!image;
    if(image&&!$('style-editor').hidden)closeStyleEditor();
    if(cropping&&!image)cropping.stop();
    for(const id of ['image-wrap','image-align','image-width','image-alt','delete-image','image-crop','image-transparent'])$(id).disabled=!image||!!cropping;
    $('image-crop').setAttribute('aria-pressed',String(cropping?.kind==='crop'));
    $('image-wrap').querySelector('[value=inline]').disabled=!!figure;
    $('figure-text').hidden=!image||!!figure?.overlay;
    $('figure-caption').hidden=!image;
    $('figure-caption').setAttribute('aria-pressed',String(!!figure?.caption));
    $('figure-caption').title=figure?.caption?'Убрать подпись: ее текст встанет под картинкой обычными абзацами':'Подпись под картинкой: при обтекании переносится вместе с картинкой';
    $('image-selection-label').textContent=figure?(figure.overlay&&figure.caption?'Картинка с текстом и подписью':figure.overlay?'Картинка с текстом':'Картинка с подписью'):image?'Изображение':'Выберите изображение';
    setControl('image-wrap',figure?figure.node.attrs.mode:image?.node.attrs.mode||'block');
    setControl('image-align',image?.node.attrs.align||'center');
    setControl('image-width',image?.node.attrs.width||(figure?100:45));
    setControl('image-alt',image?.node.attrs.alt||'');
    $('overlay-tools').hidden=!overlay;
    if(overlay){setControl('overlay-x',overlay.node.attrs.x);setControl('overlay-y',overlay.node.attrs.y);setControl('overlay-width',overlay.node.attrs.width);}
  }
  function updateTOC() {
    const root=document.createElement('div');root.innerHTML=currentHTML();
    state.toc=makeTOC(root,state.overrides);if(panels.mode)panels.render();
  }
  function changed() {
    dirty=true;status('Не сохранено');updateTOC();
    clearTimeout(timer);if(!conflict)timer=setTimeout(save,900);
    if(!draftTimer)draftTimer=setTimeout(writeDraft,1500);
  }
  async function save() {
    clearTimeout(timer);
    // Идет загрузка или обрезка картинки: сохраняем сразу после нее.
    if(uploadCount){status('Сохранение после загрузки изображения…');timer=setTimeout(save,400);return false;}
    if(flight){await flight;return dirty?save():true;}
    if(!dirty)return true;
    flight=(async()=>{
      while(dirty&&view) {
        const html=currentHTML();
        try {
          status('Сохранение…');
          const result=await api('book',{method:'PUT',data:{html,revision:state.revision}});
          state.revision=result.revision;state.overrides=result.overrides;
          dirty=currentHTML()!==html;conflict=false;
          if(!dirty){state.toc=result.toc;status('Сохранено');clearDraft();}
          for(const warning of result.warnings||[])notify(warning,20000);
        }catch(e){conflict=e.message.includes('другой вкладке');writeDraft();status('Не сохранено · повторите',true);notify(e.message,20000);return false;}
      }
      return !dirty;
    })();
    try{return await flight;}finally{flight=null;}
  }
  const ids=new Plugin({
    appendTransaction(transactions,old,newState) {
      if(!transactions.some(tr=>tr.docChanged))return;
      const seen=new Set(), tr=newState.tr;
      newState.doc.descendants((node,pos)=>{
        if(!('id' in node.attrs))return;
        let id=node.attrs.id;
        if(!id||seen.has(id)){id=uid();tr.setNodeMarkup(pos,undefined,{...node.attrs,id});}
        seen.add(id);
      });
      return tr.docChanged?tr.setMeta('addToHistory',false):null;
    }
  });
  function dispatch(tr) {
    for(const upload of uploads)upload.bookmark=upload.bookmark.map(tr.mapping);
    const next=view.state.apply(tr);view.updateState(next);
    if(tr.docChanged)changed();
    syncToolbar();
  }
  function imageView(node,editor,getPos) {
    let current=node;
    const dom=document.createElement('span'),img=document.createElement('img'),handle=document.createElement('span');
    dom.contentEditable='false';dom.draggable=true;
    handle.className='image-resize-handle';handle.title='Потяните, чтобы изменить ширину';
    handle.setAttribute('aria-hidden','true');
    dom.append(img,handle);
    const render=()=>{
      const [,a]=imageDOM(current);
      const selected=dom.classList.contains('ProseMirror-selectednode');
      dom.className=`image-shell ${a.class}${selected?' ProseMirror-selectednode':''}`;
      dom.dataset.align=current.attrs.align;
      dom.style.width=`${current.attrs.width||(current.type.name==='figure_image'?100:45)}%`;
      img.src=base+current.attrs.src;img.alt=current.attrs.alt;img.draggable=false;
      if(current.attrs.w&&current.attrs.h){img.width=current.attrs.w;img.height=current.attrs.h;}else{img.removeAttribute('width');img.removeAttribute('height');}
      if(current.attrs.id)dom.id=current.attrs.id;
    };
    render();
    // Картинка без известных пропорций: после загрузки запоминаем естественные размеры в документе (без записи в историю).
    img.addEventListener('load',()=>{
      if(current.attrs.w&&current.attrs.h||!(img.naturalWidth>0&&img.naturalHeight>0))return;
      const pos=getPos();if(typeof pos!=='number')return;
      const node=editor.state.doc.nodeAt(pos);if(!node||node.type!==current.type)return;
      const tr=editor.state.tr.setNodeMarkup(pos,undefined,{...node.attrs,w:img.naturalWidth,h:img.naturalHeight}).setMeta('addToHistory',false);
      const {selection}=editor.state;if(selection instanceof NodeSelection&&selection.from===pos)tr.setSelection(NodeSelection.create(tr.doc,pos));
      editor.dispatch(tr);
    });
    handle.addEventListener('pointerdown',e=>{
      e.preventDefault();e.stopPropagation();handle.setPointerCapture(e.pointerId);
      // В картинке-блоке с обтеканием ширину задает сам блок, поэтому проценты считаются от колонки текста, а не от блока.
      const box=current.type.name==='figure_image'?dom.parentElement:null, wrapped=!!box&&/\bwrap-(left|right)\b/.test(box.className);
      const start=e.clientX,width=dom.getBoundingClientRect().width,container=(wrapped?box.parentElement:dom.parentElement).getBoundingClientRect().width;
      let percent=current.attrs.width||45;
      const move=ev=>{
        percent=Math.min(100,Math.max(5,(width+ev.clientX-start)/container*100));dom.style.width=`${percent}%`;
        if(wrapped)box.style.width=`${percent}%`;else if(box)box.style.setProperty('--image-width',`${percent}%`);
      };
      const end=()=>{
        handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',cancel);
        const pos=getPos();if(typeof pos==='number'){
          const tr=closeHistory(editor.state.tr).setNodeMarkup(pos,undefined,{...current.attrs,width:Math.round(percent)});
          editor.dispatch(tr.setSelection(NodeSelection.create(tr.doc,pos)));
        }
      };
      const cancel=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',cancel);render();};
      handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',cancel);
    });
    // Обрезка: рамка поверх картинки, края и углы тянутся, внутренность перетаскивается.
    let crop=null;
    const stopCrop=()=>{if(!crop)return;crop.ui.remove();crop=null;dom.classList.remove('cropping');dom.draggable=true;dom.parentElement?.classList.remove('cropping');cropping=null;syncToolbar();};
    const startCrop=()=>{
      if(crop)return;
      if(!(img.naturalWidth>0)){notify('Картинка еще не загрузилась.');return;}
      const ui=document.createElement('span');ui.className='crop-ui';ui.contentEditable='false';
      const shades=['top','right','bottom','left'].map(side=>{const d=document.createElement('span');d.className=`crop-shade crop-shade-${side}`;return d;});
      const frame=document.createElement('span');frame.className='crop-frame';
      for(const edge of ['n','e','s','w','ne','se','sw','nw']){const h=document.createElement('span');h.className=`crop-handle crop-${edge}`;h.dataset.edge=edge;frame.append(h);}
      const bar=document.createElement('span');bar.className='crop-bar';
      const saveButton=document.createElement('button');saveButton.type='button';saveButton.textContent='Сохранить';saveButton.className='crop-save';
      const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.textContent='Отмена';cancelButton.className='crop-cancel';
      bar.append(saveButton,cancelButton);ui.append(...shades,frame,bar);dom.append(ui);
      crop={ui,box:{l:0,t:0,r:1,b:1}};dom.classList.add('cropping');dom.draggable=false;
      if(current.type.name==='figure_image')dom.parentElement?.classList.add('cropping');
      const layout=()=>{
        const {l,t,r,b}=crop.box,pc=v=>`${v*100}%`;
        Object.assign(frame.style,{left:pc(l),top:pc(t),width:pc(r-l),height:pc(b-t)});
        Object.assign(shades[0].style,{left:0,top:0,width:'100%',height:pc(t)});
        Object.assign(shades[2].style,{left:0,top:pc(b),width:'100%',height:pc(1-b)});
        Object.assign(shades[3].style,{left:0,top:pc(t),width:pc(l),height:pc(b-t)});
        Object.assign(shades[1].style,{left:pc(r),top:pc(t),width:pc(1-r),height:pc(b-t)});
        Object.assign(bar.style,{top:pc(b),left:pc((l+r)/2)});
        const W=img.naturalWidth,H=img.naturalHeight;
        saveButton.title=`Сохранить обрезку: ${Math.round(r*W)-Math.round(l*W)}×${Math.round(b*H)-Math.round(t*H)} px из ${W}×${H}`;
      };
      layout();
      frame.addEventListener('pointerdown',e=>{
        e.preventDefault();e.stopPropagation();frame.setPointerCapture(e.pointerId);
        const edge=e.target.dataset?.edge||'move', rect=img.getBoundingClientRect(), start={...crop.box}, x0=e.clientX, y0=e.clientY;
        const minW=Math.min(1,12/rect.width), minH=Math.min(1,12/rect.height), clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
        const move=ev=>{
          const dx=(ev.clientX-x0)/rect.width, dy=(ev.clientY-y0)/rect.height, b={...start};
          if(edge==='move'){const w=start.r-start.l,h=start.b-start.t;b.l=clamp(start.l+dx,0,1-w);b.r=b.l+w;b.t=clamp(start.t+dy,0,1-h);b.b=b.t+h;}
          else{
            if(edge.includes('w'))b.l=clamp(start.l+dx,0,start.r-minW);
            if(edge.includes('e'))b.r=clamp(start.r+dx,start.l+minW,1);
            if(edge.includes('n'))b.t=clamp(start.t+dy,0,start.b-minH);
            if(edge.includes('s'))b.b=clamp(start.b+dy,start.t+minH,1);
          }
          crop.box=b;layout();
        };
        const end=()=>{frame.removeEventListener('pointermove',move);frame.removeEventListener('pointerup',end);frame.removeEventListener('pointercancel',end);};
        frame.addEventListener('pointermove',move);frame.addEventListener('pointerup',end);frame.addEventListener('pointercancel',end);
      });
      cancelButton.onclick=e=>{e.preventDefault();stopCrop();editor.focus();};
      saveButton.onclick=async e=>{
        e.preventDefault();
        const W=img.naturalWidth,H=img.naturalHeight,{l,t,r,b}=crop.box;
        const x=Math.round(l*W),y=Math.round(t*H),width=Math.round(r*W)-x,height=Math.round(b*H)-y;
        if(x===0&&y===0&&width===W&&height===H){stopCrop();editor.focus();return;}
        saveButton.disabled=cancelButton.disabled=true;saveButton.textContent='Сохранение…';
        try{await replaceImageAt(getPos(),'images/crop',{x,y,width,height},'Обрезка изображения…',width/W);stopCrop();}
        catch(err){notify(err.message,12000);saveButton.disabled=cancelButton.disabled=false;saveButton.textContent='Сохранить';}
      };
      cropping={stop:stopCrop,kind:'crop'};syncToolbar();
    };
    dom.izdtStartCrop=startCrop;
    // Пипетка: щелчок по картинке делает этот цвет прозрачным во всем изображении (точное совпадение).
    let pick=null;
    const stopPick=()=>{if(!pick)return;pick.ui.remove();img.removeEventListener('pointermove',pick.hover);img.removeEventListener('click',pick.click,true);pick=null;dom.classList.remove('picking');dom.draggable=true;cropping=null;syncToolbar();};
    const startPick=()=>{
      if(pick||crop)return;
      if(!(img.naturalWidth>0)){notify('Картинка еще не загрузилась.');return;}
      const W=img.naturalWidth,H=img.naturalHeight,point=e=>{const r=img.getBoundingClientRect();return {x:Math.min(W-1,Math.max(0,Math.floor((e.clientX-r.left)/r.width*W))),y:Math.min(H-1,Math.max(0,Math.floor((e.clientY-r.top)/r.height*H)))};};
      let ctx=null;try{const c=document.createElement('canvas');c.width=W;c.height=H;ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);ctx.getImageData(0,0,1,1);}catch{ctx=null;}
      const ui=document.createElement('span');ui.className='pick-bar';ui.contentEditable='false';
      const swatch=document.createElement('span');swatch.className='pick-swatch';
      const hint=document.createElement('span');hint.className='pick-hint';hint.textContent='Щелкните по цвету, который станет прозрачным';
      const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.textContent='Отмена';cancelButton.className='crop-cancel';
      ui.append(swatch,hint,cancelButton);dom.append(ui);
      const hover=e=>{if(!ctx)return;const {x,y}=point(e),[r,g,b,a]=ctx.getImageData(x,y,1,1).data;swatch.style.background=a?`rgb(${r} ${g} ${b})`:'transparent';swatch.classList.toggle('clear',!a);};
      const click=async e=>{
        e.preventDefault();e.stopPropagation();if(pick.busy)return;
        pick.busy=true;hint.textContent='Сохранение…';cancelButton.disabled=true;
        try{await replaceImageAt(getPos(),'images/transparent',point(e),'Прозрачный цвет…');stopPick();}
        catch(err){notify(err.message,12000);pick.busy=false;hint.textContent='Щелкните по цвету, который станет прозрачным';cancelButton.disabled=false;}
      };
      cancelButton.onclick=e=>{e.preventDefault();stopPick();editor.focus();};
      img.addEventListener('pointermove',hover);img.addEventListener('click',click,true);
      pick={ui,hover,click,busy:false};dom.classList.add('picking');dom.draggable=false;
      cropping={stop:stopPick,kind:'pick'};syncToolbar();
    };
    dom.izdtStartPick=startPick;
    return {dom,update(n){if(n.type!==current.type)return false;if(crop&&n.attrs.src!==current.attrs.src)stopCrop();if(pick&&!pick.busy&&n.attrs.src!==current.attrs.src)stopPick();current=n;render();return true;},
      selectNode(){dom.classList.add('ProseMirror-selectednode');},
      deselectNode(){dom.classList.remove('ProseMirror-selectednode');stopCrop();if(pick&&!pick.busy)stopPick();},
      destroy(){if(crop||pick)cropping=null;},
      stopEvent:e=>e.target===handle||!!e.target.closest?.('.crop-ui,.pick-bar')||(!!pick&&e.target===img),ignoreMutation:()=>true};
  }
  // Плашка с текстом на картинке: перетаскивается за ручку, ширина меняется маркером справа.
  function overlayView(node,editor,getPos) {
    let current=node;
    const dom=document.createElement('div'),grip=document.createElement('span'),handle=document.createElement('span'),contentDOM=document.createElement('div');
    dom.className='image-overlay';contentDOM.className='image-overlay-content';
    grip.className='overlay-grip';grip.title='Потяните, чтобы переместить текст по картинке';grip.contentEditable='false';grip.setAttribute('aria-hidden','true');
    handle.className='overlay-resize';handle.title='Потяните, чтобы изменить ширину плашки';handle.contentEditable='false';handle.setAttribute('aria-hidden','true');
    dom.append(grip,contentDOM,handle);
    const place=a=>{dom.style.marginLeft=`${a.x}%`;dom.style.marginTop=`${a.y}%`;dom.style.width=`${a.width}%`;};
    const render=()=>{place(current.attrs);if(current.attrs.id)dom.id=current.attrs.id;};
    render();
    const clamp=(v,min,max)=>Math.round(Math.min(max,Math.max(min,v)));
    const drag=(el,compute)=>el.addEventListener('pointerdown',e=>{
      e.preventDefault();e.stopPropagation();el.setPointerCapture(e.pointerId);
      const figure=dom.parentElement.getBoundingClientRect(),startX=e.clientX,startY=e.clientY,start={...current.attrs};
      let next=start;
      const move=ev=>{next=compute(start,(ev.clientX-startX)/figure.width*100,(ev.clientY-startY)/figure.width*100);place(next);};
      const stop=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',end);el.removeEventListener('pointercancel',cancel);};
      const end=()=>{stop();const pos=getPos();if(typeof pos==='number'&&next!==start)editor.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos,undefined,next));else render();};
      const cancel=()=>{stop();render();};
      el.addEventListener('pointermove',move);el.addEventListener('pointerup',end);el.addEventListener('pointercancel',cancel);
    });
    drag(grip,(s,dx,dy)=>({...s,x:clamp(s.x+dx,0,100-s.width),y:clamp(s.y+dy,0,300)}));
    drag(handle,(s,dx)=>({...s,width:clamp(s.width+dx,10,100-s.x)}));
    return {dom,contentDOM,update(n){if(n.type!==current.type)return false;current=n;render();return true;},
      stopEvent:e=>e.target===grip||e.target===handle,
      ignoreMutation:m=>m.type!=='selection'&&(!contentDOM.contains(m.target)||m.target===contentDOM&&m.type==='attributes')};
  }
  // toggle({html}) открывает редактор с подставленным текстом (восстановление черновика).
  async function toggle(options={}) {
    if(state.editing) {
      if(!(await save()))return;
      const html=currentHTML();view.destroy();view=null;
      state.editing=false;book.contentEditable='false';book.setAttribute('spellcheck','false');
      book.classList.remove('ProseMirror','ProseMirror-focused','ProseMirror-hideselection');
      document.body.classList.remove('editing');$('editor-toolbar').hidden=true;$('toggle-editor').classList.remove('active');
      book.innerHTML=html;applyAssetURLs(book);
      try{const result=await api('reader');if(!state.editing){state.notes=result.notes;book.innerHTML=result.content;applyAssetURLs(book);panels.render();}}catch(e){notify(e.message);}
      return;
    }
    panels.close();for(const mark of book.querySelectorAll('mark'))mark.replaceWith(...mark.childNodes);
    if(typeof options.html==='string'){book.innerHTML=options.html;applyAssetURLs(book);}
    const doc=parseDocument(book);
    state.editing=true;document.body.classList.add('editing');book.setAttribute('spellcheck','true');$('editor-toolbar').hidden=false;$('toggle-editor').classList.add('active');
    view=new EditorView({mount:book},{
      state:EditorState.create({schema,doc,plugins:[
        history(),figures,replaced,ids,typography,
        keymap({'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,
          'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Mod-u':toggleMark(schema.marks.underline),
          'Mod-Home':(s,d)=>{d(s.tr.setSelection(TextSelection.atStart(s.doc)).scrollIntoView());return true;},
          'Mod-End':(s,d)=>{d(s.tr.setSelection(TextSelection.atEnd(s.doc)).scrollIntoView());return true;},
          'Shift-Enter':(s,d)=>{d(s.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());return true;},
          'Backspace':removeEmptyFigurePart}),
        keymap(baseKeymap)
      ]}),
      dispatchTransaction:dispatch,
      nodeViews:{image:imageView,figure_image:imageView,overlay:overlayView},
      // The mounted article owns .book, spellcheck and its accessible label.
      // ProseMirror removes every attribute/class declared here on destroy().
      // Only give it editor-specific attributes; otherwise exiting strips reader styling.
      attributes:{role:'textbox','aria-multiline':'true'},
      scrollMargin:{top:40,bottom:180},scrollThreshold:{top:40,bottom:180},
      handleDOMEvents:{keydown(){captureNativeSelection();return false;}},
      handlePaste(editor,event){
        const file=[...event.clipboardData.items].find(i=>i.type.startsWith('image/'))?.getAsFile();
        if(file){upload(file);return true;}return false;
      },
      handleDrop(editor,event){
        const file=[...event.dataTransfer.files].find(f=>f.type.startsWith('image/'));
        if(!file)return false;
        const position=editor.posAtCoords({left:event.clientX,top:event.clientY});
        if(position)editor.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position.pos))));
        upload(file);return true;
      },
      handleClickOn(editor,pos,node,nodePos,event,direct){
        if(direct&&imageTypes.has(node.type.name)){editor.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc,nodePos)));return true;}
        return false;
      }
    });
    status('Сохранено');dirty=false;conflict=false;
    view.focus();syncToolbar();
    if(typeof options.html==='string'){changed();}
  }
  function finish(tr) {view.dispatch(closeHistory(tr));view.focus();syncToolbar();}
  function blockAttribute(name,value) {
    if(!view)return;
    captureNativeSelection();
    let tr=view.state.tr;
    for(const {node,pos} of selectedBlocks())tr.setNodeMarkup(pos,undefined,{...node.attrs,[name]:value});
    finish(tr);
  }
  function applyStyle(type) {
    if(!view||!type)return;
    captureNativeSelection();
    const {from,to,empty,$from,$to}=view.state.selection;
    if(type==='paragraph'&&!empty&&$from.sameParent($to)){
      finish(view.state.tr.addMark(from,to,schema.marks.paragraph_label.create({id:uid()})));return;
    }
    const blocks=selectedBlocks();let tr=view.state.tr;
    for(const {node,pos} of blocks) {
      const heading=/^h[123]$/.test(type);
      const attributes={id:node.attrs.id,kind:heading?'p':type,level:heading?Number(type.slice(1)):undefined};
      tr.setNodeMarkup(pos,heading?schema.nodes.heading:schema.nodes.paragraph,attributes);
      // A named style resets direct font overrides rather than being hidden by old inline sizes.
      tr.removeMark(pos+1,pos+node.nodeSize-1,schema.marks.text_style);
      if(type!=='paragraph')tr.removeMark(pos+1,pos+node.nodeSize-1,schema.marks.paragraph_label);
    }
    finish(tr);
  }
  function inlineAttribute(name,value) {
    if(!view)return;
    captureNativeSelection();
    const {from,to,empty,$from}=view.state.selection;
    let tr=view.state.tr;
    if(empty){
      const marks=view.state.storedMarks||$from.marks(),old=marks.find(m=>m.type===schema.marks.text_style);
      tr.addStoredMark(schema.marks.text_style.create({...old?.attrs,[name]:value}));
    }else{
      view.state.doc.nodesBetween(from,to,(node,pos)=>{
        if(!node.isText)return;
        const old=node.marks.find(m=>m.type===schema.marks.text_style);
        tr.addMark(Math.max(from,pos),Math.min(to,pos+node.nodeSize),schema.marks.text_style.create({...old?.attrs,[name]:value}));
      });
    }
    if(name==='size'){
      for(const {node,pos} of selectedBlocks()){
        const d=DEFAULTS[styleName(node)]||DEFAULTS.p;
        const existing=node.attrs.leading?parseFloat(node.attrs.leading)*(node.attrs.leading.endsWith('rem')?1:parseFloat(node.attrs.size)||d.size):d.leading;
        const minimum=Number((parseFloat(value)*1.05).toFixed(4));
        if(existing<minimum)tr.setNodeMarkup(pos,undefined,{...node.attrs,leading:`${minimum}rem`});
      }
    }
    if(empty){
      const marks=view.state.storedMarks||$from.marks(),old=marks.find(m=>m.type===schema.marks.text_style);
      tr.addStoredMark(schema.marks.text_style.create({...old?.attrs,[name]:value}));
    }
    finish(tr);
  }
  function numberControl(id,min,max,fn) {
    $(id).onchange=e=>{
      const value=Number(e.target.value);
      if(!e.target.value||!Number.isFinite(value)||value<min||value>max){notify(`Допустимый диапазон: ${min}–${max}.`);e.target.blur();syncToolbar();return;}
      fn(value);e.target.blur();syncToolbar();
    };
    $(id).onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.target.dispatchEvent(new Event('change'));}};
  }
  $('text-style').onchange=e=>{applyStyle(e.target.value);e.target.blur();syncToolbar();};
  // Настройка именованных стилей: правки уходят в styles.json и сразу применяются через <style id="book-styles">.
  function renderStyles(){applyStyles(state.styles);$('book-styles').textContent=stylesCSS(state.styles);}
  function fillStyleEditor(){
    const key=STYLE_KEYS.includes($('style-target').value)?$('style-target').value:'p', d=DEFAULTS[key];
    $('style-family').value=d.family;$('style-size').value=d.size;$('style-leading').value=d.leading;$('style-indent').value=d.indent;$('style-align').value=d.align;
    $('style-reset').disabled=!state.styles?.[key];
  }
  function closeStyleEditor(){$('style-editor').hidden=true;$('style-settings').setAttribute('aria-expanded','false');}
  $('style-settings').onclick=()=>{
    if(!$('style-editor').hidden){closeStyleEditor();return;}
    const current=$('text-style').value;if(STYLE_KEYS.includes(current))$('style-target').value=current;
    fillStyleEditor();$('style-editor').hidden=false;$('style-settings').setAttribute('aria-expanded','true');
  };
  $('style-target').onchange=fillStyleEditor;
  $('style-close').onclick=closeStyleEditor;
  async function saveStyle(reset){
    const style=$('style-target').value, values={family:$('style-family').value,size:Number($('style-size').value),leading:Number($('style-leading').value),indent:Number($('style-indent').value),align:$('style-align').value};
    if(!reset&&(!(values.size>=.5&&values.size<=8)||!(values.leading>=.5&&values.leading<=16)||!(values.indent>=0&&values.indent<=10))){notify('Проверьте размер (0,5–8), интерлиньяж (0,5–16) и красную строку (0–10).');return;}
    try{
      const result=await api('styles',{method:'PUT',data:reset?{style,reset:true}:{style,values}});
      state.styles=result.styles||{};state.revision=result.revision;renderStyles();fillStyleEditor();syncToolbar();
      notify(reset?'Стиль возвращён к исходным значениям.':'Стиль обновлён для всех абзацев.');
    }catch(e){notify(e.message,12000);}
  }
  $('style-apply').onclick=()=>saveStyle(false);
  $('style-reset').onclick=()=>saveStyle(true);
  renderStyles();
  $('font-family').onchange=e=>inlineAttribute('family',e.target.value);
  numberControl('font-size',.5,8,v=>inlineAttribute('size',`${v}rem`));
  numberControl('line-height',.5,16,v=>blockAttribute('leading',`${v}rem`));
  numberControl('text-indent',0,10,v=>blockAttribute('indent',`${v}rem`));
  $('text-align').onchange=e=>blockAttribute('align',e.target.value);
  $('clear-format').onclick=()=>{
    if(!view)return;
    const {from,to,empty}=view.state.selection;let tr=view.state.tr;
    if(empty)tr.setStoredMarks([]);
    else for(const mark of ['text_style','strong','em','underline','strike'])tr.removeMark(from,to,schema.marks[mark]);
    for(const {node,pos} of selectedBlocks())tr.setNodeMarkup(pos,undefined,{...node.attrs,size:null,family:null,leading:null,indent:null,align:null,signature:false});
    finish(tr);
  };
  const commands={undo,redo,bold:toggleMark(schema.marks.strong),italic:toggleMark(schema.marks.em),underline:toggleMark(schema.marks.underline),strikeThrough:toggleMark(schema.marks.strike)};
  for(const button of document.querySelectorAll('[data-command]'))button.onclick=()=>{
    if(view){commands[button.dataset.command]?.(view.state,view.dispatch,view);view.focus();syncToolbar();}
  };
  function changeImage(attributes) {
    const selected=selectedImage();if(!selected)return;
    const figure=figureOf(selected);
    const next={...selected.node.attrs,...attributes};
    if(!figure){
      if(next.mode==='square'&&next.align==='center')next.align='left';
      const tr=view.state.tr.setNodeMarkup(selected.pos,undefined,next);
      finish(tr.setSelection(NodeSelection.create(tr.doc,selected.pos)));return;
    }
    // Картинка-блок: обтекание у блока целиком (вместе с плашкой и подписью), в строке с текстом он не встает.
    const before=figure.node.attrs.mode, mode=attributes.mode?(attributes.mode==='square'?'square':'block'):before;
    if(mode==='square'&&next.align==='center')next.align='left';
    next.mode='block';
    const tr=view.state.tr.setNodeMarkup(selected.pos,undefined,next);
    tr.setNodeMarkup(figure.pos,undefined,{...figure.node.attrs,mode,align:next.align,width:next.width||null});
    if(figure.overlay&&mode!==before)
      tr.setNodeMarkup(figure.overlay.pos,undefined,convertOverlay(figure.overlay.node.attrs,mode==='square',next.width,next.align));
    finish(tr.setSelection(NodeSelection.create(tr.doc,selected.pos)));
  }
  $('image-crop').onclick=()=>{const image=selectedImage();if(!image)return;view.nodeDOM(image.pos)?.izdtStartCrop?.();};
  $('image-transparent').onclick=()=>{const image=selectedImage();if(!image)return;view.nodeDOM(image.pos)?.izdtStartPick?.();};
  $('image-wrap').onchange=e=>changeImage({mode:e.target.value});
  $('image-align').onchange=e=>{
    const image=selectedImage();if(!image)return;
    const mode=figureOf(image)?.node.attrs.mode||image.node.attrs.mode;
    changeImage({align:e.target.value,...(mode==='square'&&e.target.value==='center'?{mode:'block'}:{})});
  };
  numberControl('image-width',5,100,v=>changeImage({width:v}));
  $('image-alt').onchange=e=>changeImage({alt:e.target.value});
  // Абзацы плашки и подписи, которые остаются в книге обычным текстом (пустые не нужны).
  const keepText=part=>{
    const nodes=[];
    part?.node.forEach(child=>{
      if(!child.textContent.trim())return;
      nodes.push(child.type===schema.nodes.paragraph&&child.attrs.kind==='caption'?child.type.create({...child.attrs,kind:'p'},child.content,child.marks):child);
    });
    return nodes;
  };
  $('delete-image').onclick=()=>{
    const image=selectedImage();if(!image)return;
    const figure=figureOf(image);
    if(!figure){finish(view.state.tr.deleteSelection());return;}
    // Картинка с текстом или подписью: текст остается в книге обычными абзацами.
    const nodes=[...keepText(figure.overlay),...keepText(figure.caption)];
    const tr=view.state.tr.replaceWith(figure.pos,figure.pos+figure.node.nodeSize,nodes.length?nodes:schema.nodes.paragraph.create({id:uid()}));
    finish(tr.setSelection(TextSelection.near(tr.doc.resolve(figure.pos))));
  };
  // Обычная картинка становится картинкой-блоком с теми же обтеканием, положением и шириной. Возвращает позицию блока.
  function wrapImage(tr,image,parts) {
    const $pos=tr.doc.resolve(image.pos), parent=$pos.parent, parentPos=$pos.before();
    const a=image.node.attrs, square=a.mode==='square', width=a.width||45;
    const align=square?(a.align==='right'?'right':'left'):a.align;
    const node=schema.nodes.figure.create({id:uid(),mode:square?'square':'block',align,width},
      [schema.nodes.figure_image.create({...a,id:a.id||uid(),width,align,mode:'block'}),...parts]);
    if(parent.childCount===1){tr.replaceWith(parentPos,parentPos+parent.nodeSize,node);return parentPos;}
    tr.delete(image.pos,image.pos+1);const after=tr.mapping.map(parentPos+parent.nodeSize);tr.insert(after,node);return after;
  }
  // Текст на картинке: обычная картинка становится блоком «картинка + плашка»,
  // а у блока без плашки появляется пустая плашка.
  $('figure-text').onclick=()=>{
    const image=selectedImage();if(!image)return;
    const figure=figureOf(image);
    const overlay=schema.nodes.overlay.create({id:uid()},schema.nodes.paragraph.create({id:uid(),align:'center',indent:'0rem'}));
    let tr=view.state.tr, inside;
    if(figure){
      if(figure.overlay)return;
      // Плашка встает сразу после картинки, перед подписью.
      const target=figure.pos+1+figure.node.firstChild.nodeSize;tr.insert(target,overlay);inside=target+2;
    }else{
      const pos=wrapImage(tr,image,[overlay]);
      inside=pos+3+tr.doc.nodeAt(pos).firstChild.nodeSize; // вход в блок, картинка, вход в плашку и в абзац
    }
    finish(tr.setSelection(TextSelection.create(tr.doc,inside)).scrollIntoView());
  };
  // Подпись под картинкой: включается и выключается одной кнопкой.
  $('figure-caption').onclick=()=>{
    const image=selectedImage();if(!image)return;
    const figure=figureOf(image);
    let tr=view.state.tr;
    if(figure?.caption){
      const nodes=keepText(figure.caption);
      tr.delete(figure.caption.pos,figure.caption.pos+figure.caption.node.nodeSize);
      const unwrapped=unwrapBare(tr,figure.pos);
      const imagePos=unwrapped??image.pos;
      if(nodes.length)tr.insert(tr.doc.resolve(imagePos).after(),nodes);
      finish(tr.setSelection(NodeSelection.create(tr.doc,imagePos)));return;
    }
    const caption=schema.nodes.figcaption.create({id:uid()},schema.nodes.paragraph.create({id:uid(),kind:'caption'}));
    let inside;
    if(figure){const target=figure.pos+figure.node.nodeSize-1;tr.insert(target,caption);inside=target+2;}
    else{const pos=wrapImage(tr,image,[caption]);inside=pos+tr.doc.nodeAt(pos).nodeSize-3;}
    finish(tr.setSelection(TextSelection.create(tr.doc,inside)).scrollIntoView());
  };
  // Backspace в пустой плашке или пустой подписи убирает ее; блок без них снова становится обычной картинкой.
  function removeEmptyFigurePart(state,dispatch) {
    const {$from,empty}=state.selection;
    if(!empty||$from.depth<3||$from.parent.content.size)return false;
    const part=$from.node($from.depth-1);
    if(part.type!==schema.nodes.overlay&&part.type!==schema.nodes.figcaption||part.childCount!==1)return false;
    if(dispatch){
      const partPos=$from.before($from.depth-1), figurePos=$from.before($from.depth-2);
      const tr=state.tr.delete(partPos,partPos+part.nodeSize);
      const imagePos=unwrapBare(tr,figurePos)??figurePos+1;
      dispatch(closeHistory(tr.setSelection(NodeSelection.create(tr.doc,imagePos))).scrollIntoView());
    }
    return true;
  }
  $('detach-overlay').onclick=()=>{
    const overlay=overlayAt();if(!overlay)return;
    const nodes=keepText({node:overlay.node});
    const tr=view.state.tr.delete(overlay.pos,overlay.pos+overlay.node.nodeSize);
    // Блок без подписи сразу становится обычной картинкой: снова доступно любое обтекание.
    const unwrapped=unwrapBare(tr,overlay.figurePos);
    const imagePos=unwrapped??overlay.figurePos+1;
    const after=unwrapped!=null?tr.doc.resolve(unwrapped).after():overlay.figurePos+tr.doc.nodeAt(overlay.figurePos).nodeSize;
    if(nodes.length){tr.insert(after,nodes);finish(tr.setSelection(TextSelection.near(tr.doc.resolve(after+1))));}
    else finish(tr.setSelection(NodeSelection.create(tr.doc,imagePos)));
  };
  function overlayAttribute(name,value) {
    const overlay=overlayAt();if(!overlay)return;
    const next={...overlay.node.attrs,[name]:value};
    if(name==='x')next.width=Math.min(next.width,100-value);
    if(name==='width')next.x=Math.min(next.x,100-value);
    finish(view.state.tr.setNodeMarkup(overlay.pos,undefined,next));
  }
  numberControl('overlay-x',0,90,v=>overlayAttribute('x',Math.round(v)));
  numberControl('overlay-y',0,300,v=>overlayAttribute('y',Math.round(v)));
  numberControl('overlay-width',10,100,v=>overlayAttribute('width',Math.round(v)));
  $('typography-all').onclick=()=>{
    if(!view)return;
    const tr=retypeAll(view.state);
    if(!tr){notify('Неразрывные пробелы уже расставлены во всех абзацах.');return;}
    const count=tr.getMeta('typographyChanged');
    finish(tr);notify(`Проверена вся книга: неразрывные пробелы обновлены в ${count} абзацах.`);
  };
  for(const [id,kind]of [['short-divider','short'],['long-divider','long']])$(id).onclick=()=>{
    if(!view)return;
    captureNativeSelection();
    const rule=schema.nodes.rule.create({kind,id:uid()});
    const tr=view.state.tr.replaceSelectionWith(rule);
    let position;tr.doc.descendants((n,p)=>{if(n.attrs.id===rule.attrs.id)position=p;});
    if(position!==undefined){
      tr.insert(position+1,schema.nodes.paragraph.create({id:uid()}));
      tr.setSelection(TextSelection.create(tr.doc,position+2));
    }
    finish(tr.scrollIntoView());
  };
  async function upload(file) {
    if(!view)return;
    captureNativeSelection();
    if(file.size>8*1024*1024){notify('Максимальный размер изображения: 8 МБ.');return;}
    const pending={bookmark:view.state.selection.getBookmark()};uploads.add(pending);uploadCount++;
    status('Загрузка изображения…');
    try{
      const result=await api('images',{method:'POST',raw:file});
      if(!view)return;
      const node=schema.nodes.image.create({id:uid(),src:result.url,alt:file.name||'Иллюстрация',width:45,mode:'block',align:'center'});
      let selection;try{selection=pending.bookmark.resolve(view.state.doc);}catch{selection=view.state.selection;}
      let tr=view.state.tr.setSelection(selection).replaceSelectionWith(node,false);
      let imagePos;tr.doc.descendants((n,p)=>{if(n.attrs.id===node.attrs.id)imagePos=p;});
      if(imagePos!==undefined)tr.setSelection(NodeSelection.create(tr.doc,imagePos));
      finish(tr.scrollIntoView());
    }catch(e){status('Ошибка загрузки',true);notify(e.message,12000);}
    finally{uploads.delete(pending);uploadCount--;if(dirty){clearTimeout(timer);timer=setTimeout(save,300);}}
  }
  $('add-image').onclick=()=>{$('image-input').click();};
  $('image-input').onchange=e=>{const file=e.target.files[0];if(file)upload(file);e.target.value='';};
  $('editor-toolbar').addEventListener('mousedown',e=>{
    // Capture a just-finished native selection before an input takes focus.
    captureNativeSelection();
    if(e.target.closest('button'))e.preventDefault();
  });
  $('save-book').onclick=save;$('exit-editor').onclick=toggle;$('toggle-editor').onclick=toggle;
  const observer=new ResizeObserver(entries=>{
    const height=entries[0].target.getBoundingClientRect().height;
    if(height){
      document.documentElement.style.setProperty('--toolbar-height',`${Math.ceil(height)+12}px`);
      if(view)view.setProps({scrollMargin:{top:40,bottom:Math.ceil(height)+40},scrollThreshold:{top:40,bottom:Math.ceil(height)+40}});
    }
  });
  observer.observe($('editor-toolbar'));
  window.addEventListener('beforeunload',e=>{if(dirty||uploadCount){e.preventDefault();e.returnValue='';}});
  const cancelCrop=()=>{if(!cropping)return false;cropping.stop();view?.focus();return true;};
  return {toggle,save,cancelCrop,applyBookStyles:renderStyles,readDraft,clearDraft,get dirty(){return dirty;}};
}
