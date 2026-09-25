export const initial=JSON.parse(document.getElementById('initial-state').textContent);
export const base=initial.apiBase||'';
let editorKey='';
let reader;
export const storage={
  get(key){try{return localStorage.getItem(key);}catch{return null;}},
  set(key,value){try{localStorage.setItem(key,value);return true;}catch{return false;}},
  remove(key){try{localStorage.removeItem(key);}catch{}}
};
reader=storage.get('izdt:reader');
if(!/^[0-9a-f-]{36}$/.test(reader||'')){reader=crypto.randomUUID();storage.set('izdt:reader',reader);}
export const persistent=storage.get('izdt:reader')===reader;
export function notify(message, timeout=6000){
  const box=document.getElementById('notice');box.textContent=message;box.hidden=false;
  clearTimeout(notify.timer);if(timeout)notify.timer=setTimeout(()=>box.hidden=true,timeout);
}
export async function api(route,{method='GET',data,raw}={}){
  const headers={'X-Reader-Id':reader};
  if(data!==undefined)headers['Content-Type']='application/json';
  if(editorKey)headers.Authorization=`Bearer ${editorKey}`;
  let response;
  try{response=await fetch(`${base}/api/${route}`,{method,headers,body:raw??(data!==undefined?JSON.stringify(data):undefined)});}
  catch{throw new Error('Сервер недоступен. Изменения остаются в редакторе; попробуйте сохранить ещё раз.');}
  if(response.status===401){
    const key=prompt('Ключ редактора (хранится только до закрытия вкладки):');
    if(key){editorKey=key;return api(route,{method,data,raw});}
  }
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||`Ошибка ${response.status}`);
  return result;
}
export function applyAssetURLs(root){
  for(const img of root.querySelectorAll('img[src^="/books/"]'))img.src=base+img.getAttribute('src');
}
export function cleanHTML(root){
  const clone=root.cloneNode(true);
  for(const mark of clone.querySelectorAll('mark'))mark.replaceWith(...mark.childNodes);
  for(const node of clone.querySelectorAll('.selected-image,.note-flash'))node.classList.remove('selected-image','note-flash');
  for(const img of clone.querySelectorAll('img')){
    const src=img.getAttribute('src'), index=src.indexOf('/books/bees/img/');
    if(index>=0)img.setAttribute('src',src.slice(index));
  }
  return clone.innerHTML;
}
