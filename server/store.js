import {readFile,writeFile,mkdir,rename,copyFile,readdir,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
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
  await writeFile(tmp,value);
  // В Windows файл бывает на секунду занят антивирусом или клиентом синхронизации: повторяем переименование, а не оставляем .tmp в папке.
  for(let attempt=0;;attempt++){
    try{await rename(tmp,destination);return;}
    catch(e){
      if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes(e.code)){await unlink(tmp).catch(()=>{});throw e;}
      await new Promise(r=>setTimeout(r,120*(attempt+1)));
    }
  }
}
// История книги. Снимок предыдущего состояния делается не чаще одного раза за HISTORY_INTERVAL минут,
// хранится не более HISTORY_KEEP снимков; history/latest.html всегда равен последнему сохранению редактора.
export const historyDir=path.join(bookDir,'history');
export const historyPolicy={intervalMs:Number(process.env.HISTORY_INTERVAL_MIN||30)*60*1000,keep:Number(process.env.HISTORY_KEEP||50)};
const hash=value=>createHash('sha256').update(value).digest('hex');
const snapshotName=/^(\d+)-(\d+)(-[a-z]+)?\.html$/;
export async function listSnapshots() {
  let files=[];try{files=await readdir(historyDir);}catch(e){if(e.code!=='ENOENT')throw e;}
  return files.map(name=>{const m=snapshotName.exec(name);return m&&{name,revision:Number(m[1]),time:Number(m[2]),kind:m[3]?m[3].slice(1):'auto'};}).filter(Boolean).sort((a,b)=>a.time-b.time);
}
export async function snapshot(html,revision,kind='') {
  await mkdir(historyDir,{recursive:true});
  const name=`${revision}-${Date.now()}${kind?`-${kind}`:''}.html`;
  await writeFile(path.join(historyDir,name),html);
  await pruneSnapshots();
  return name;
}
export async function pruneSnapshots(keep=historyPolicy.keep) {
  const snapshots=await listSnapshots();
  const extra=snapshots.slice(0,Math.max(0,snapshots.length-keep));
  for(const {name} of extra)await unlink(path.join(historyDir,name)).catch(()=>{});
  return extra.length;
}
// Изменён ли content.html вне редактора: сравниваем с history/latest.html — копией последнего сохранения.
export async function externalChange(html) {
  let latest;try{latest=await readFile(path.join(historyDir,'latest.html'),'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(hash(latest)===hash(html))return null;
  const {mtime}=await stat(path.join(bookDir,'content.html'));
  return {latest,modifiedAt:mtime.toISOString()};
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
  const external=await externalChange(html);
  return {html:sized?root.innerHTML:html,...meta,overrides,styles,toc:makeTOC(root,overrides),sharedData,externalChange:external?external.modifiedAt:null,history:historyPolicy};
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
  const onDisk=await readFile(path.join(bookDir,'content.html'),'utf8');
  if(revision!==previous.revision) {
    // Текст редактора не пропадает: он ложится в history как rescue-снимок, о чём говорит сообщение.
    const rescue=await snapshot(html,revision,'rescue');
    throw Object.assign(new Error(`Книга изменена в другой вкладке или файл content.html заменён извне (синхронизация, git). Ваш текст сохранён в history/${rescue}. Обновите страницу.`),{status:409});
  }
  const normalized=normalize(html);
  await fillImageSizes(normalized.root,bookDir);normalized.html=normalized.root.innerHTML;
  if(!normalized.root.textContent.trim()) throw Object.assign(new Error('Книга не может быть пустой.'),{status:400});
  const warnings=[];
  const external=await externalChange(onDisk);
  if(external){
    // Файл на диске подменили вне редактора: его версия уходит в снимок, а побеждает текст редактора.
    const name=await snapshot(onDisk,previous.revision,'external');
    warnings.push(`Файл content.html был изменён вне редактора (${new Date(external.modifiedAt).toLocaleString('ru-RU')}). Эта версия сохранена в history/${name}; в книге остаётся текст редактора.`);
  }
  const snapshots=await listSnapshots();
  const newest=snapshots.filter(s=>s.kind==='auto').at(-1);
  if(!newest||Date.now()-newest.time>=historyPolicy.intervalMs)await snapshot(onDisk,previous.revision);
  await atomic('content.html',normalized.html);
  await mkdir(historyDir,{recursive:true});await atomic('history/latest.html',normalized.html);
  await json('meta.json',{title:previous.title,revision:previous.revision+1});
  return {...await regenerate(),warnings};
}
export async function readerPage(reader) {
  const book=await getBook();
  const rendered=annotate(book.html,await getNotes(reader));
  const html=pageHTML({...book,html:rendered.html,notes:rendered.notes});
  await atomic(`readers/${reader}/index.html`,html);
  return {html,notes:rendered.notes,content:rendered.html};
}
