import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {mkdtemp,cp,readFile,writeFile,readdir,mkdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cropPNG,transparentPNG,transparentImage,readChunks,pngInfo} from '../server/image-crop.js';

// Маленький PNG для тестов: RGBA 8 бит, каждый пиксель свой цвет, плюс служебные блоки.
function chunk(type,data){const t=Buffer.from(type,'latin1');const crc=zlib.crc32?zlib.crc32(Buffer.concat([t,data])):0;const h=Buffer.alloc(8);h.writeUInt32BE(data.length);t.copy(h,4);const c=Buffer.alloc(4);c.writeUInt32BE(crc>>>0);return Buffer.concat([h,data,c]);}
function makePNG(w,h){
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  const raw=Buffer.alloc(h*(w*4+1));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=y*(w*4+1)+1+x*4;raw[o]=x*7;raw[o+1]=y*5;raw[o+2]=(x*y)&255;raw[o+3]=255-x;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('gAMA',Buffer.from([0,0,177,143])),chunk('tEXt',Buffer.from('Source\0izdt test','latin1')),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const pixels=buf=>{const chunks=readChunks(buf),i=pngInfo(buf),raw=zlib.inflateSync(Buffer.concat(chunks.filter(c=>c.type==='IDAT').map(c=>c.data))),len=i.width*4,rows=[];let prev=Buffer.alloc(len);
  for(let y=0;y<i.height;y++){const t=raw[y*(len+1)],r=Buffer.from(raw.subarray(y*(len+1)+1,(y+1)*(len+1)));for(let k=0;k<len;k++){const a=k>=4?r[k-4]:0,b=prev[k],c=k>=4?prev[k-4]:0;const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);r[k]=(r[k]+(t===1?a:t===2?b:t===3?(a+b)>>1:t===4?(pa<=pb&&pa<=pc?a:pb<=pc?b:c):0))&255;}rows.push(r);prev=r;}return rows;};

test('PNG crop keeps pixels byte for byte and all ancillary chunks',()=>{
  const src=makePNG(40,30),out=cropPNG(src,{x:5,y:3,width:20,height:17});
  assert.deepEqual([pngInfo(out).width,pngInfo(out).height],[20,17]);
  const a=pixels(src),b=pixels(out);
  for(let y=0;y<17;y++)assert.ok(b[y].equals(a[y+3].subarray(5*4,25*4)),`row ${y}`);
  const extra=buf=>readChunks(buf).filter(c=>!['IHDR','IDAT'].includes(c.type)).map(c=>c.type+':'+c.data.toString('hex'));
  assert.deepEqual(extra(out),extra(src));
  assert.throws(()=>cropPNG(src,{x:30,y:0,width:20,height:5}),/за пределы/);
});

test('transparent: only the picked color becomes transparent, other pixels and chunks stay',async()=>{
  // RGBA: альфа 0 только у пикселей ровно того же цвета, остальное побайтно.
  const src=makePNG(40,30),out=transparentPNG(src,{x:3,y:0}),a=pixels(src),b=pixels(out),t=a[0].subarray(12,15);let cleared=0;
  for(let y=0;y<30;y++)for(let x=0;x<40;x++){const p=a[y].subarray(x*4,x*4+4),q=b[y].subarray(x*4,x*4+4);
    if(p.subarray(0,3).equals(t)){assert.equal(q[3],0);assert.ok(q.subarray(0,3).equals(t));cleared++;}else assert.ok(p.equals(q),`${x},${y}`);}
  assert.ok(cleared>=1);
  const extra=buf=>readChunks(buf).filter(c=>!['IHDR','IDAT'].includes(c.type)).map(c=>c.type+':'+c.data.toString('hex'));
  assert.deepEqual(extra(out),extra(src));
  // RGB без прозрачности: добавляется только tRNS, сами пиксели (IDAT) не меняются.
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(4,0);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=2;
  const raw=Buffer.from([0,9,8,7,1,2,3,9,8,7,4,5,6, 0,9,8,7,9,8,7,0,0,0,1,1,1]);
  const rgb=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  const o=transparentPNG(rgb,{x:0,y:1}),idat=buf=>readChunks(buf).filter(c=>c.type==='IDAT').map(c=>c.data.toString('hex')).join();
  assert.equal(idat(o),idat(rgb));assert.equal(readChunks(o).find(c=>c.type==='tRNS').data.toString('hex'),'000900080007');
  assert.throws(()=>transparentPNG(o,{x:0,y:0}),/уже прозрачный/);
  assert.throws(()=>transparentPNG(rgb,{x:4,y:0}),/вне картинки/);
  // Допуск: близкие оттенки тоже прозрачные; несколько цветов — добавляется альфа-канал, цвета те же.
  const near=transparentPNG(rgb,{x:1,y:0,tolerance:3}),h=pngInfo(near);
  assert.equal(h.color,6);
  const rows=zlib.inflateSync(Buffer.concat(readChunks(near).filter(c=>c.type==='IDAT').map(c=>c.data)));
  const rgba=[];let prev=Buffer.alloc(16);for(let y=0;y<2;y++){const t=rows[y*17],r=Buffer.from(rows.subarray(y*17+1,y*17+17));for(let k=0;k<16;k++){const a=k>=4?r[k-4]:0,b=prev[k],c=k>=4?prev[k-4]:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);r[k]=(r[k]+(t===1?a:t===2?b:t===3?(a+b)>>1:t===4?(pa<=pb&&pa<=pc?a:pb<=pc?b:c):0))&255;}rgba.push(r);prev=r;}
  assert.deepEqual(rgba.map(r=>[...r]),[[9,8,7,255,1,2,3,0,9,8,7,255,4,5,6,0],[9,8,7,255,9,8,7,255,0,0,0,0,1,1,1,0]]);
  assert.throws(()=>transparentPNG(rgb,{x:0,y:0,tolerance:300}),/допуск/);
  assert.ok(Buffer.isBuffer(await transparentImage(src,{x:0,y:0})));
});

