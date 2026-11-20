import {chromium} from 'playwright';
import {mkdtemp,cp,mkdir,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {nbspIndices,NBSP} from '../client/typography.js';

// Isolated book: this suite never edits data/books/bees or real reader notes.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const data=await mkdtemp(path.join(tmpdir(),'izdt-editor-v2-'));
const output=path.resolve(process.env.QA_OUTPUT_DIR||'.qa-output/editor-v2');
await mkdir(output,{recursive:true});
await cp('data/books/bees',data,{recursive:true,filter:src=>!/(\/|\\)(readers|history|generated)(\/|\\|$)/.test(src)});
const extra='<h1 id="title-before">КУРС ПЧЕЛОВОДСТВА</h1><p id="subtitle-before" style="text-align:center">(УХОД ЗА ПЧЁЛАМИ)</p>';
// Фикстура с исходной книгой: живые данные меняются редактором и не годятся для проверок обложки.
await writeFile(path.join(data,'content.html'),extra+await readFile('scripts/fixtures/content.html','utf8'));
await rm(path.join(data,'styles.json'),{force:true});
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
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
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
  // Неудачное сохранение оставляет черновик в localStorage; успешное — убирает его.
  const draft=()=>page.evaluate(()=>{try{return JSON.parse(localStorage.getItem('izdt:bees:draft'));}catch{return null;}});
  assert.match((await draft())?.html||'',/Проверка офлайн\./,'draft is stored in localStorage after a failed save');
  await page.unroute(offline);await saved();
  assert.equal(await draft(),null,'draft is cleared after a successful save');
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
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  await clickText('part-one');await page.keyboard.press('End');await page.keyboard.type(' Дополнительный длинный заголовок для проверки роста титула');
  await assertOpening();await saved();
  await page.evaluate(()=>window.scrollTo(0,0));
  const toolbar=await page.locator('#editor-toolbar').boundingBox();
  const before=await page.locator('#title-before').boundingBox();
  assert.ok(before.y>=0&&toolbar.y>0,'toolbar at the bottom does not cover the top of the page');
  await page.screenshot({path:path.join(output,'editor-1440.png')});
  await page.setViewportSize({width:1000,height:900});await page.evaluate(()=>window.scrollTo(0,0));
  const fit=await page.locator('#editor-toolbar').boundingBox();assert.ok(fit.x>=0&&fit.x+fit.width<=1000);
  await page.screenshot({path:path.join(output,'editor-1000.png')});
  await page.setViewportSize({width:1920,height:1200});await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'editor-1920.png')});
  pass('long cover titles grow without overlapping body; toolbar fits 1000/1440/1920');
  // Адаптивность: поля → полоса набора (до 80 %) → масштаб контента вместе с полосой; книга не выходит за окно.
  const geometry=async width=>{await page.setViewportSize({width,height:900});return page.evaluate(()=>{const b=document.querySelector('#book').getBoundingClientRect();const rail=document.querySelector('.rail').getBoundingClientRect();return {rem:parseFloat(getComputedStyle(document.documentElement).fontSize),width:b.width,left:b.left-rail.right,right:document.documentElement.clientWidth-b.right,scroll:document.documentElement.scrollWidth<=document.documentElement.clientWidth};});};
  const wide=await geometry(1000), narrowMargins=await geometry(785), column=await geometry(700), scaled=await geometry(560);
  assert.ok(wide.left>narrowMargins.left&&Math.abs(narrowMargins.left-narrowMargins.right)<2,'margins shrink symmetrically');
  assert.ok(Math.round(wide.width)===Math.round(narrowMargins.width)&&wide.rem===narrowMargins.rem,'column and scale unchanged while margins shrink');
  assert.ok(column.width<narrowMargins.width&&column.width>=narrowMargins.width*0.8-1&&column.rem===wide.rem,'column shrinks up to 20% at constant scale');
  assert.ok(scaled.rem<column.rem&&scaled.width<column.width&&scaled.scroll,'below that both the scale and column shrink together');
  for(const g of [wide,narrowMargins,column,scaled])assert.ok(g.scroll&&g.right>=0&&g.left>=0,JSON.stringify(g));
  await page.screenshot({path:path.join(output,'responsive-560.png')});
  await page.setViewportSize({width:1440,height:1100});
  pass('responsive: margins, then column (≤20%), then proportional scale');
  // Геометрия каждого блока в читалке и в редакторе совпадает: вход в редактор не сдвигает текст. Гравюра титула растягивается по сетке, её высота не сравнивается.
  const blockGeometry=()=>page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('#book [id]')].map(el=>{const r=el.getBoundingClientRect();return [el.id,[Math.round(r.top+scrollY),el.matches('.figure-image')?0:Math.round(r.height)]];})));
  if(await page.locator('#book.ProseMirror').count()){await saved();await page.keyboard.press('Escape');}
  await page.waitForSelector('#book:not(.ProseMirror)');
  const readerBlocks=await blockGeometry();
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  const editorBlocks=await blockGeometry();
    const shifted=Object.entries(readerBlocks).filter(([id,[top,height]])=>editorBlocks[id]&&(Math.abs(editorBlocks[id][0]-top)>1||Math.abs(editorBlocks[id][1]-height)>1));
  assert.deepEqual(shifted.map(([id])=>id),[],`blocks moved between reader and editor: ${JSON.stringify(shifted.slice(0,3))}`);
  pass('reader and editor share identical block geometry (empty paragraphs, block images, wrapping)');
  // Индикатор положения в книге: считается по книге, одинаков в обоих режимах, 100% в конце.
  const progress=()=>page.evaluate(()=>document.querySelector('#reading-progress .progress-value').textContent);
  const inEditor=await progress();
  await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');await page.waitForTimeout(100);
  assert.equal(await progress(),inEditor,'progress differs between editor and reader');
  const progressBefore=Number(inEditor);await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(150);
  assert.equal(await progress(),'100');assert.ok(progressBefore<100);
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(150);assert.equal(await progress(),'0');
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  pass('reading progress indicator follows the scroll position in both modes');
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
  // Блок без плашки и подписи сразу становится обычной картинкой: обтекание снова доступно.
  assert.equal(await page.locator('figure.image-figure').count(),0);
  assert.equal(await page.locator('#book h1#part-one').count(),1);
  await page.locator('.image-shell:not(.figure-image)').first().click();await page.waitForFunction(()=>!document.querySelector('#figure-text').hidden);
  assert.equal(await page.locator('#image-wrap').isDisabled(),false);
  assert.equal(await page.locator('#image-selection-label').textContent(),'Изображение');
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
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  pass('figure overlay: numeric position, drag, resize, detach, add text, convert inline image, delete keeps text; reader shows it');
  // Подпись под картинкой: обтекание блока целиком, подпись под картинкой, снятие подписи возвращает обычную картинку.
  {
    const picture=page.locator('.image-shell:not(.figure-image)').first();await picture.scrollIntoViewIfNeeded();await picture.click();
    await page.waitForFunction(()=>!document.querySelector('#figure-caption').hidden);
    await page.locator('#image-wrap').selectOption('square');await page.locator('#image-align').selectOption('left');await number('image-width',40);
    await page.locator('.image-shell:not(.figure-image)').first().click();
    await page.locator('#figure-caption').click();await page.keyboard.type('Рис. 28. Пчелы, собирающие воду на бережках лужиц.');
    const fig=page.locator('figure.image-figure.wrap-left');
    assert.equal(await fig.count(),1);
    assert.equal((await fig.locator('figcaption p.caption').textContent()).replace(/\u00a0/g,' '),'Рис. 28. Пчелы, собирающие воду на бережках лужиц.');
    const geo=await fig.evaluate(el=>{const r=el.getBoundingClientRect(),img=el.querySelector('.figure-image').getBoundingClientRect(),cap=el.querySelector('figcaption').getBoundingClientRect(),col=el.parentElement.getBoundingClientRect();
      return {float:getComputedStyle(el).float,width:r.width/col.width,img:img.width/r.width,capBelow:cap.top>=img.bottom-1,capWidth:Math.abs(cap.width-img.width),align:getComputedStyle(el.querySelector('p.caption')).textAlign};});
    assert.equal(geo.float,'left');assert.ok(Math.abs(geo.width-.4)<.02,JSON.stringify(geo));assert.ok(geo.img>.98&&geo.capBelow&&geo.capWidth<2&&geo.align==='center',JSON.stringify(geo));
    assert.equal(await page.locator('#text-style').inputValue(),'caption');
    await fig.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'figure-caption-editing.png')});
    // Ширина картинки меняет и блок с подписью.
    await fig.locator('.figure-image').click();await page.waitForFunction(()=>document.querySelector('#figure-caption').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#image-selection-label').textContent(),'Картинка с подписью');
    await number('image-width',50);
    assert.equal(await fig.evaluate(el=>el.style.width),'50%');
    // «Сверху и снизу»: подпись по ширине картинки и по ее положению.
    await fig.locator('.figure-image').click();await page.locator('#image-wrap').selectOption('block');await page.locator('#image-align').selectOption('center');
    const block=page.locator('figure.image-figure').filter({has:page.locator('figcaption')});
    const geo2=await block.evaluate(el=>{const img=el.querySelector('.figure-image').getBoundingClientRect(),cap=el.querySelector('figcaption').getBoundingClientRect();return {float:getComputedStyle(el).float,dx:Math.abs(cap.left-img.left),dw:Math.abs(cap.width-img.width)};});
    assert.ok(geo2.float==='none'&&geo2.dx<2&&geo2.dw<2,JSON.stringify(geo2));
    await page.locator('#image-wrap').selectOption('square');await page.locator('#image-align').selectOption('right');
    assert.equal(await page.locator('figure.image-figure.wrap-right figcaption').count(),1);
    // Сохранение и читалка.
    await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    // Читалка после выхода из редактора может перерисовать книгу (заметки, закладка): проверяем уже устоявшийся DOM.
    await page.waitForFunction(()=>{const el=document.querySelector('#book figure.image-figure.wrap-right');
      if(!el||getComputedStyle(el).float!=='right')return false;
      if(el.querySelector('figcaption p.caption')?.textContent.replace(/\u00a0/g,' ')!=='Рис. 28. Пчелы, собирающие воду на бережках лужиц.')return false;
      el.scrollIntoView({block:'center'});return true;});
    await page.waitForTimeout(300);await page.screenshot({path:path.join(output,'figure-caption-reader.png')});
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    // Backspace в пустой подписи убирает ее, картинка остается с тем же обтеканием.
    const edit=page.locator('#book figure.image-figure.wrap-right');
    await edit.locator('.figure-image').click();await page.locator('#figure-caption').click();
    assert.equal(await page.locator('figure.image-figure.wrap-right').count(),0);
    assert.ok(await page.locator('#book p').filter({hasText:/Рис\.\s28\.\sПчелы/}).count());
    assert.equal(await page.locator('.image-shell.wrap-right:not(.figure-image)').count(),1);
    await page.locator('.image-shell.wrap-right').click();await page.locator('#figure-caption').click();
    assert.equal(await page.locator('figure.image-figure.wrap-right figcaption').count(),1);
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('figure.image-figure.wrap-right').count(),0);
    assert.equal(await page.locator('.image-shell.wrap-right.ProseMirror-selectednode').count(),1);
    // Картинка с текстом и подписью одновременно; снятие текста оставляет подпись.
    await page.locator('#figure-caption').click();await page.keyboard.type('Подпись');
    await page.locator('figure.image-figure.wrap-right .figure-image').click();await page.locator('#figure-text').click();await page.keyboard.type('Надпись');
    assert.equal(await page.locator('figure.image-figure.wrap-right > .image-overlay + figcaption').count(),1);
    await page.locator('#detach-overlay').click();
    assert.equal(await page.locator('figure.image-figure.wrap-right figcaption').count(),1);
    assert.equal(await page.locator('figure.image-figure.wrap-right .image-overlay').count(),0);
    await saved();
    pass('figure caption: wrap with caption, width, block alignment, reader, remove caption by button and Backspace, caption plus overlay');
  }
  // Обрезка: рамка, Esc отменяет, «Сохранить» дает новый PNG нужного размера, ширина на странице уменьшается, старый файл удаляется.
  {
    await clickText('garden');await page.keyboard.press('End');
    await page.locator('#image-input').setInputFiles('data/books/bees/img/frontispiece.png');
    await page.waitForSelector('.image-shell.ProseMirror-selectednode img');
    await number('image-width',60);
    const shell=page.locator('.image-shell.ProseMirror-selectednode');const id=await shell.getAttribute('id');
    await page.waitForFunction(i=>document.getElementById(i).querySelector('img').naturalWidth>0,id);
    const oldSrc=await page.locator(`#${id} img`).getAttribute('src');
    await page.locator('#image-crop').click();
    await page.waitForSelector(`#${id} .crop-frame`);
    assert.ok(await page.locator('#image-crop').isDisabled());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.crop-frame').count(),0);assert.ok(await page.locator('#book.ProseMirror').count(),'Esc cancels crop, editor stays open');
    await page.locator(`#${id}`).click();await page.locator('#image-crop').click();await page.waitForSelector(`#${id} .crop-frame`);
    const drag=async(edge,fx,fy)=>{const r=await page.locator(`#${id} img`).boundingBox(),h=await page.locator(`#${id} .crop-${edge}`).boundingBox();
      const x=h.x+h.width/2,y=h.y+h.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+fx*r.width,y+fy*r.height,{steps:6});await page.mouse.up();};
    await drag('nw',.1,.2);await drag('se',-.25,-.1);await drag('e',.05,0);
    await page.locator(`#${id} .crop-frame`).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'image-crop-frame.png')});
    const expected=await page.locator(`#${id} .crop-frame`).evaluate(f=>{const img=f.closest('.image-shell').querySelector('img'),W=img.naturalWidth,H=img.naturalHeight,l=parseFloat(f.style.left)/100,t=parseFloat(f.style.top)/100,w=parseFloat(f.style.width)/100,h=parseFloat(f.style.height)/100;
      const x=Math.round(l*W),y=Math.round(t*H);return {W,H,width:Math.round((l+w)*W)-x,height:Math.round((t+h)*H)-y};});
    await page.locator(`#${id} .crop-save`).click();
    await page.waitForFunction(([i,src])=>{const img=document.getElementById(i)?.querySelector('img');return img&&!img.src.endsWith(src)&&img.complete&&img.naturalWidth>0&&!document.querySelector('.crop-frame');},[id,oldSrc]);
    const after=await page.locator(`#${id}`).evaluate(el=>({w:el.querySelector('img').naturalWidth,h:el.querySelector('img').naturalHeight,src:el.querySelector('img').getAttribute('src'),width:el.style.width}));
    assert.deepEqual([after.w,after.h],[expected.width,expected.height],JSON.stringify({after,expected}));
    assert.match(after.src,/\.png$/);assert.equal(after.width,`${Math.round(60*expected.width/expected.W)}%`);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator(`#${id} img`).getAttribute('src'),after.src,'undo does not bring back the removed file');
    assert.equal(await page.locator(`#${id}`).evaluate(el=>el.style.width),after.width,'undo keeps the cropped width');
    await saved();
    const files=await readdir(path.join(data,'img'));
    assert.ok(files.includes(path.basename(after.src))&&!files.includes(path.basename(oldSrc)),files.join(','));
    assert.equal((await fetch(base+oldSrc,{redirect:'manual'})).status,301);
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'image-crop-done.png')});
    pass('image crop: frame, Esc cancels, save makes exact-size PNG, page width scales, undo keeps new file, old file removed after save');
  }
  // Правка текста не пересоздает абзац: иначе браузер теряет подчеркивание ошибок (проверку орфографии) в нем.
  {
    const original=await page.locator('#garden').evaluate(p=>p.textContent);
    await clickText('garden');await page.keyboard.press('End');await page.keyboard.type('ы');
    await page.evaluate(()=>{const p=document.getElementById('garden');window.__spell={p,text:p.firstChild};});
    await page.keyboard.type(' слвоо');for(let i=0;i<7;i++)await page.keyboard.press('Backspace');
    await page.keyboard.press('Home');await page.keyboard.type('ыы');for(let i=0;i<2;i++)await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>window.__spell.p===document.getElementById('garden')&&window.__spell.text===document.getElementById('garden').firstChild&&document.getElementById('garden').spellcheck),'paragraph element and its text node are kept while typing');
    assert.equal(await page.locator('#garden').evaluate(p=>p.textContent),original);
    await saved();
    pass('typing keeps the paragraph element (browser spellcheck marks survive edits)');
  }
  // Прозрачный цвет: пипетка, ползунок допуска перестраивает предпросмотр, «Сохранить» дает тот же результат с сервера.
  {
    const shell=page.locator('.image-shell').filter({has:page.locator('img[src$=".png"]')}).last();const id=await shell.getAttribute('id');
    await page.locator(`#${id}`).click();
    const before=await page.locator(`#${id}`).evaluate(el=>({src:el.querySelector('img').getAttribute('src'),w:el.querySelector('img').naturalWidth,h:el.querySelector('img').naturalHeight,width:el.style.width}));
    await page.locator('#image-transparent').click();await page.waitForSelector(`#${id} .pick-bar`);
    assert.ok(await page.locator('#image-crop').isDisabled()&&await page.locator('#image-transparent').isDisabled());
    await page.keyboard.press('Escape');assert.equal(await page.locator('.pick-bar').count(),0);
    await page.locator(`#${id}`).click();await page.locator('#image-transparent').click();await page.waitForSelector(`#${id} .pick-bar`);
    assert.ok(await page.locator(`#${id} .pick-tools`).isHidden(),'slider appears only after a color is picked');
    // Непрозрачная точка: фон этой гравюры уже прозрачный.
    const spot=await page.locator(`#${id} img`).evaluate(img=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;
      for(let y=Math.floor(c.height/2);y<c.height;y++)for(let i=0;i<c.width;i++){const o=(y*c.width+i)*4;if(d[o+3]===255)return {x:i,y,W:c.width,H:c.height};}});
    assert.ok(spot,"opaque pixel");
    const at=async()=>{const r=await page.locator(`#${id} img`).boundingBox();return [r.x+(spot.x+.5)/spot.W*r.width,r.y+(spot.y+.5)/spot.H*r.height];};
    await page.mouse.click(...await at());
    await page.waitForSelector(`#${id}.pick-previewing .pick-range`);
    const count=async()=>{await page.waitForTimeout(150);return Number((await page.locator(`#${id} .crop-save`).getAttribute('title')).match(/станут ([\d\s\u00a0]+) px/)?.[1].replace(/\D/g,'')||0);};
    const setTol=async v=>{await page.locator(`#${id} .pick-range`).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));},v);return count();};
    const c0=await setTol(0),c40=await setTol(40),c5=await setTol(5);
    assert.ok(c0>0&&c40>c5&&c5>=c0,JSON.stringify({c0,c5,c40}));
    assert.equal(await page.locator(`#${id} img`).getAttribute('src'),before.src,'slider does not touch the file');
    const c25=await setTol(25);
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'image-transparent-pick.png')});
    const previewAlpha=await page.locator(`#${id} .pick-preview`).evaluate(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]===0)n++;return n;});
    await page.locator(`#${id} .crop-save`).click();
    await page.waitForFunction(([i,src])=>{const img=document.getElementById(i)?.querySelector('img');return img&&!img.src.endsWith(src)&&img.complete&&img.naturalWidth>0&&!document.querySelector('.pick-bar');},[id,before.src]);
    const after=await page.locator(`#${id}`).evaluate(async el=>{const img=el.querySelector('img'),bmp=await createImageBitmap(await (await fetch(img.src)).blob(),{colorSpaceConversion:'none',premultiplyAlpha:'none'}),c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;const x=c.getContext('2d');x.drawImage(bmp,0,0);
      const p=x.getImageData(0,0,c.width,c.height).data;let clear=0;for(let i=3;i<p.length;i+=4)if(p[i]===0)clear++;return {src:img.getAttribute('src'),w:img.naturalWidth,h:img.naturalHeight,width:el.style.width,clear};});
    assert.deepEqual([after.w,after.h,after.width],[before.w,before.h,before.width]);assert.match(after.src,/\.png$/);
    assert.equal(after.clear,previewAlpha,'server result matches the preview');
    await saved();
    const files=await readdir(path.join(data,'img'));
    assert.ok(files.includes(path.basename(after.src))&&!files.includes(path.basename(before.src)),files.join(','));
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'image-transparent-done.png')});
    pass(`image transparent: pick, tolerance slider rebuilds preview (0:${c0}, 5:${c5}, 25:${c25}, 40:${c40} px), save matches preview, width kept, old file removed`);
  }

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
  // Компактная панель: панель картинки видна только при выбранном изображении, панель текста при этом скрыта.
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  assert.equal(await page.locator('#editor-toolbar').evaluate(el=>Math.round(window.innerHeight-el.getBoundingClientRect().bottom)),0,'ribbon is docked to the bottom edge');
  await clickText('honey');
  assert.equal(await page.locator('#book').getAttribute('spellcheck'),'true');
  assert.ok(await page.locator('#image-tools').isHidden());assert.ok(await page.locator('#text-tools').isVisible());
  await page.locator('.image-shell:not(.figure-image)').first().click();await page.waitForFunction(()=>!document.querySelector('#image-tools').hidden);
  assert.ok(await page.locator('#text-tools').isHidden());assert.ok(await page.locator('#image-wrap').isVisible());
  await page.screenshot({path:path.join(output,'ribbon-image.png'),clip:{x:0,y:940,width:1440,height:160}});
  await clickText('honey');await page.waitForFunction(()=>document.querySelector('#image-tools').hidden);
  await page.screenshot({path:path.join(output,'ribbon-compact.png'),clip:{x:0,y:940,width:1440,height:160}});
  pass('image panel appears only for a selected image and hides the text panel');
  // Настройка стиля: «Обычный текст» по ширине для всей книги, значение видно в панели и после выхода.
  await page.locator('#style-settings').click();await page.waitForFunction(()=>!document.querySelector('#style-editor').hidden);
  assert.equal(await page.locator('#style-target').inputValue(),'p');
  assert.equal(await page.locator('#style-align').inputValue(),'left');
  await page.screenshot({path:path.join(output,'ribbon-style-editor.png'),clip:{x:0,y:940,width:1440,height:160}});
  await page.selectOption('#style-align','justify');await page.locator('#style-apply').click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#honey')).textAlign==='justify');
  assert.equal(await page.locator('#text-align').inputValue(),'justify');
  assert.equal(await page.locator('#garden').evaluate(el=>getComputedStyle(el).textAlign),'justify');
  assert.equal(await page.locator('#subtitle-before').evaluate(el=>getComputedStyle(el).textAlign),'center');
  await page.locator('#style-close').click();
  assert.deepEqual(JSON.parse(await readFile(path.join(data,'styles.json'),'utf8')),{p:{align:'justify'}});
  // Пустые абзацы для отступа между блоками сохраняют высоту строки в читалке.
  await clickText('future');await page.keyboard.press('Home');await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.press('ArrowUp');
  await page.waitForFunction(()=>document.querySelectorAll('#book p:empty, #book p:has(> br:only-child)').length>=2);
  await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#honey')).textAlign==='justify');
  await page.waitForFunction(()=>[...document.querySelectorAll('#book p:empty')].filter(el=>el.getBoundingClientRect().height>20).length>=2);
  const emptyHeights=await page.evaluate(()=>[...document.querySelectorAll('#book p:empty')].map(el=>el.getBoundingClientRect().height));
  assert.ok(emptyHeights.length>=2&&emptyHeights.every(h=>h>20),`empty paragraph heights ${emptyHeights}`);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#book #products'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#honey')).textAlign==='justify');
  await page.waitForFunction(()=>[...document.querySelectorAll('#book p:empty')].filter(el=>el.getBoundingClientRect().height>20).length>=2);
  await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
  await clickText('honey');await page.locator('#style-settings').click();await page.locator('#style-reset').click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#honey')).textAlign!=='justify');
  await page.locator('#style-close').click();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
  pass('named style editing persists to styles.json, applies in editor and reader; empty paragraphs keep their height');
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
  // Номера параграфов: § N. полупрозрачным в отдельной колонке, названия выстроены по одной линии.
  await page.keyboard.press('c');await page.waitForFunction(()=>document.body.classList.contains('panel-open'));
  const tocNumbers=await page.evaluate(()=>[...document.querySelectorAll('.toc-row.level-3')].map(row=>({number:row.querySelector('.toc-number')?.textContent,left:Math.round(row.querySelector('.toc-title, input').getBoundingClientRect().left),opacity:getComputedStyle(row.querySelector('.toc-number')).opacity})));
  assert.ok(tocNumbers.length>2);
  assert.deepEqual(tocNumbers.map(t=>t.number),tocNumbers.map((_,i)=>`§ ${i+1}.`),'paragraph numbers run continuously through the book');
  const tocBook=await (await fetch(base+'/api/book')).json();
  assert.equal(tocBook.toc.find(i=>i.level===1).autoTitle,await page.locator('#book h2').first().evaluate(el=>el.textContent.trim()),'H2 title is taken verbatim, without the H1 part prefix');
  assert.ok(tocNumbers.every(t=>t.left===tocNumbers[0].left&&t.opacity==='0.5'),JSON.stringify(tocNumbers));
  await page.screenshot({path:path.join(output,'toc-numbers.png')});
  await page.locator('#close-panel').click();
  pass('TOC rename/reload/hide/reset remains functional; paragraph numbers aligned in a dimmed column');
  async function selectTextNote(id){
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    // Ждём окончания плавной прокрутки: событие scroll скрывает кнопку «В заметки».
    await page.waitForFunction(()=>new Promise(resolve=>{const y=scrollY;setTimeout(()=>resolve(scrollY===y),400);}));
    const pts=await page.locator(`#${id}`).evaluate(el=>{
      const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,20);
      const a=r.getClientRects()[0],b=[...r.getClientRects()].at(-1);
      return {x1:a.left+1,y1:a.top+a.height/2,x2:b.right-1,y2:b.top+b.height/2};
    });
    await page.mouse.move(pts.x1,pts.y1);await page.mouse.down();await page.mouse.move(pts.x2,pts.y2,{steps:15});await page.mouse.up();
    await page.locator('#selection-note').waitFor({state:'visible'});await page.locator('#selection-note').click();
    await page.waitForSelector(`#${id} mark`);
  }
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
  // Удаление заметки из панели: пропадает подсветка в книге и запись в файле; вторая заметка остаётся.
  await selectTextNote('honey');
  const notesBefore=JSON.parse(await readFile(path.join(data,'notes.json'),'utf8')).length;
  await page.keyboard.press('b');await page.waitForFunction(n=>document.querySelectorAll('.note-delete').length===n,notesBefore);
  await page.screenshot({path:path.join(output,'notes-delete.png')});
  await page.locator('.note-row').filter({hasText:'Мед есть'}).locator('.note-delete').click();
  await page.waitForFunction(n=>document.querySelectorAll('.note-delete').length===n-1&&!document.querySelector('#honey mark'),notesBefore);
  assert.ok(await page.locator('#garden mark').count());
  assert.equal(JSON.parse(await readFile(path.join(data,'notes.json'),'utf8')).length,notesBefore-1);
  await page.locator('#close-panel').click();
  pass('note delete button removes the note, its highlight and the file record');
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
  // Картинка в абзаце и картинка-блок инвертируются одинаково.
  const filters=await page.evaluate(()=>[document.querySelector('#book img.book-image'),document.querySelector('#book .image-figure>img')].map(el=>el&&getComputedStyle(el).filter));
  assert.ok(filters.every(f=>/invert/.test(f||'')),JSON.stringify(filters));
  await page.locator('#toggle-theme').click();await page.locator('#show-help').click();
  await page.locator('#help[open]').waitFor();await page.locator('.dialog-close').click();
  pass('dark mode and help');
  // Черновик из прошлого сеанса: баннер при загрузке, «Открыть в редакторе» подставляет текст и сохраняет его.
  await page.evaluate(()=>localStorage.setItem('izdt:bees:draft',JSON.stringify({html:document.getElementById('book').innerHTML.replace('Проверка офлайн.','Проверка офлайн. Восстановлено из черновика.'),revision:1,time:Date.now()})));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#book #products'));
  await page.locator('#draft-banner:not([hidden])').waitFor();
  await page.locator('#draft-open').click();await page.waitForSelector('#book.ProseMirror');
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent==='Сохранено');
  assert.ok((await readFile(path.join(data,'content.html'),'utf8')).includes('Восстановлено из черновика.'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('izdt:bees:draft')),null);
  await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
  pass('unsaved draft is offered on load and restored into the editor');
  // Медленная загрузка картинок: вход в редактор и выход из него не сдвигают текст, потому что <img> знает свои пропорции (width/height).
  const slowContext=await browser.newContext({viewport:{width:1366,height:768}});const slowPage=await slowContext.newPage();
  const cdp=await slowContext.newCDPSession(slowPage);await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await slowPage.route('**/img/**',async route=>{await new Promise(r=>setTimeout(r,400));await route.continue();});
  await slowPage.goto(base);await slowPage.waitForFunction(()=>document.querySelector('#book #products'));await slowPage.waitForTimeout(1500);
  await slowPage.evaluate(()=>scrollTo(0,2600));await slowPage.waitForTimeout(400);
  const anchor=()=>slowPage.evaluate(()=>{const el=[...document.querySelectorAll('#book [id]')].find(e=>e.getBoundingClientRect().top>150);return `${scrollY} ${el.id} ${Math.round(el.getBoundingClientRect().top)}`;});
  const anchorBefore=await anchor();
  assert.ok(await slowPage.evaluate(()=>[...document.querySelectorAll('#book img[src]')].every(img=>img.getAttribute('width')&&img.getAttribute('height'))),'every reader image carries width/height');
  await slowPage.keyboard.press('Control+e');await slowPage.waitForSelector('#book.ProseMirror');
  for(let i=0;i<6;i++){assert.equal(await anchor(),anchorBefore,`text moved after entering the editor (sample ${i})`);await slowPage.waitForTimeout(150);}
  await slowPage.keyboard.press('Escape');await slowPage.waitForSelector('#book:not(.ProseMirror)');
  for(let i=0;i<6;i++){assert.equal(await anchor(),anchorBefore,`text moved after leaving the editor (sample ${i})`);await slowPage.waitForTimeout(150);}
  await slowContext.close();
  pass('slow images: entering and leaving the editor keeps the reading position');
  // Неразрывные пробелы при вставке, замене выделенного текста, в подписи и заголовке; доходят до сохраненного файла.
  {
    const nb=t=>{const i=new Set(nbspIndices(t));return [...t].map((c,k)=>i.has(k)?NBSP:c).join('');};
    const S='Пчелы в улье и на лугу — 5 кг меда.';
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    const text=id=>page.locator(`#${id}`).evaluate(el=>el.textContent);
    const paste=t=>page.evaluate(t=>navigator.clipboard.writeText(t),t).then(()=>page.keyboard.press('Control+v'));
    // Вставка
    await clickText('harvest');await page.keyboard.press('Home');await paste(S+' ');
    await page.waitForFunction(([id,t])=>document.getElementById(id).textContent.startsWith(t),['harvest',nb(S)]);
    // Замена выделения вводом и вставкой
    await selectText('pollination',20);await page.keyboard.type(S+' ');
    await page.waitForFunction(([id,t])=>document.getElementById(id).textContent.startsWith(t),['pollination',nb(S)]);
    await selectText('example',15);await paste(S+' ');
    await page.waitForFunction(([id,t])=>document.getElementById(id).textContent.startsWith(t),['example',nb(S)]);
    // Заголовок и подпись под картинкой
    await clickText('general');await page.keyboard.press('End');await page.keyboard.type(' и в улье');
    await page.waitForFunction(()=>document.getElementById('general').textContent.endsWith(' и\u00a0в\u00a0улье'));
    const caption=page.locator('figure figcaption p').first();assert.ok(await caption.count(),'a caption exists');
    await caption.click();await page.keyboard.press('End');await page.keyboard.type(' и в улье');
    await page.waitForFunction(()=>document.querySelector('figure figcaption p').textContent.endsWith(' и\u00a0в\u00a0улье'));
    const capId=await caption.getAttribute('id');
    for(const id of ['harvest','pollination','example','general',capId])assert.match(await page.locator(`#${id}`).getAttribute('data-typo')||'',/^[0-9a-z]+$/,id);
    await saved();
    // В файле книги те же неразрывные пробелы.
    const stored=await page.evaluate(async ids=>{const html=(await (await fetch('/api/book')).json()).html,d=new DOMParser().parseFromString(`<div>${html}</div>`,'text/html');return ids.map(id=>d.getElementById(id)?.textContent||'');},['harvest','pollination','example','general',capId]);
    assert.ok(stored[0].startsWith(nb(S))&&stored[1].startsWith(nb(S))&&stored[2].startsWith(nb(S)),JSON.stringify(stored.slice(0,3)));
    assert.ok(stored[3].endsWith(' и\u00a0в\u00a0улье')&&stored[4].endsWith(' и\u00a0в\u00a0улье'),JSON.stringify(stored.slice(3)));
    await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    assert.ok((await text('pollination')).startsWith(nb(S)),'reader shows the same non-breaking spaces');
    pass('non-breaking spaces: paste, replace selection by typing and by paste, heading, figure caption, saved file and reader');
  }
  // Параграф оглавления без нумерации и разрядка: в оглавлении без номера и без разрядки, сквозная нумерация не сбивается.
  {
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    await clickText('example');await page.selectOption('#text-style','paragraph-plain');
    await page.waitForFunction(()=>document.getElementById('example').dataset.style==='paragraph-plain');
    assert.equal(await page.locator('#text-style').inputValue(),'paragraph-plain');
    await selectText('apiaries',10);await number('letter-spacing',.2);
    await page.waitForFunction(()=>[...document.querySelectorAll('#apiaries span')].some(s=>s.style.letterSpacing==='0.2em'));
    assert.equal(await page.locator('#letter-spacing').inputValue(),'0.2');
    await saved();
    const book=await page.evaluate(async()=>(await (await fetch('/api/book')).json()));
    assert.match(book.html,/id="example"[^>]*data-style="paragraph-plain"|data-style="paragraph-plain"[^>]*id="example"/);
    assert.match(book.html,/letter-spacing:0\.2em/);
    const toc=Object.fromEntries(book.toc.map(t=>[t.id,t]));
    assert.equal(toc.example.level,3);assert.equal(toc.example.number,'');assert.equal(toc['distribution-title'].number,'3');assert.equal(toc['benefits-title'].number,'4');
    await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    await page.waitForFunction(()=>{const el=document.querySelector('#book #example');return el?.isConnected&&getComputedStyle(el).fontStyle==='italic';},null,{timeout:5000});
    await page.waitForTimeout(500);await page.evaluate(()=>document.querySelector('#book #apiaries').scrollIntoView({block:'center'}));await page.waitForTimeout(300);
    await page.screenshot({path:path.join(output,'paragraph-plain-spacing.png')});
    // Откат правок, чтобы следующие проверки шли по исходному тексту.
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    await clickText('example');await page.selectOption('#text-style','p');
    await selectText('apiaries',10);await number('letter-spacing',0);
    await page.waitForFunction(()=>![...document.querySelectorAll('#apiaries span')].some(s=>s.style.letterSpacing));
    await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    pass('plain TOC paragraph has no number and keeps numbering; letter spacing is saved and TOC stays plain');
  }
  // Точечная отмена курсива и прописных, заданных стилем: глобальный стиль не меняется.
  {
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    const italic=page.locator('[data-command=italic]'),caps=page.locator('[data-command=caps]');
    await selectText('distribution',10);
    assert.equal(await italic.getAttribute('aria-pressed'),'true');
    await italic.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('#distribution-title span')].some(s=>s.style.fontStyle==='normal'&&getComputedStyle(s).fontStyle==='normal'));
    assert.equal(await italic.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#benefits-title').evaluate(el=>getComputedStyle(el).fontStyle),'italic','other paragraphs keep the style italic');
    await clickText('general');await page.keyboard.press('Home');
    await page.keyboard.down('Shift');for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');await page.keyboard.up('Shift');
    assert.equal(await caps.getAttribute('aria-pressed'),'true');
    await caps.click();
    await page.waitForFunction(()=>[...document.querySelectorAll('#general span')].some(s=>getComputedStyle(s).textTransform==='none'));
    assert.equal(await caps.getAttribute('aria-pressed'),'false');
    // В обычном абзаце кнопка по-прежнему ставит обычный курсив.
    await selectText('apiaries',8);await italic.click();
    await page.waitForFunction(()=>document.querySelector('#apiaries em'));
    await saved();
    const html=(await page.evaluate(async()=>(await (await fetch('/api/book')).json()))).html;
    assert.match(html,/font-style:normal/);assert.match(html,/text-transform:none/);
    const styles=await page.evaluate(async()=>(await (await fetch('/api/book')).json()).styles);
    assert.ok(!styles?.paragraph,'global paragraph style untouched');
    await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    await page.waitForFunction(()=>[...document.querySelectorAll('#book #distribution-title span')].some(s=>getComputedStyle(s).fontStyle==='normal')&&[...document.querySelectorAll('#book #general span')].some(s=>getComputedStyle(s).textTransform==='none'));
    await page.waitForTimeout(500);await page.evaluate(()=>document.querySelector('#book #distribution').scrollIntoView({block:'start'}));await page.waitForTimeout(300);
    await page.screenshot({path:path.join(output,'preset-override.png')});
    // Повторное нажатие возвращает стиль; откат правок.
    await page.keyboard.press('Control+e');await page.waitForSelector('#book.ProseMirror');
    await selectText('distribution',10);await italic.click();
    await page.waitForFunction(()=>![...document.querySelectorAll('#distribution-title span')].some(s=>s.style.fontStyle));
    assert.equal(await italic.getAttribute('aria-pressed'),'true');
    await clickText('general');await page.keyboard.press('Home');
    await page.keyboard.down('Shift');for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');await page.keyboard.up('Shift');
    await caps.click();await page.waitForFunction(()=>![...document.querySelectorAll('#general span')].some(s=>s.style.textTransform));
    await selectText('apiaries',8);await italic.click();await page.waitForFunction(()=>!document.querySelector('#apiaries em'));
    await saved();await page.keyboard.press('Escape');await page.waitForSelector('#book:not(.ProseMirror)');
    pass('style italic and capitals can be removed and restored locally without touching the global style');
  }
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
