import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import http from 'node:http';

test('file-backed API: content, TOC, notes, isolation, conflicts, image validation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'izdt-test-'));
  for(const file of ['content.html','meta.json','toc-overrides.json'])await cp(`data/books/bees/${file}`,path.join(dir,file));
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:'3099',EDITOR_TOKEN:'integration-test-token',TEST_MODE:'0',LOCAL_ONLY:'1'},stdio:'pipe'});
  let errors='';child.stderr.on('data',c=>errors+=c);
  const base='http://127.0.0.1:3099';
  const headers={'Content-Type':'application/json',Authorization:'Bearer integration-test-token','X-Reader-Id':randomUUID()};
  const request=async(route,method='GET',data,extra={})=>{
    const res=await fetch(base+route,{method,headers:{...headers,...extra},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:res.status,data:await res.json()};
  };
  try{
    let ready=false;
    for(let i=0;i<60;i++){
      try{await fetch(base+'/api/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}
    }
    assert.ok(ready,errors);
    assert.equal((await fetch(base+'/api/health')).headers.get('access-control-allow-origin'),null);
    assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://unrelated.example'}})).status,403);
    assert.equal((await fetch(base+'/api/book',{method:'OPTIONS',headers:{Origin:'https://unrelated.example'}})).status,403);
    const reboundStatus=await new Promise((resolve,reject)=>{
      http.get(base+'/api/health',{headers:{Host:'rebound.example:3099'}},res=>{
        res.resume();resolve(res.statusCode);
      }).on('error',reject);
    });
    assert.equal(reboundStatus,403);
    const sameOrigin=await fetch(base+'/api/health',{headers:{Origin:base}});
    assert.equal(sameOrigin.status,200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'),base);
    assert.equal((await sameOrigin.json()).localOnly,true);
    let book=(await request('/api/book')).data;
    const denied=await request('/api/book','PUT',{html:book.html,revision:book.revision},{Authorization:''});
    assert.equal(denied.status,401);
    const manual=await request('/api/toc','PUT',{id:'preliminary',title:'Ручное название'});assert.equal(manual.status,200);
    const saved=await request('/api/book','PUT',{html:book.html+'<h3 id="test-chapter">Новая глава</h3><p id="test-text">Тестовый текст.</p>',revision:book.revision});
    assert.equal(saved.status,200);book=saved.data;
    assert.equal(book.toc.find(t=>t.id==='preliminary').title,'Ручное название');
    assert.ok(book.toc.find(t=>t.id==='test-chapter'));
    assert.equal((await request('/api/book','PUT',{html:book.html,revision:book.revision-1})).status,409);
    const note=await request('/api/notes','POST',{blockId:'test-text',start:0,quote:'Тестовый',revision:book.revision});
    assert.equal(note.status,201);assert.match(note.data.content,/<mark/);
    const fresh=await request('/api/reader');assert.equal(fresh.data.notes.length,1);
    const other=await request('/api/reader','GET',undefined,{'X-Reader-Id':randomUUID()});assert.equal(other.data.notes.length,0);
    const snapshot=await readFile(path.join(dir,'readers',headers['X-Reader-Id'],'index.html'),'utf8');assert.match(snapshot,/<mark/);
    assert.equal((await request('/api/reader','GET',undefined,{'X-Reader-Id':'../../'})).status,400);
    assert.equal((await request('/api/notes','POST',{blockId:'test-text',start:0,quote:'Тестовый',revision:0})).status,409);
    const reset=await request('/api/toc','PUT',{id:'preliminary',reset:true});assert.equal(reset.data.toc.find(t=>t.id==='preliminary').manual,false);
    const upload=await fetch(base+'/api/images',{method:'POST',headers,body:'<svg onload="alert(1)"/>'});assert.equal(upload.status,415);
    const image=await readFile('data/books/bees/img/frontispiece.png');
    const valid=await fetch(base+'/api/images',{method:'POST',headers,body:image});assert.equal(valid.status,201);
    const imageURL=(await valid.json()).url;assert.equal((await fetch(base+imageURL)).status,200);
    assert.equal((await fetch(base+'/books/bees/readers/private/notes.json')).status,404);
    assert.ok((await readFile(path.join(dir,'generated/index.html'),'utf8')).includes('Новая глава'));
  }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
