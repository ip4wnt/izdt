import {EditorState, Plugin, TextSelection, NodeSelection} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {baseKeymap, toggleMark} from 'prosemirror-commands';
import {history, undo, redo, closeHistory} from 'prosemirror-history';
import {keymap} from 'prosemirror-keymap';
import {schema, parseDocument, serializeDocument, DEFAULTS, applyStyles, styleName, imageDOM} from './schema.js';
import {STYLE_KEYS, stylesCSS} from '../shared/model.js';
import {api, applyAssetURLs, notify, base} from '../public/js/api.js';
import {makeTOC} from '../shared/model.js';
import {typography, retypeAll} from './typography-plugin.js';

const $=id=>document.getElementById(id);
const uid=()=>`b-${crypto.randomUUID()}`;
const imageTypes=new Set(['image','figure_image']);
const controlIds=['text-style','font-family','font-size','line-height','text-indent','text-align'];
export function createEditor(state,book,panels) {
  let view=null, dirty=false, flight=null, timer=null, conflict=false, uploadCount=0;
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
    const $pos=view.state.doc.resolve(image.pos);
    return {node:$pos.parent,pos:$pos.before(),overlay:$pos.parent.childCount>1?$pos.parent.child(1):null};
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
    for(const id of ['image-wrap','image-align','image-width','image-alt','delete-image'])$(id).disabled=!image;
    $('image-wrap').disabled=!image||!!figure;
    $('figure-text').hidden=!image||!!figure?.overlay;
    $('image-selection-label').textContent=figure?'Картинка с текстом':image?'Изображение':'Выберите изображение';
    setControl('image-wrap',image?.node.attrs.mode||'block');
    setControl('image-align',image?.node.attrs.align||'center');
    setControl('image-width',image?.node.attrs.width||45);
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
  }
  async function save() {
    clearTimeout(timer);
    if(uploadCount){notify('Дождитесь загрузки изображения.');return false;}
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
          if(!dirty){state.toc=result.toc;status('Сохранено');}
        }catch(e){conflict=e.message.includes('другой вкладке');status('Не сохранено · повторите',true);notify(e.message,12000);return false;}
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
      const start=e.clientX,width=dom.getBoundingClientRect().width,container=dom.parentElement.getBoundingClientRect().width;
      let percent=current.attrs.width||45;
      const move=ev=>{percent=Math.min(100,Math.max(5,(width+ev.clientX-start)/container*100));dom.style.width=`${percent}%`;};
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
    return {dom,update(n){if(n.type!==current.type)return false;current=n;render();return true;},
      selectNode(){dom.classList.add('ProseMirror-selectednode');},
      deselectNode(){dom.classList.remove('ProseMirror-selectednode');},
      stopEvent:e=>e.target===handle,ignoreMutation:()=>true};
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
  async function toggle() {
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
    const doc=parseDocument(book);
    state.editing=true;document.body.classList.add('editing');book.setAttribute('spellcheck','true');$('editor-toolbar').hidden=false;$('toggle-editor').classList.add('active');
    view=new EditorView({mount:book},{
      state:EditorState.create({schema,doc,plugins:[
        history(),ids,typography,
        keymap({'Mod-z':undo,'Shift-Mod-z':redo,'Mod-y':redo,
          'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Mod-u':toggleMark(schema.marks.underline),
          'Mod-Home':(s,d)=>{d(s.tr.setSelection(TextSelection.atStart(s.doc)).scrollIntoView());return true;},
          'Mod-End':(s,d)=>{d(s.tr.setSelection(TextSelection.atEnd(s.doc)).scrollIntoView());return true;},
          'Shift-Enter':(s,d)=>{d(s.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());return true;}}),
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
    const next={...selected.node.attrs,...attributes};
    if(next.mode==='square'&&next.align==='center')next.align='left';
    const tr=view.state.tr.setNodeMarkup(selected.pos,undefined,next);
    finish(tr.setSelection(NodeSelection.create(tr.doc,selected.pos)));
  }
  $('image-wrap').onchange=e=>changeImage({mode:e.target.value});
  $('image-align').onchange=e=>{
    const image=selectedImage();if(!image)return;
    changeImage({align:e.target.value,...(image.node.attrs.mode==='square'&&e.target.value==='center'?{mode:'block'}:{})});
  };
  numberControl('image-width',5,100,v=>changeImage({width:v}));
  $('image-alt').onchange=e=>changeImage({alt:e.target.value});
  $('delete-image').onclick=()=>{
    const image=selectedImage();if(!image)return;
    const figure=figureOf(image);
    if(!figure){finish(view.state.tr.deleteSelection());return;}
    // Картинка с текстом: текст плашки остаётся в книге обычными абзацами.
    const nodes=[];figure.overlay?.forEach(child=>nodes.push(child));
    const tr=view.state.tr.replaceWith(figure.pos,figure.pos+figure.node.nodeSize,nodes.length?nodes:schema.nodes.paragraph.create({id:uid()}));
    finish(tr.setSelection(TextSelection.near(tr.doc.resolve(figure.pos))));
  };
  // Текст на картинке: обычная картинка становится блоком «картинка + плашка»,
  // а у блока без плашки появляется пустая плашка.
  $('figure-text').onclick=()=>{
    const image=selectedImage();if(!image)return;
    const figure=figureOf(image);
    const overlay=()=>schema.nodes.overlay.create({id:uid()},schema.nodes.paragraph.create({id:uid(),align:'center',indent:'0rem'}));
    let tr=view.state.tr, inside;
    if(figure){
      if(figure.overlay)return;
      const target=figure.pos+figure.node.nodeSize-1;tr.insert(target,overlay());inside=target+2;
    }else{
      const $pos=view.state.doc.resolve(image.pos), parent=$pos.parent, parentPos=$pos.before();
      const attrs={...image.node.attrs,id:uid(),width:image.node.attrs.width||45,mode:'block'};
      const node=schema.nodes.figure.create({id:uid()},[schema.nodes.figure_image.create(attrs),overlay()]);
      // Пустой абзац плашки лежит перед закрывающими границами плашки и блока: -3 от конца блока.
      if(parent.childCount===1){tr.replaceWith(parentPos,parentPos+parent.nodeSize,node);inside=parentPos+node.nodeSize-3;}
      else{tr.delete(image.pos,image.pos+1);const after=tr.mapping.map(parentPos+parent.nodeSize);tr.insert(after,node);inside=after+node.nodeSize-3;}
    }
    finish(tr.setSelection(TextSelection.create(tr.doc,inside)).scrollIntoView());
  };
  $('detach-overlay').onclick=()=>{
    const overlay=overlayAt();if(!overlay)return;
    const nodes=[];overlay.node.forEach(child=>nodes.push(child));
    const tr=view.state.tr.delete(overlay.pos,overlay.pos+overlay.node.nodeSize);
    const after=tr.mapping.map(overlay.figurePos+overlay.figure.nodeSize);
    tr.insert(after,nodes);
    finish(tr.setSelection(TextSelection.near(tr.doc.resolve(after+1))));
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
  return {toggle,save,applyBookStyles:renderStyles,get dirty(){return dirty;}};
}
