import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {bookDir,getBook,getNotes,json,transaction,regenerate,saveBook,readerPage,sharedData,notesFile,getBookmark} from './store.js';
import {parseFragment,resolveNote} from './document.js';
import {MAX_HTML,MAX_IMAGE,ID_PATTERN,READER_PATTERN} from '../shared/model.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ttf':'font/ttf','.woff2':'font/woff2','.json':'application/json'};
const token=process.env.EDITOR_TOKEN;
const testMode=process.env.TEST_MODE==='1';
const localOnly=process.env.LOCAL_ONLY==='1';
const port=Number(process.env.PORT||3000);
const localHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
const localOrigins=new Set([...localHosts].map(host=>`http://${host}`));
const fail=(status,message)=>Object.assign(new Error(message),{status});
async function body(req,max=MAX_HTML) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)throw fail(413,'Файл слишком большой.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
const readData=async req=>{try{return JSON.parse((await body(req)).toString());}catch(e){if(e.status)throw e;throw fail(400,'Неверный JSON.');}};
function editor(req) {
  if(testMode)return;
  const supplied=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,''));
  const expected=Buffer.from(token||'');
  if(!token||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw fail(401,'Для редактирования нужен ключ редактора.');
}
function readerId(req) {
  const id=req.headers['x-reader-id'];
  if(typeof id!=='string'||!READER_PATTERN.test(id))throw fail(400,'Некорректный идентификатор читателя.');
  return id;
}
await regenerate();
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  // Local no-password editing must not be reachable from unrelated websites.
  // Check Host as well as Origin to prevent DNS rebinding.
  if(localOnly&&(!localHosts.has(req.headers.host)||req.headers.origin&&!localOrigins.has(req.headers.origin))){
    res.writeHead(403,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({error:'Доступ разрешён только из локального IZDT.'}));return;
  }
  if(!localOnly)res.setHeader('Access-Control-Allow-Origin','*');
  else if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Reader-Id');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const url=new URL(req.url,'http://localhost');const route=decodeURIComponent(url.pathname);
    if(route==='/api/health')return send({ok:true,mode:testMode?'test':'protected',localOnly,sharedData});
    if(route==='/api/bookmark'&&sharedData){
      if(req.method==='GET')return send({bookmark:await getBookmark()});
      if(req.method==='PUT'){
        editor(req);const {bookmark}=await readData(req);
        if(bookmark!==null&&(!bookmark||!ID_PATTERN.test(bookmark.blockId)||!Number.isFinite(bookmark.offset)||Math.abs(bookmark.offset)>1e6||!Number.isFinite(bookmark.y)||bookmark.y<0||bookmark.y>1e9))throw fail(400,'Некорректная закладка.');
        const value=bookmark===null?null:{blockId:bookmark.blockId,offset:bookmark.offset,y:bookmark.y};
        return send(await transaction(async()=>{await json('bookmark.json',value);return {bookmark:value};}));
      }
    }
    if(route==='/api/book'&&req.method==='GET')return send(await getBook());
    if(route==='/api/book'&&req.method==='PUT'){
      editor(req); const data=await readData(req);
      if(typeof data.html!=='string'||!Number.isInteger(data.revision))throw fail(400,'Неверный формат книги.');
      return send(await transaction(()=>saveBook(data.html,data.revision)));
    }
    if(route==='/api/toc'&&req.method==='PUT'){
      editor(req);const data=await readData(req);
      if(!ID_PATTERN.test(data.id)||data.title!==undefined&&(typeof data.title!=='string'||data.title.length>500)||data.hidden!==undefined&&typeof data.hidden!=='boolean')throw fail(400,'Неверный пункт оглавления.');
      return send(await transaction(async()=>{
        const book=await getBook();
        if(!book.toc.some(t=>t.id===data.id))throw fail(404,'Пункт не найден.');
        if(data.reset)delete book.overrides[data.id];
        else book.overrides[data.id]={...(book.overrides[data.id]||{}),...(data.title!==undefined?{title:data.title}:{}),...(data.hidden!==undefined?{hidden:data.hidden}:{})};
        await json('toc-overrides.json',book.overrides);return regenerate();
      }));
    }
    if(route==='/api/reader'&&req.method==='GET')return send(await readerPage(readerId(req)));
    if(route==='/api/notes'&&req.method==='POST'){
      const reader=readerId(req), data=await readData(req);
      if(!ID_PATTERN.test(data.blockId)||!Number.isInteger(data.start)||data.start<0||typeof data.quote!=='string'||!data.quote.trim()||data.quote.length>20000)throw fail(400,'Некорректное выделение.');
      return send(await transaction(async()=>{
        const book=await getBook();
        if(data.revision!==book.revision)throw fail(409,'Текст книги изменился. Обновите страницу перед созданием заметки.');
        const note=resolveNote(parseFragment(book.html),{id:randomUUID(),blockId:data.blockId,start:data.start,quote:data.quote,createdAt:new Date().toISOString()});
        if(note.orphan)throw fail(409,'Фрагмент изменился. Выделите его заново.');
        const notes=await getNotes(reader);
        if(notes.length>=1000)throw fail(400,'Достигнут лимит 1000 заметок.');
        if(!notes.some(n=>n.blockId===note.blockId&&n.start===note.start&&n.quote===note.quote)){notes.push(note);await json(notesFile(reader),notes);}
        return readerPage(reader);
      }),201);
    }
    if(route==='/api/images'&&req.method==='POST'){
      editor(req);const buffer=await body(req,MAX_IMAGE);
      let ext='';
      if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))ext='png';
      else if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)ext='jpg';
      else if(/^GIF8[79]a/.test(buffer.subarray(0,6).toString()))ext='gif';
      else if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')ext='webp';
      if(!ext)throw fail(415,'Поддерживаются PNG, JPEG, WebP и GIF. SVG не допускается.');
      const name=`${randomUUID()}.${ext}`;await mkdir(path.join(bookDir,'img'),{recursive:true});await writeFile(path.join(bookDir,'img',name),buffer);
      return send({url:`/books/bees/img/${name}`},201);
    }
    if(route.startsWith('/api/'))throw fail(404,'Маршрут не найден.');
    if(!['GET','HEAD'].includes(req.method))throw fail(405,'Метод не поддерживается.');
    let file;
    if(route==='/'||route==='/index.html')file=path.join(bookDir,'generated/index.html');
    else if(/^\/books\/bees\/img\/[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp|gif)$/.test(route))file=path.join(bookDir,'img',path.basename(route));
    else {
      const base=route.startsWith('/shared/')?path.join(root,'shared'):path.join(root,'public');
      const relative=route.startsWith('/shared/')?route.slice(8):route.slice(1);
      file=path.resolve(base,relative);
      if(!file.startsWith(base+path.sep))throw fail(403,'Доступ запрещён.');
    }
    const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
  }catch(e){send({error:e.code==='ENOENT'?'Не найдено.':e.status?e.message:'Ошибка сервера.'},e.status|| (e.code==='ENOENT'?404:500));if(!e.status&&e.code!=='ENOENT')console.error(e);}
});
server.listen(port,localOnly?'127.0.0.1':process.env.HOST||'127.0.0.1',()=>console.log(`IZDT listening on ${port}; editor ${testMode?'TEST MODE':token?'protected':'disabled'}${localOnly?'; LOCAL ONLY':''}`));
