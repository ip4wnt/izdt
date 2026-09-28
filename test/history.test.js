import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// История книги: снимок не чаще раза в интервал, не больше N снимков, latest.html, rescue при 409, external при подмене файла.
test('history policy: interval snapshots, prune, latest.html, rescue and external copies',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'izdt-history-'));
  for(const file of ['content.html','meta.json','toc-overrides.json'])await cp(`data/books/bees/${file}`,path.join(dir,file));
  const history=path.join(dir,'history');
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:'3098',EDITOR_TOKEN:'t',TEST_MODE:'0',LOCAL_ONLY:'1',HISTORY_INTERVAL_MIN:'30',HISTORY_KEEP:'3'},stdio:'pipe'});
  let errors='';child.stderr.on('data',c=>errors+=c);
  const base='http://127.0.0.1:3098';
  const headers={'Content-Type':'application/json',Authorization:'Bearer t','X-Reader-Id':randomUUID()};
  const request=async(route,method='GET',data)=>{const res=await fetch(base+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,data:await res.json()};};
  const snapshots=async()=>(await readdir(history).catch(()=>[])).filter(n=>n!=='latest.html').sort();
  try{
    let ready=false;for(let i=0;i<60;i++){try{await fetch(base+'/api/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
    assert.ok(ready,errors);
    let book=(await request('/api/book')).data;
    assert.equal(book.externalChange,null);assert.equal(book.history.keep,3);
    const paragraph=n=>`<h1 id="t">Книга</h1><p id="p">Версия ${n}</p>`;
    // Пять сохранений подряд — один автоматический снимок (интервал 30 минут не истёк) и актуальный latest.html.
    for(let n=1;n<=5;n++){
      const saved=await request('/api/book','PUT',{html:paragraph(n),revision:book.revision});
      assert.equal(saved.status,200,JSON.stringify(saved.data));assert.deepEqual(saved.data.warnings,[]);
      book=saved.data;
    }
    assert.equal((await snapshots()).length,1);
    assert.match(await readFile(path.join(history,'latest.html'),'utf8'),/Версия 5/);
    assert.match(await readFile(path.join(dir,'content.html'),'utf8'),/Версия 5/);
    // Устаревшая ревизия: текст редактора не теряется, а ложится в rescue-снимок.
    const conflict=await request('/api/book','PUT',{html:paragraph('потерянная'),revision:book.revision-1});
    assert.equal(conflict.status,409);assert.match(conflict.data.error,/history\/\d+-\d+-rescue\.html/);
    const rescue=(await snapshots()).find(n=>n.endsWith('-rescue.html'));
    assert.match(await readFile(path.join(history,rescue),'utf8'),/Версия потерянная/);
    // Файл подменили извне (синхронизация): читалка сообщает об этом, при сохранении чужая версия уходит в external-снимок.
    await writeFile(path.join(dir,'content.html'),'<h1 id="t">Книга</h1><p id="p">Старый текст из облака</p>');
    assert.ok((await request('/api/book')).data.externalChange);
    const saved=await request('/api/book','PUT',{html:paragraph(6),revision:book.revision});
    assert.equal(saved.status,200);assert.equal(saved.data.warnings.length,1);assert.match(saved.data.warnings[0],/вне редактора/);
    const external=(await snapshots()).find(n=>n.endsWith('-external.html'));
    assert.match(await readFile(path.join(history,external),'utf8'),/Старый текст из облака/);
    assert.match(await readFile(path.join(dir,'content.html'),'utf8'),/Версия 6/);
    assert.equal((await request('/api/book')).data.externalChange,null);
    // Старые снимки удаляются: хранится не больше HISTORY_KEEP файлов.
    for(let i=0;i<4;i++)await request('/api/book','PUT',{html:paragraph('лишняя'),revision:book.revision-1});
    assert.ok((await snapshots()).length<=3);
    assert.equal(errors,'');
  }finally{child.kill();await rm(dir,{recursive:true,force:true});}
});
