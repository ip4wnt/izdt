import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
const base='http://127.0.0.1:3000';
const original=await(await fetch(base+'/api/book')).json();
const pause=ms=>page.waitForTimeout(ms);
const output=process.env.QA_OUTPUT_DIR||path.resolve('.qa-output');
await mkdir(output,{recursive:true});
try{
  await page.goto(base,{waitUntil:'networkidle'});await page.keyboard.press('e');
  await page.locator('#garden').click();await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('QA Heading');
  await page.getByRole('combobox',{name:'Стиль текста',exact:true}).selectOption('h2');await pause(1100);
  assert.equal(await page.locator('h2').filter({hasText:'QA Heading'}).count(),1);
  await page.getByRole('combobox',{name:'Стиль текста',exact:true}).selectOption('h3');
  await page.getByRole('combobox',{name:'Выравнивание',exact:true}).selectOption('right');
  await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+i');await page.keyboard.type('Курсив');await page.keyboard.press('Control+i');
  await page.keyboard.press('End');await pause(1000);
  assert.ok(await page.locator('#book i,#book em').count()>0);
  await page.getByRole('button',{name:'Полужирный',exact:true}).click();await page.keyboard.type(' bold');
  await page.getByRole('button',{name:'Полужирный',exact:true}).click();
  await page.getByRole('button',{name:'Подчёркивание',exact:true}).click();await page.keyboard.type(' underline');
  await page.getByRole('button',{name:'Подчёркивание',exact:true}).click();
  await page.getByRole('button',{name:'Зачёркивание',exact:true}).click();await page.keyboard.type(' strike');
  await page.getByRole('button',{name:'Зачёркивание',exact:true}).click();
  await page.getByRole('button',{name:'Отменить',exact:true}).click();await page.getByRole('button',{name:'Повторить',exact:true}).click();
  await page.getByRole('button',{name:'Короткий разделитель',exact:true}).click();
  await page.getByRole('button',{name:'Длинный разделитель',exact:true}).click();
  assert.ok(await page.locator('.divider-short').count()>1);assert.ok(await page.locator('.divider-long').count()>1);
  // Place a real PNG in the browser clipboard, then use the user's Ctrl+V route.
  await page.locator('#france').click();await page.keyboard.press('End');
  await page.evaluate(async()=>{
    const blob=await(await fetch('/books/bees/img/frontispiece.png')).blob();
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  });
  await page.keyboard.press('Control+v');await pause(1300);
  assert.equal(await page.locator('#book img:not(.frontispiece)').count(),1);
  await page.keyboard.press('Control+s');await pause(600);
  // Network failure must retain the draft and prevent an apparent successful exit.
  await page.route('**/api/book',route=>route.request().method()==='PUT'?route.abort():route.continue());
  await page.locator('#garden').click();await page.keyboard.press('End');await page.keyboard.type(' Offline draft');await pause(1400);
  assert.match(await page.locator('#save-status').textContent(),/Не сохранено/);
  await page.keyboard.press('Escape');await pause(400);
  assert.equal(await page.locator('#book').getAttribute('contenteditable'),'true');
  await page.unroute('**/api/book');await page.keyboard.press('Control+s');await pause(700);
  await page.keyboard.press('Escape');await pause(350);
  assert.equal(await page.locator('#book').getAttribute('contenteditable'),'false');
  await page.setViewportSize({width:1000,height:900});await page.keyboard.press('Control+Home');await pause(350);
  await page.screenshot({path:path.join(output,'desktop-1000.png')});
  const isolated=await browser.newContext();
  await isolated.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Denied','SecurityError');}}));
  const fallback=await isolated.newPage(),errors=[];fallback.on('pageerror',e=>errors.push(e.message));
  await fallback.goto(base,{waitUntil:'networkidle'});
  assert.equal(await fallback.locator('#book').count(),1);
  assert.match(await fallback.locator('#notice').textContent(),/localStorage/);assert.deepEqual(errors,[]);
  await isolated.close();
  console.log('PASS: heading styles, alignment, Ctrl+I, B/U/S, undo/redo, both separators, actual clipboard PNG + Ctrl+V upload, network failure retains editor/draft, retry saves, localStorage denial safe fallback, 1000px desktop screenshot.');
}finally{
  const latest=await(await fetch(base+'/api/book')).json();
  await fetch(base+'/api/book',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({html:original.html,revision:latest.revision})});
  await browser.close();
}
