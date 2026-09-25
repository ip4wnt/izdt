import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

test('Git-backed local data: legacy notes merge, shared notes, persisted bookmark',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'izdt-shared-'));
  for(const file of ['content.html','meta.json','toc-overrides.json'])await cp(`data/books/bees/${file}`,path.join(dir,file));
  const legacyReader=randomUUID(), legacy={id:randomUUID(),blockId:'honey',start:0,quote:'Мед есть',createdAt:new Date().toISOString()};
  await mkdir(path.join(dir,'readers',legacyReader),{recursive:true});
  await writeFile(path.join(dir,'readers',legacyReader,'notes.json'),JSON.stringify([legacy]));
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:'3191',TEST_MODE:'1',LOCAL_ONLY:'1',SHARED_DATA:'1'},stdio:'pipe'});
  const ended=new Promise(r=>child.once('exit',r));
  const base='http://127.0.0.1:3191',headers={'Content-Type':'application/json','X-Reader-Id':randomUUID()};
  try{
    for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const first=await (await fetch(base+'/api/reader',{headers})).json();
    assert.equal(first.notes.length,1);assert.equal(first.notes[0].id,legacy.id);
    const book=await (await fetch(base+'/api/book')).json();assert.equal(book.sharedData,true);
    const added=await fetch(base+'/api/notes',{method:'POST',headers,body:JSON.stringify({revision:book.revision,blockId:'products',start:0,quote:'1. Пчеловодство'})});
    assert.equal(added.status,201);
    const other=await (await fetch(base+'/api/reader',{headers:{...headers,'X-Reader-Id':randomUUID()}})).json();
    assert.equal(other.notes.length,2);
    assert.equal(JSON.parse(await readFile(path.join(dir,'notes.json'),'utf8')).length,2);
    assert.equal(JSON.parse(await readFile(path.join(dir,'readers',legacyReader,'notes.json'),'utf8')).length,1);
    const bookmark={blockId:'honey',offset:40,y:750};
    const put=await fetch(base+'/api/bookmark',{method:'PUT',headers,body:JSON.stringify({bookmark})});assert.equal(put.status,200);
    assert.deepEqual((await (await fetch(base+'/api/bookmark')).json()).bookmark,bookmark);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir,'bookmark.json'),'utf8')),bookmark);
    assert.equal((await fetch(base+'/api/bookmark',{method:'PUT',headers,body:JSON.stringify({bookmark:{blockId:'../bad',offset:0,y:0}})})).status,400);
    assert.equal((await fetch(base+'/api/bookmark',{method:'PUT',headers,body:JSON.stringify({bookmark:null})})).status,200);
    assert.equal(JSON.parse(await readFile(path.join(dir,'bookmark.json'),'utf8')),null);
  }finally{child.kill('SIGTERM');await ended;await rm(dir,{recursive:true,force:true});}
});
