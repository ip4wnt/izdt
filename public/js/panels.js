import {api,notify,applyAssetURLs} from './api.js';
const $=id=>document.getElementById(id);
export function createPanels(state,book){
  let mode=null,tocEdit=false;
  const panel=$('panel'),content=$('panel-content');
  const go=id=>{
    const el=document.getElementById(id);if(!el)return;
    el.scrollIntoView({behavior:'smooth',block:'start'});
    el.classList.remove('note-flash');requestAnimationFrame(()=>el.classList.add('note-flash'));
  };
  async function override(data){
    try{const result=await api('toc',{method:'PUT',data});state.toc=result.toc;state.overrides=result.overrides;render();}
    catch(e){notify(e.message,12000);}
  }
  function renderTOC(){
    for(const item of state.toc){
      if(item.hidden&&!tocEdit)continue;
      const row=document.createElement('div');row.className=`toc-row level-${item.level}${item.hidden?' is-hidden':''}${item.manual?' is-manual':''}`;
      if(item.level===3){const number=document.createElement('span');number.className='toc-number';number.textContent=item.number?`§ ${item.number}.`:'';row.append(number);}
      if(tocEdit){
        const input=document.createElement('input');input.value=item.title;input.setAttribute('aria-label',`Название: ${item.autoTitle}`);input.maxLength=500;
        input.onchange=()=>override({id:item.id,title:input.value});row.append(input);
        const actions=document.createElement('div');actions.className='toc-actions';
        for(const [text,title,action] of [
          [item.hidden?'＋':'−',item.hidden?'Показать пункт':'Скрыть пункт',()=>override({id:item.id,hidden:!item.hidden})],
          ['↶','Сбросить ручную правку',()=>override({id:item.id,reset:true})]
        ]){const button=document.createElement('button');button.textContent=text;button.title=title;button.setAttribute('aria-label',`${title}: ${item.autoTitle}`);button.onclick=action;actions.append(button);}
        row.append(actions);
      }else{
        const link=document.createElement('a');link.href=`#${item.id}`;link.textContent=item.title;link.onclick=e=>{e.preventDefault();go(item.id);};row.append(link);
        if(item.level===3)link.classList.add('toc-title');
      }
      content.append(row);
    }
    if(tocEdit){
      const hint=document.createElement('p');hint.className='panel-hint';hint.textContent='Правки сохраняются после выхода из поля. − скрывает пункт, ↶ возвращает автоматическое название. Скрытые пункты видны только здесь.';content.append(hint);
    }
  }
  function renderNotes(){
    if(!state.notes.length){
      content.innerHTML='<div class="empty-notes"><h3>Важное остаётся на полях.</h3><p>Выделите фрагмент книги и нажмите «В заметки». Здесь появятся ваши цитаты, собранные по частям и главам.</p></div>';return;
    }
    let last='',group;
    for(const note of state.notes){
      const key=`${note.part}|${note.chapter}`;
      if(key!==last||!group){
        group=document.createElement('section');group.className='note-group';
        for(const [cls,text] of [['note-part',note.part],['note-chapter',note.chapter]]){
          const heading=document.createElement('h3');heading.className=cls;heading.textContent=text;group.append(heading);
        }
        content.append(group);last=key;
      }
      const button=document.createElement('button');button.className='note-link';button.textContent=note.quote;
      button.onclick=()=>{go(note.blockId);const mark=book.querySelector(`[data-notes~="${note.id}"]`);if(mark)mark.scrollIntoView({behavior:'smooth',block:'center'});};
      const row=document.createElement('div');row.className='note-row';row.append(button);
      const remove=document.createElement('button');remove.className='note-delete';remove.title='Удалить заметку';remove.setAttribute('aria-label',`Удалить заметку: ${note.quote.slice(0,60)}`);
      remove.innerHTML='<img src="./assets/icons/x.svg" alt="" width="18" height="18">';
      remove.onclick=async()=>{
        try{const result=await api(`notes/${note.id}`,{method:'DELETE'});state.notes=result.notes;book.innerHTML=result.content;applyAssetURLs(book);render();notify('Заметка удалена.');}
        catch(e){notify(e.message,12000);}
      };
      row.append(remove);group.append(row);
      if(note.orphan){const label=document.createElement('p');label.className='orphan-label';label.textContent='Исходный фрагмент изменён. Цитата сохранена.';group.append(label);}
    }
  }
  function render(){
    content.replaceChildren();$('panel-title').textContent=mode==='notes'?'ЗАМЕТКИ':'ОГЛАВЛЕНИЕ.';
    $('edit-toc').hidden=mode!=='toc';$('edit-toc').classList.toggle('active',tocEdit);
    if(mode==='notes')renderNotes();else renderTOC();
  }
  function toggle(next){
    mode=mode===next?null:next;
    document.body.classList.toggle('panel-open',!!mode);panel.inert=!mode;
    for(const type of ['toc','notes']){$(`toggle-${type}`).classList.toggle('active',mode===type);$(`toggle-${type}`).setAttribute('aria-expanded',mode===type);}
    if(mode)render();
  }
  $('toggle-toc').onclick=()=>toggle('toc');$('toggle-notes').onclick=()=>toggle('notes');
  $('close-panel').onclick=()=>{const previous=mode;toggle(mode);$(`toggle-${previous}`).focus();};
  $('edit-toc').onclick=()=>{tocEdit=!tocEdit;render();};
  return {toggle,render,close(){if(mode)toggle(mode);},get mode(){return mode;}};
}
