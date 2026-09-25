import {chromium} from 'playwright';
import {mkdtemp,cp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

// Isolated book: this suite never edits data/books/bees or real reader notes.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const data=await mkdtemp(path.join(tmpdir(),'izdt-editor-v2-'));
const output=path.resolve(process.env.QA_OUTPUT_DIR||'.qa-output/editor-v2');
await mkdir(output,{recursive:true});
await cp('data/books/bees',data,{recursive:true,filter:src=>!/(\/|\\)(readers|history|generated)(\/|\\|$)/.test(src)});
const extra='<h1 id="title-before">КУРС ПЧЕЛОВОДСТВА</h1><p id="subtitle-before" style="text-align:center">(УХОД ЗА ПЧЁЛАМИ)</p>';
await writeFile(path.join(data,'content.html'),extra+await readFile(path.join(data,'content.html'),'utf8'));
const server=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,TEST_MODE:'1',LOCAL_ONLY:'1',SHARED_DATA:'1',DATA_DIR:data,PORT:'3189'},stdio:'pipe'});
const ended=new Promise(resolve=>server.once('exit',resolve));
let logs='';server.stderr.on('data',b=>logs+=b);
const base='http://127.0.0.1:3189';
let browser;
const checks=[];
const pass=name=>{checks.push(name);console.log('PASS',name);};
try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
  await page.goto(base);await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>document.querySelector('#book #products'));
  async function clickText(id){
    const pos=await page.locator(`#${id}`).evaluate(el=>({x:el.clientWidth/2,y:Math.min(el.clientHeight/2,parseFloat(getComputedStyle(el).lineHeight)/2)}));
    await page.locator(`#${id}`).click({position:pos});
    await page.waitForFunction(id=>document.querySelector('#editor-toolbar').dataset.blockId===id,id);
    await page.waitForFunction(()=>document.querySelector('#editor-toolbar').dataset.selectionText===getSelection().toString());
  }
  async function selectText(id,length=20){
    await clickText(id);await page.keyboard.press('Home');
    await page.keyboard.down('Shift');for(let i=0;i<length;i++)await page.keyboard.press('ArrowRight');await page.keyboard.up('Shift');
    await page.waitForFunction(()=>document.querySelector('#editor-toolbar').dataset.selectionText===getSelection().toString());
  }
  async function number(id,value){await page.locator(`#${id}`).fill(String(value));await page.locator(`#${id}`).press('Enter');}
  async function saved(){await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Сохранено');}
  async function assertOpening(){
    const boxes=await page.evaluate(()=>{
      const b=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom};};
      return {opening:b('.opening, .image-figure'),titles:b('.opening-titles, .image-overlay'),img:b('.frontispiece, .figure-image'),body:b('#products')};
    });
    assert.ok(boxes.body.top>=Math.max(boxes.titles.bottom,boxes.img.bottom)-1,JSON.stringify(boxes));
  }
  await assertOpening();pass('reader cover grows in normal flow even with headings above it');
  // Regression: destroying an EditorView must not strip the reader's book class.
  async function readerLayout(){
    return page.evaluate(()=>{
      const root=document.querySelector('#book');
      const elements=['#book','#part-one','#general','#preliminary','#honey','.divider-short','.frontispiece, .figure-image'];
      return {className:root.className,label:root.getAttribute('aria-label'),spellcheck:root.getAttribute('spellcheck'),
        elements:elements.map(selector=>{
          const el=document.querySelector(selector),style=getComputedStyle(el),rect=el.getBoundingClientRect();
          return {selector,font:style.fontSize,line:style.lineHeight,family:style.fontFamily,weight:style.fontWeight,
            x:rect.x,width:rect.width,height:rect.height};
        })};
    });
  }
  const originalLayout=await readerLayout();
  const originalContent=await readFile(path.join(data,'content.html'),'utf8');
  await page.screenshot({path:path.join(output,'reader-before-toggle.png')});
  for(let cycle=0;cycle<3;cycle++){
    await page.locator('#toggle-editor').click();await page.waitForSelector('#book.ProseMirror');
    const readerResponse=page.waitForResponse(r=>r.url()===base+'/api/reader'&&r.request().method()==='GET');
    if(cycle===1)await page.keyboard.press('Escape');else await page.locator('#exit-editor').click();
    await readerResponse;await page.waitForSelector('#book:not(.ProseMirror)');
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'reader-after-toggle.png')});
    assert.deepEqual(await readerLayout(),originalLayout,'reader typography and geometry must survive entering/exiting without edits');
    assert.equal(await readFile(path.join(data,'content.html'),'utf8'),originalContent,'no-op edit must not write the book');
  }
  pass('three no-edit enter/exit cycles preserve reader class, typography, geometry, accessibility and file content');
  await page.keyboard.press('e');await page.waitForSelector('#book.ProseMirror');
  await clickText('footnote-wax');assert.equal(await page.locator('#text-style').inputValue(),'small');
  assert.equal(Number(await page.locator('#font-size').inputValue()),1.7425);
  await clickText('honey');assert.equal(await page.locator('#text-style').inputValue(),'p');
  assert.equal(Number(await page.locator('#font-size').inputValue()),2.05);
  await clickText('part-one');assert.equal(await page.locator('#text-style').inputValue(),'h1');
  assert.equal(Number(await page.locator('#font-size').inputValue()),3.3825);
  pass('style/font size follow caret across body, small text, heading');
  await clickText('honey');
  await page.selectOption('#text-style','h2');
  assert.equal(await page.locator('#honey').evaluate(el=>el.tagName),'H2');
  await page.selectOption('#text-style','small');
  assert.equal(await page.locator('#honey').evaluate(el=>el.tagName),'P');
  assert.ok(await page.locator('#honey').evaluate(el=>el.classList.contains('small')));
  await page.selectOption('#text-style','p');
  assert.equal(await page.locator('#honey').getAttribute('class'),null);
  pass('styles change whole paragraphs, preserving IDs');
  await selectText('honey',25);
  await number('font-size',2.8);
  assert.ok(await page.locator('#honey span[style*="2.8rem"]').count());
  assert.ok(Number(await page.locator('#line-height').inputValue())>=2.8);
  await page.selectOption('#font-family','Georgia');
  assert.ok(await page.locator('#honey span[style*="Georgia"]').count());
  await page.locator('[data-command=bold]').click();
  assert.ok(await page.locator('#honey strong').count());
  assert.equal(await page.locator('[data-command=bold]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-command=italic]').click();
  await page.locator('[data-command=underline]').click();
  await page.locator('[data-command=strikeThrough]').click();
  assert.ok(await page.locator('#honey em').count());
  assert.ok(await page.locator('#honey u').count());
  assert.ok(await page.locator('#honey s').count());
  pass('selected text family, size and inline formatting; pressed states');
  await page.locator('#clear-format').click();
  assert.equal(await page.locator('#honey strong').count(),0);
  await number('line-height',3.2);await number('text-indent',1.5);
  await page.selectOption('#text-align','right');
  assert.ok((await page.locator('#honey').getAttribute('style')).includes('line-height: 3.2rem'));
  assert.ok((await page.locator('#honey').getAttribute('style')).includes('text-align: right'));
  pass('visible leading, indent, alignment; reset formatting');
  // Actual keyboard selection spanning two paragraphs.
  await clickText('honey');await page.keyboard.press('Home');
  await page.keyboard.press('Control+Shift+ArrowDown');await page.keyboard.press('Control+Shift+ArrowDown');await page.keyboard.press('Control+Shift+ArrowDown');
  await page.selectOption('#text-style','small');
  assert.ok(await page.locator('#honey').evaluate(el=>el.classList.contains('small')));
  assert.ok(await page.locator('#wax').evaluate(el=>el.classList.contains('small')));
  await page.selectOption('#text-style','p');
  assert.ok(!await page.locator('#wax').evaluate(el=>el.classList.contains('small')));
  pass('multi-paragraph style application and reset');
  await clickText('honey');await page.keyboard.press('End');
  await page.locator('#image-input').setInputFiles('data/books/bees/img/frontispiece.png');
  await page.waitForSelector('.image-shell.ProseMirror-selectednode');
  const imageId=await page.locator('.image-shell.ProseMirror-selectednode').getAttribute('id');
  await page.selectOption('#image-wrap','square');
  await page.selectOption('#image-align','right');
  await number('image-width',30);
  assert.equal(await page.locator(`#${imageId}`).evaluate(el=>getComputedStyle(el).float),'right');
  assert.equal(await page.locator(`#${imageId}`).evaluate(el=>el.style.width),'30%');
  await page.locator('#image-alt').fill('Проверка иллюстрации');
  await page.locator('#image-alt').press('Tab');
  await page.locator(`#${imageId}`).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'image-wrap-right.png')});
  await page.selectOption('#image-align','left');
  assert.equal(await page.locator(`#${imageId}`).evaluate(el=>getComputedStyle(el).float),'left');
  await page.selectOption('#image-wrap','block');await page.selectOption('#image-align','center');
  assert.equal(await page.locator(`#${imageId}`).evaluate(el=>getComputedStyle(el).float),'none');
  await page.selectOption('#image-wrap','inline');
  assert.equal(await page.locator(`#${imageId}`).evaluate(el=>getComputedStyle(el).display),'inline-block');
  await page.selectOption('#image-wrap','block');
  const handle=page.locator(`#${imageId} .image-resize-handle`);
  await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+65,box.y+box.height/2,{steps:8});await page.mouse.up();
  assert.ok(Number(await page.locator('#image-width').inputValue())>30);
  await page.locator('#delete-image').click();assert.equal(await page.locator(`#${imageId}`).count(),0);
  await page.locator('[data-command=undo]').click();assert.equal(await page.locator(`#${imageId}`).count(),1);
  await page.locator('[data-command=redo]').click();assert.equal(await page.locator(`#${imageId}`).count(),0);
  await page.locator('[data-command=undo]').click();
  pass('image insert, left/right wrap, block/inline, width, resize, description, delete/undo/redo');
  await clickText('wax');await page.keyboard.press('End');
  await page.evaluate(async()=>{
    const blob=await (await fetch('/books/bees/img/frontispiece.png')).blob();
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  });
  await page.keyboard.press('Control+v');
  await page.waitForFunction(()=>document.querySelectorAll('.image-shell:not(.figure-image)').length===2);
  pass('actual PNG clipboard paste inserts a selectable image');
  // Typography: only edited blocks get non-breaking spaces; untouched blocks keep plain spaces and no signature.
  await clickText('garden');await page.keyboard.press('Home');await page.keyboard.type('Мед и воск в 1901 г. — по 5 руб. ');
  await page.waitForFunction(()=>document.querySelector('#garden').textContent.includes('и\u00A0воск в\u00A01901\u00A0г.\u00A0— по\u00A05\u00A0руб.'));
  assert.ok((await page.locator('#garden').textContent()).includes('имея в\u00A0своем'));
  const gardenSignature=await page.locator('#garden').getAttribute('data-typo');assert.match(gardenSignature||'',/^[0-9a-z]+$/);
  const gardenText=await page.locator('#garden').textContent();
  assert.equal(await page.locator('#footnote-wax').getAttribute('data-typo'),null);
  assert.ok((await page.locator('#footnote-wax').textContent()).includes(' в '));
  await clickText('footnote-wax');await page.keyboard.press('Home');await page.keyboard.type('Ещё. ');
  await page.waitForFunction(()=>document.querySelector('#footnote-wax').dataset.typo);
  assert.ok(!(await page.locator('#footnote-wax').textContent()).includes(' в '));
  assert.equal(await page.locator('#garden').getAttribute('data-typo'),gardenSignature);
  assert.equal(await page.locator('#garden').textContent(),gardenText);
  await page.locator('[data-command=undo]').click();
  assert.equal(await page.locator('#livelihood').getAttribute('data-typo'),null);
  await page.locator('#typography-all').click();
  await page.waitForFunction(()=>document.querySelector('#livelihood').dataset.typo);
  assert.ok((await page.locator('#part-one').textContent()).includes('ЧАСТЬ I.'));
  pass('non-breaking spaces follow edits per block, signatures skip unchanged blocks, whole-book pass on demand');
  await saved();
  assert.ok((await readFile(path.join(data,'content.html'),'utf8')).includes('data-typo='));
  const offline='**/api/book';
  await page.route(offline,route=>route.request().method()==='PUT'?route.abort():route.continue());
  await clickText('livelihood');await page.keyboard.press('End');await page.keyboard.type(' Проверка офлайн.');
  await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('#save-status').classList.contains('error'));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#book.ProseMirror').count(),1);
  await page.unroute(offline);await saved();
  pass('failed save keeps draft and prevents leaving editor');
  const editedReaderResponse=page.waitForResponse(r=>r.url()===base+'/api/reader'&&r.request().method()==='GET');
  await page.keyboard.press('Escape');await editedReaderResponse;await page.waitForSelector('#book:not(.ProseMirror)');
  await page.evaluate(()=>window.scrollTo(0,0));
  const editedReaderLayout=await readerLayout();
  assert.equal(editedReaderLayout.className,'book');
  assert.equal(editedReaderLayout.elements[0].font,originalLayout.elements[0].font);
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#book img.book-image').length===2);
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>Promise.all([...document.querySelectorAll('#book img')].map(img=>img.decode())));
  await page.evaluate(()=>window.scrollTo(0,0));
  assert.deepEqual(await readerLayout(),editedReaderLayout,'saved reader layout must match a fresh page load');
  assert.ok((await page.locator('#livelihood').textContent()).includes('Проверка офлайн.'));
  pass('text, image attributes and reader layout survive save/exit/reload');
  await page.keyboard.press('e');await page.waitForSelector('#book.ProseMirror');
  await clickText('part-one');await page.keyboard.press('End');await page.keyboard.type(' Дополнительный длинный заголовок для проверки роста титула');
  await assertOpening();await saved();
  await page.evaluate(()=>window.scrollTo(0,0));
  const toolbar=await page.locator('#editor-toolbar').boundingBox();
  const before=await page.locator('#title-before').boundingBox();
  assert.ok(before.y>=toolbar.y+toolbar.height);
  await page.screenshot({path:path.join(output,'editor-1440.png')});
  await page.setViewportSize({width:1000,height:900});await page.evaluate(()=>window.scrollTo(0,0));
  const fit=await page.locator('#editor-toolbar').boundingBox();assert.ok(fit.x>=0&&fit.x+fit.width<=1000);
  await page.screenshot({path:path.join(output,'editor-1000.png')});
  await page.setViewportSize({width:1920,height:1200});await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'editor-1920.png')});
  pass('long cover titles grow without overlapping body; toolbar fits 1000/1440/1920');
  // Title composition is now a figure with a draggable text overlay.
  assert.equal(await page.locator('figure.image-figure').count(),1);
  await clickText('part-one');await page.waitForFunction(()=>!document.querySelector('#overlay-tools').hidden);
  assert.equal(await page.locator('#overlay-x').inputValue(),'45');
  await number('overlay-x',30);await number('overlay-width',60);await number('overlay-y',48);
  assert.equal(await page.locator('.image-overlay').evaluate(el=>el.style.marginLeft),'30%');
  const grip=page.locator('.overlay-grip');await grip.scrollIntoViewIfNeeded();const gripBox=await grip.boundingBox();
  const figureWidth=(await page.locator('figure.image-figure').boundingBox()).width;
  await page.mouse.move(gripBox.x+gripBox.width/2,gripBox.y+gripBox.height/2);await page.mouse.down();
  await page.mouse.move(gripBox.x+gripBox.width/2+figureWidth*.1,gripBox.y+gripBox.height/2+figureWidth*.05,{steps:8});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#overlay-x').value==='40');
  assert.equal(await page.locator('#overlay-y').inputValue(),'53');
  const resize=page.locator('.overlay-resize');await resize.scrollIntoViewIfNeeded();const resizeBox=await resize.boundingBox();
  await page.mouse.move(resizeBox.x+resizeBox.width/2,resizeBox.y+resizeBox.height/2);await page.mouse.down();
  await page.mouse.move(resizeBox.x+resizeBox.width/2-figureWidth*.1,resizeBox.y+resizeBox.height/2,{steps:8});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#overlay-width').value==='50');
  await assertOpening();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'figure-overlay-editing.png')});
  await page.locator('#detach-overlay').click();
  assert.equal(await page.locator('.image-overlay').count(),0);
  assert.equal(await page.locator('figure.image-figure + h1#part-one, figure.image-figure ~ #part-one').count(),1);
  await page.locator('.figure-image').click();await page.waitForFunction(()=>!document.querySelector('#figure-text').hidden);
  await page.locator('#figure-text').click();await page.keyboard.type('Новая надпись');
  assert.ok((await page.locator('.image-overlay').textContent()).includes('Новая надпись'));
  await page.locator('[data-command=undo]').click();await page.locator('[data-command=undo]').click();await page.locator('[data-command=undo]').click();
  assert.ok((await page.locator('.image-overlay').textContent()).includes('ЧАСТЬ I.'));
  // An ordinary inline image becomes a figure with text; deleting the picture keeps its text as paragraphs.
  await page.locator('.image-shell:not(.figure-image)').first().click();await page.waitForFunction(()=>!document.querySelector('#figure-text').hidden);
  await page.locator('#figure-text').click();await page.keyboard.type('Подпись поверх картинки');
  assert.equal(await page.locator('figure.image-figure').count(),2);
  assert.equal(await page.locator('.image-shell:not(.figure-image)').count(),1);
  await page.locator('figure.image-figure').nth(1).locator('.figure-image').click();
  await page.locator('#delete-image').click();
  assert.equal(await page.locator('figure.image-figure').count(),1);
  assert.ok(await page.locator('#book p').filter({hasText:'Подпись поверх картинки'}).count());
  await page.locator('[data-command=undo]').click();await page.locator('[data-command=undo]').click();await page.locator('[data-command=undo]').click();
  assert.equal(await page.locator('.image-shell:not(.figure-image)').count(),2);
  await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'figure-overlay-reader.png')});
  await assertOpening();
  await page.keyboard.press('e');await page.waitForSelector('#book.ProseMirror');
  pass('figure overlay: numeric position, drag, resize, detach, add text, convert inline image, delete keeps text; reader shows it');
  await clickText('garden');await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.keyboard.type('Новая строка');
  await page.selectOption('#text-style','h3');
  assert.ok(await page.locator('#book h3').filter({hasText:'Новая строка'}).count());
  await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('Обычный текст после заголовка.');
  await page.waitForFunction(()=>document.querySelector('#text-style').value==='p');
  assert.equal(Number(await page.locator('#font-size').inputValue()),2.05);
  await page.keyboard.press('Control+i');await page.keyboard.type(' Курсив');await page.keyboard.press('Control+i');
  await page.locator('#short-divider').click();await page.locator('#long-divider').click();
  assert.ok(await page.locator('.divider-short').count()>1);
  assert.ok(await page.locator('.divider-long').count()>1);
  await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
  pass('Enter after heading uses normal size, Ctrl+I, both divider controls');
  await page.keyboard.press('c');
  await page.waitForFunction(()=>document.body.classList.contains('panel-open'));
  await page.locator('#edit-toc').click();
  const tocTitle=page.getByRole('textbox',{name:'Название: Предварительные сведения.'});
  await tocTitle.fill('Проверка оглавления');await tocTitle.press('Tab');
  await page.waitForFunction(()=>document.querySelector('.toc-row.is-manual'));
  await page.reload();await page.keyboard.press('c');
  await page.getByRole('link',{name:'Проверка оглавления',exact:true}).waitFor();
  await page.locator('#edit-toc').click();
  await page.getByRole('button',{name:'Скрыть пункт: Предварительные сведения.'}).click();
  await page.waitForFunction(()=>document.querySelector('.toc-row.is-hidden'));
  await page.getByRole('button',{name:'Сбросить ручную правку: Предварительные сведения.'}).click();
  await page.locator('#close-panel').click();
  pass('TOC rename/reload/hide/reset remains functional');
  await page.locator('#garden').scrollIntoViewIfNeeded();
  const points=await page.locator('#garden').evaluate(el=>{
    const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,35);
    const a=r.getClientRects()[0],b=[...r.getClientRects()].at(-1);
    return {x1:a.left+1,y1:a.top+a.height/2,x2:b.right-1,y2:b.top+b.height/2};
  });
  await page.mouse.move(points.x1,points.y1);await page.mouse.down();await page.mouse.move(points.x2,points.y2,{steps:15});await page.mouse.up();
  await page.locator('#selection-note').waitFor({state:'visible'});await page.locator('#selection-note').click();
  await page.waitForSelector('#garden mark');
  await page.keyboard.press('b');await page.waitForSelector('.note-link');
  await page.screenshot({path:path.join(output,'notes-shared.png')});
  await page.locator('.note-link').first().click();await page.locator('#close-panel').click();
  await page.locator('#set-bookmark').click();
  await page.waitForFunction(()=>!document.querySelector('#bookmark-ribbon').hidden&&!document.querySelector('#bookmark-ribbon').classList.contains('gone'));
  assert.ok(JSON.parse(await readFile(path.join(data,'bookmark.json'),'utf8')).blockId);
  assert.ok(JSON.parse(await readFile(path.join(data,'notes.json'),'utf8')).length);
  const other=await browser.newContext();const otherPage=await other.newPage();
  await otherPage.goto(base);await otherPage.waitForSelector('#garden mark');
  await otherPage.waitForFunction(()=>!document.querySelector('#bookmark-ribbon').hidden&&!document.querySelector('#bookmark-ribbon').classList.contains('gone'));
  await otherPage.locator('#bookmark-ribbon').click();await otherPage.waitForFunction(()=>document.querySelector('#bookmark-ribbon').hidden);
  assert.equal(JSON.parse(await readFile(path.join(data,'bookmark.json'),'utf8')),null);
  await other.close();
  pass('real selection note and bookmark are shared across fresh browser profiles and saved in Git data files');
  await page.locator('.rail').hover();await page.locator('#toggle-theme').click();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(output,'dark.png')});
  await page.locator('#toggle-theme').click();await page.locator('#show-help').click();
  await page.locator('#help[open]').waitFor();await page.locator('.dialog-close').click();
  pass('dark mode and help');
  assert.deepEqual(errors,[]);pass('no uncaught browser errors');
  await writeFile(path.join(output,'results.json'),JSON.stringify({checks,errors,serverLogs:logs},null,2));
}catch(e){
  try{const pages=browser?.contexts()[0]?.pages()||[];if(pages[0]){await pages[0].screenshot({path:path.join(output,'failure.png')});console.log(await pages[0].evaluate(()=>[...document.querySelectorAll('#book img')].map(i=>i.outerHTML.slice(0,160)).join('\n')));}}catch{}
  throw e;
}finally{
  if(browser)await browser.close();
  server.kill('SIGTERM');await ended;
  await rm(data,{recursive:true,force:true});
}
