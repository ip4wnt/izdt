import {api,applyAssetURLs,cleanHTML,notify} from './api.js';
import {makeTOC} from '../shared/model.js';
const $=id=>document.getElementById(id);
export function createEditor(state,book,panels){
  let savedRange=null,selectedImage=null,timer=null,pending=false,flight=null,dirty=false,lastHTML='';
  let conflict=false;
  const status=(text,error=false)=>{$('save-status').textContent=text;$('save-status').classList.toggle('error',error);};
  function remember(){
    const selection=getSelection();
    if(selection.rangeCount&&book.contains(selection.anchorNode))savedRange=selection.getRangeAt(0).cloneRange();
  }
  function restore(){
    book.focus();if(savedRange&&book.contains(savedRange.commonAncestorContainer)){getSelection().removeAllRanges();getSelection().addRange(savedRange);}
  }
  function ensureIDs(){
    const seen=new Set();
    for(const el of book.querySelectorAll('[id],p,h1,h2,h3,li,blockquote,[data-style="paragraph"]')){
      if(!el.id||seen.has(el.id))el.id=`b-${crypto.randomUUID()}`;
      seen.add(el.id);
    }
  }
  function changed(){
    ensureIDs();dirty=true;pending=true;status('Не сохранено');
    state.toc=makeTOC(book,state.overrides);if(panels.mode)panels.render();
    clearTimeout(timer);if(!conflict)timer=setTimeout(()=>save(),900);
  }
  async function save(){
    clearTimeout(timer);
    if(flight){pending=true;return flight;}
    if(!dirty)return true;
    flight=(async()=>{
      do{
        pending=false;
        const html=cleanHTML(book);
        try{
          status('Сохранение…');
          const result=await api('book',{method:'PUT',data:{html,revision:state.revision}});
          state.revision=result.revision;state.overrides=result.overrides;lastHTML=html;
          dirty=cleanHTML(book)!==html;
          if(!dirty){state.toc=result.toc;status('Сохранено');}
          conflict=false;
        }catch(e){
          conflict=e.message.includes('другой вкладке');status('Не сохранено · повторите',true);notify(e.message,12000);return false;
        }
      }while(pending&&dirty);
      return !dirty;
    })();
    try{return await flight;}finally{flight=null;}
  }
  async function toggle(){
    if(state.editing){
      if(!(await save()))return;
      state.editing=false;book.contentEditable='false';document.body.classList.remove('editing');
      $('editor-toolbar').hidden=true;$('format-popover').hidden=true;$('toggle-editor').classList.remove('active');
      book.querySelectorAll('.selected-image').forEach(el=>el.classList.remove('selected-image'));
      try{const result=await api('reader');state.notes=result.notes;book.innerHTML=result.content;applyAssetURLs(book);panels.render();}catch(e){notify(e.message);}
      return;
    }
    panels.close();
    for(const mark of book.querySelectorAll('mark'))mark.replaceWith(...mark.childNodes);
    state.editing=true;document.body.classList.add('editing');book.contentEditable='true';
    $('editor-toolbar').hidden=false;$('toggle-editor').classList.add('active');
    lastHTML=cleanHTML(book);status('Сохранено');dirty=false;book.focus({preventScroll:true});
  }
  function currentBlock(){
    let node=getSelection().anchorNode;
    if(node?.nodeType===3)node=node.parentElement;
    const block=node?.closest('p,h1,h2,h3,li,blockquote');
    return book.contains(block)?block:null;
  }
  function command(name,value){
    restore();document.execCommand(name,false,value);remember();changed();
  }
  book.addEventListener('input',changed);
  document.addEventListener('selectionchange',()=>{if(state.editing)remember();});
  $('editor-toolbar').addEventListener('pointerdown',remember);
  $('editor-toolbar').addEventListener('mousedown',e=>{remember();if(e.target.closest('button'))e.preventDefault();});
  book.addEventListener('keyup',remember);
  book.addEventListener('pointerup',remember);
  $('format-popover').addEventListener('mousedown',()=>remember());
  for(const button of document.querySelectorAll('[data-command]'))button.onclick=()=>command(button.dataset.command);
  $('text-style').onchange=e=>{
    restore();const type=e.target.value;
    if(type==='paragraph'){
      const selection=getSelection();
      if(!selection.isCollapsed&&selection.rangeCount){
        const range=selection.getRangeAt(0);
        const start=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer;
        const end=range.endContainer.nodeType===3?range.endContainer.parentElement:range.endContainer;
        if(start.closest('p,h1,h2,h3')!==end.closest('p,h1,h2,h3')){notify('Для пункта-параграфа выделите текст внутри одного абзаца.');return;}
        const span=document.createElement('span');span.dataset.style='paragraph';span.id=`b-${crypto.randomUUID()}`;span.append(range.extractContents());range.insertNode(span);
      }else{
        const block=currentBlock();if(block)block.dataset.style='paragraph';
      }
    }else{
      const old=currentBlock(),id=old?.id;document.execCommand('formatBlock',false,type==='small'?'p':type);
      const block=currentBlock();if(block){if(id)block.id=id;delete block.dataset.style;block.classList.toggle('small',type==='small');}
    }
    remember();changed();
  };
  $('text-align').onchange=e=>{restore();const block=currentBlock();if(block){block.style.textAlign=e.target.value;changed();}};
  $('more-format').onclick=()=>{$('format-popover').hidden=!$('format-popover').hidden;};
  $('format-popover').onsubmit=e=>{
    e.preventDefault();restore();const block=currentBlock();
    if(block){
      block.style.fontSize=`${$('font-size').value}rem`;
      block.style.lineHeight=`${$('line-height').value}rem`;
      block.style.textIndent=`${$('text-indent').value}rem`;
      block.style.fontFamily=$('font-family').value;
    }
    if(selectedImage&&book.contains(selectedImage)){
      selectedImage.classList.remove('wrap-left','wrap-right','wrap-block','wrap-inline');
      selectedImage.classList.add($('image-wrap').value);selectedImage.style.width=`${$('image-width').value}%`;
    }
    $('format-popover').hidden=true;changed();
  };
  for(const [button,cls]of [['short-divider','divider-short'],['long-divider','divider-long']]){
    $(button).onclick=()=>command('insertHTML',`<hr class="${cls}"><p id="b-${crypto.randomUUID()}"><br></p>`);
  }
  async function upload(file){
    if(file.size>8*1024*1024){notify('Максимальный размер изображения: 8 МБ.');return;}
    const range=savedRange?.cloneRange();
    try{
      status('Загрузка изображения…');const result=await api('images',{method:'POST',raw:file});
      if(!state.editing)return;
      savedRange=range;restore();
      const img=document.createElement('img');img.src=result.url;img.alt=file.name==='image.png'?'Иллюстрация':file.name;img.className='wrap-block';
      applyAssetURLs({querySelectorAll:()=>[img]});
      const selection=getSelection();const insertion=selection.rangeCount?selection.getRangeAt(0):null;
      if(insertion&&book.contains(insertion.commonAncestorContainer)){insertion.collapse(false);insertion.insertNode(img);insertion.setStartAfter(img);insertion.collapse(true);selection.removeAllRanges();selection.addRange(insertion);}else book.append(img);
      remember();changed();
    }catch(e){status('Ошибка загрузки',true);notify(e.message,12000);}
  }
  $('add-image').onclick=()=>{$('image-input').click();};
  $('image-input').onchange=e=>{const file=e.target.files[0];if(file)upload(file);e.target.value='';};
  book.addEventListener('click',e=>{
    if(!state.editing)return;
    book.querySelectorAll('.selected-image').forEach(el=>el.classList.remove('selected-image'));
    selectedImage=e.target.tagName==='IMG'?e.target:null;
    if(selectedImage){selectedImage.classList.add('selected-image');notify('Картинка выбрана. Обтекание и ширина: «Параметры текста».',4000);}
  });
  book.addEventListener('paste',e=>{
    if(!state.editing)return;e.preventDefault();
    const item=[...e.clipboardData.items].find(i=>i.type.startsWith('image/'));
    if(item){remember();upload(item.getAsFile());return;}
    document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));changed();
  });
  book.addEventListener('drop',e=>{if(state.editing){e.preventDefault();const file=e.dataTransfer.files[0];if(file?.type.startsWith('image/'))upload(file);}});
  $('save-book').onclick=save;$('exit-editor').onclick=toggle;$('toggle-editor').onclick=toggle;
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  return {toggle,save,get dirty(){return dirty;}};
}
