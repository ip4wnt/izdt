import {storage,notify} from './api.js';
export function initBookmark(book){
  const ribbon=document.getElementById('bookmark-ribbon'),key='izdt:bees:bookmark';
  let current=null,busy=false;
  try{current=JSON.parse(storage.get(key));}catch{}
  const reveal=()=>{ribbon.hidden=false;requestAnimationFrame(()=>requestAnimationFrame(()=>ribbon.classList.remove('gone')));};
  const leave=async()=>{ribbon.classList.add('gone');await new Promise(r=>setTimeout(r,550));ribbon.hidden=true;};
  if(current)reveal();
  document.getElementById('set-bookmark').onclick=async()=>{
    if(busy)return;busy=true;
    const blocks=[...book.querySelectorAll('h1,h2,h3,p,li')];
    const anchor=blocks.find(el=>el.getBoundingClientRect().bottom>100)||blocks.at(-1);
    const next={blockId:anchor?.id,offset:anchor?anchor.getBoundingClientRect().top:0,y:window.scrollY};
    if(current)await leave();
    current=next;const saved=storage.set(key,JSON.stringify(current));reveal();busy=false;
    notify(saved?'Закладка установлена. Нажмите на ленту, чтобы вернуться.':'Закладка установлена на время этой вкладки: браузер запретил localStorage.');
  };
  ribbon.onclick=async()=>{
    if(!current||busy)return;busy=true;
    const el=document.getElementById(current.blockId);
    window.scrollTo({top:el?window.scrollY+el.getBoundingClientRect().top-current.offset:current.y,behavior:'smooth'});
    current=null;storage.remove(key);await leave();busy=false;
  };
}
