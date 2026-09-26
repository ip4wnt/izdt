import {readFile,writeFile,mkdir,rename,copyFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalize,makeTOC,annotate} from './document.js';
import {sanitizeStyles} from '../shared/model.js';
import {pageHTML} from './template.js';
import {fillImageSizes} from './image-size.js';

export const bookDir = path.resolve(process.env.DATA_DIR || 'data/books/bees');
export const sharedData = process.env.LOCAL_ONLY==='1' && process.env.SHARED_DATA==='1';
const readJSON = async (file, fallback) => {
  try { return JSON.parse(await readFile(path.join(bookDir,file),'utf8')); }
  catch(e) { if(e.code==='ENOENT') return fallback; throw e; }
};
export async function atomic(file, value) {
  const destination=path.join(bookDir,file);
  await mkdir(path.dirname(destination),{recursive:true});
  const tmp=`${destination}.${randomUUID()}.tmp`;
  await writeFile(tmp,value); await rename(tmp,destination);
}
export const json = (file,data) => atomic(file,JSON.stringify(data,null,2)+'\n');
let queue=Promise.resolve();
export function transaction(fn) {
  const next=queue.then(fn); queue=next.catch(()=>{}); return next;
}
export async function getBook() {
  const html=await readFile(path.join(bookDir,'content.html'),'utf8');
  const meta=await readJSON('meta.json',{revision:0,title:'Полный курс пчеловодства'});
  const overrides=await readJSON('toc-overrides.json',{});
  const styles=sanitizeStyles(await readJSON('styles.json',{}));
  const {root}=normalize(html);
  // Старые картинки без width/height получают размеры из файлов при выдаче; в content.html они попадут при следующем сохранении.
  const sized=await fillImageSizes(root,bookDir);
  return {html:sized?root.innerHTML:html,...meta,overrides,styles,toc:makeTOC(root,overrides),sharedData};
}
export async function getNotes(reader) {
  if(!sharedData)return readJSON(`readers/${reader}/notes.json`,[]);
  // Legacy reader files remain intact; merge them into the common local book.
  const notes=await readJSON('notes.json',[]);
  let directories=[];
  try{directories=await readdir(path.join(bookDir,'readers'),{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  const byId=new Map();
  for(const entry of directories.filter(d=>d.isDirectory()&&/^[0-9a-f-]{36}$/.test(d.name)).sort((a,b)=>a.name.localeCompare(b.name))){
    for(const note of await readJSON(`readers/${entry.name}/notes.json`,[]))byId.set(note.id,note);
  }
  for(const note of notes)byId.set(note.id,note);
  // Удалённые заметки помечаются в notes-deleted.json: старые файлы читателей остаются нетронутыми.
  for(const id of await readJSON('notes-deleted.json',[]))byId.delete(id);
  return [...byId.values()];
}
export async function deleteNote(reader,id) {
  const notes=await getNotes(reader);
  if(!notes.some(n=>n.id===id))return false;
  await json(notesFile(reader),notes.filter(n=>n.id!==id));
  if(sharedData){const deleted=await readJSON('notes-deleted.json',[]);if(!deleted.includes(id)){deleted.push(id);await json('notes-deleted.json',deleted);}}
  return true;
}
export const notesFile = reader => sharedData?'notes.json':`readers/${reader}/notes.json`;
export const getBookmark = () => readJSON('bookmark.json',null);
export async function regenerate() {
  const book=await getBook();
  await json('toc.json',book.toc);
  await atomic('generated/index.html',pageHTML(book));
  return book;
}
export async function saveBook(html,revision) {
  const previous=await getBook();
  if(revision!==previous.revision) throw Object.assign(new Error('Книга изменена в другой вкладке. Скопируйте свои правки и обновите страницу.'),{status:409});
  const normalized=normalize(html);
  await fillImageSizes(normalized.root,bookDir);normalized.html=normalized.root.innerHTML;
  if(!normalized.root.textContent.trim()) throw Object.assign(new Error('Книга не может быть пустой.'),{status:400});
  await mkdir(path.join(bookDir,'history'),{recursive:true});
  await copyFile(path.join(bookDir,'content.html'),path.join(bookDir,'history',`${previous.revision}-${Date.now()}.html`));
  await atomic('content.html',normalized.html);
  await json('meta.json',{title:previous.title,revision:previous.revision+1});
  return regenerate();
}
export async function readerPage(reader) {
  const book=await getBook();
  const rendered=annotate(book.html,await getNotes(reader));
  const html=pageHTML({...book,html:rendered.html,notes:rendered.notes});
  await atomic(`readers/${reader}/index.html`,html);
  return {html,notes:rendered.notes,content:rendered.html};
}
