import {initial,api,notify,persistent,applyAssetURLs} from './api.js';
import {createPanels} from './panels.js';
import {createEditor} from './editor.js';
import {initNotes} from './notes.js';
import {initBookmark} from './bookmark.js';
const book=document.getElementById('book');
const state={...initial,editing:false};
applyAssetURLs(book);
const panels=createPanels(state,book);
const editor=createEditor(state,book,panels);
initNotes(state,book,panels);
initBookmark(book);
document.getElementById('toggle-theme').onclick=()=>{
  document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
};
const help=document.getElementById('help');
document.getElementById('show-help').onclick=()=>help.showModal();
help.querySelector('.dialog-close').onclick=()=>help.close();
document.addEventListener('keydown',e=>{
  if(help.open)return;
  if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'&&state.editing){e.preventDefault();editor.save();return;}
  if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.code==='KeyE'){e.preventDefault();editor.toggle();return;}
  if(e.key==='Escape'){
    document.getElementById('selection-note').hidden=true;
    if(state.editing){e.preventDefault();editor.toggle();}else panels.close();
    return;
  }
  const target=e.target;
  if(target.isContentEditable||target.closest('input,textarea,select')||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.code==='KeyB'){e.preventDefault();panels.toggle('notes');}
  else if(e.code==='KeyC'){e.preventDefault();panels.toggle('toc');}
});
// Restore current book before reader-specific annotations. Static HTML remains readable without JS.
try{
  const latest=await api('book');
  if(!state.editing){
    Object.assign(state,{revision:latest.revision,toc:latest.toc,overrides:latest.overrides,styles:latest.styles||{}});editor.applyBookStyles();
    book.innerHTML=latest.html;applyAssetURLs(book);
    const reader=await api('reader');
    if(!state.editing){state.notes=reader.notes;book.innerHTML=reader.content;applyAssetURLs(book);panels.render();}
  }
}catch(e){notify('Открыта статичная копия книги. '+e.message,12000);}
if(!persistent)notify(initial.sharedData
  ?'Браузер запретил localStorage. Общие заметки и закладка по-прежнему сохраняются в папке книги.'
  :'Браузер запретил localStorage: доступ к заметкам привязан к этой вкладке, закладка не переживёт её закрытие.',12000);