test('crop API: new PNG, old file removed after save, old URL redirects',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'izdt-crop-'));
  for(const file of ['content.html','meta.json','toc-overrides.json'])await cp(`data/books/bees/${file}`,path.join(dir,file));
  await mkdir(path.join(dir,'img'));const old=`${randomUUID()}.png`;await writeFile(path.join(dir,'img',old),makePNG(40,30));
  const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,DATA_DIR:dir,PORT:'3097',EDITOR_TOKEN:'t',TEST_MODE:'0',LOCAL_ONLY:'1'},stdio:'pipe'});
  let errors='';child.stderr.on('data',c=>errors+=c);
  const base='http://127.0.0.1:3097',headers={'Content-Type':'application/json',Authorization:'Bearer t','X-Reader-Id':randomUUID()};
  const request=async(route,method='GET',data)=>{const res=await fetch(base+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,data:await res.json()};};
  try{
    for(let i=0;i<60;i++){try{await fetch(base+'/api/health');break;}catch{await new Promise(r=>setTimeout(r,100));}}
    let book=(await request('/api/book')).data;
    const html=src=>`<h1 id="t">Книга</h1><p id="p"><img src="${src}" alt="Рис." data-wrap="block"></p>`;
    book=(await request('/api/book','PUT',{html:html(`/books/bees/img/${old}`),revision:book.revision})).data;
    assert.equal((await request('/api/images/crop','POST',{src:`/books/bees/img/${old}`,x:50,y:0,width:5,height:5})).status,400);
    const cropped=await request('/api/images/crop','POST',{src:`/books/bees/img/${old}`,x:2,y:4,width:30,height:20});
    assert.equal(cropped.status,201,JSON.stringify(cropped.data));
    assert.match(cropped.data.url,/^\/books\/bees\/img\/[0-9a-f-]+\.png$/);assert.deepEqual([cropped.data.w,cropped.data.h],[30,20]);
    // До сохранения книги старый файл на месте; старый адрес уже ведет на новый.
    await access(path.join(dir,'img',old));
    const redirect=await fetch(`${base}/books/bees/img/${old}`,{redirect:'manual'});assert.equal(redirect.status,301);
    assert.equal(redirect.headers.get('location'),path.basename(cropped.data.url));
    // Сохранение со старым адресом (например, отмена в другой вкладке) все равно дает новый файл.
    const saved=await request('/api/book','PUT',{html:html(`/books/bees/img/${old}`),revision:book.revision});
    assert.equal(saved.status,200);
    assert.ok(saved.data.html.includes(cropped.data.url)&&!saved.data.html.includes(old),saved.data.html);
    assert.ok(saved.data.html.includes('width="30"')&&saved.data.html.includes('height="20"'));
    assert.deepEqual((await readdir(path.join(dir,'img'))).sort(),[path.basename(cropped.data.url)]);
    // Прозрачный цвет: тот же размер, новый файл, старый удаляется при сохранении.
    assert.equal((await request('/api/images/transparent','POST',{src:cropped.data.url,x:30,y:0})).status,400);
    assert.equal((await request('/api/images/transparent','POST',{src:cropped.data.url,x:1,y:1,tolerance:-1})).status,400);
    const clear=await request('/api/images/transparent','POST',{src:cropped.data.url,x:1,y:1,tolerance:4});
    assert.equal(clear.status,201,JSON.stringify(clear.data));assert.deepEqual([clear.data.w,clear.data.h],[30,20]);
    assert.equal((await request('/api/images/transparent','POST',{src:clear.data.url,x:1,y:1})).status,409);
    const again=await request('/api/book','PUT',{html:html(cropped.data.url),revision:saved.data.revision});
    assert.equal(again.status,200);assert.ok(again.data.html.includes(clear.data.url));
    assert.deepEqual((await readdir(path.join(dir,'img'))).sort(),[path.basename(clear.data.url)]);
  }finally{child.kill();}
});
