import {storage,notify,api,initial} from './api.js';
export function initBookmark(book){
  const ribbon=document.getElementById('bookmark-ribbon'),key='izdt:bees:bookmark';
  let current=null,busy=false;
  try{current=JSON.parse(storage.get(key));}catch{}
  const reveal=()=>{ribbon.hidden=false;requestAnimationFrame(()=>requestAnimationFrame(()=>ribbon.classList.remove('gone')));};
  const leave=async()=>{ribbon.classList.add('gone');await new Promise(r=>setTimeout(r,550));ribbon.hidden=true;};
  const persist=async value=>{
    if(initial.sharedData){
      await api('bookmark',{method:'PUT',data:{bookmark:value}});
      storage.remove(key);return true;
    }
    if(value===null){storage.remove(key);return true;}
    return storage.set(key,JSON.stringify(value));
  };
  if(initial.sharedData){
    busy=true;
    api('bookmark').then(async result=>{
      if(result.bookmark)current=result.bookmark;
      else if(current)await persist(current); // One-time migration of the old browser bookmark.
      storage.remove(key);if(current)reveal();
    }).catch(e=>notify('Не удалось загрузить общую закладку. '+e.message)).finally(()=>busy=false);
  }else if(current)reveal();
  document.getElementById('set-bookmark').onclick=async()=>{
    if(busy)return;busy=true;
    const blocks=[...book.querySelectorAll('h1,h2,h3,p,li')];
    const anchor=blocks.find(el=>el.getBoundingClientRect().bottom>100)||blocks.at(-1);
    const next={blockId:anchor?.id,offset:anchor?anchor.getBoundingClientRect().top:0,y:window.scrollY};
    try{
      const saved=await persist(next);
      if(current)await leave();
      current=next;reveal();
      notify(saved?'Закладка установлена. Нажмите на ленту, чтобы вернуться.':'Закладка установлена на время этой вкладки: браузер запретил localStorage.');
    }catch(e){notify('Закладка не сохранена. '+e.message);}
    finally{busy=false;}
  };
  ribbon.onclick=async()=>{
    if(!current||busy)return;busy=true;
    try{
      await persist(null);
      const el=document.getElementById(current.blockId);
      window.scrollTo({top:el?window.scrollY+el.getBoundingClientRect().top-current.offset:current.y,behavior:'smooth'});
      current=null;await leave();
    }catch(e){notify('Не удалось снять закладку. '+e.message);}
    finally{busy=false;}
  };
}
