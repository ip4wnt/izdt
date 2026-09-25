import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,makeTOC,annotate,parseFragment,resolveNote} from '../server/document.js';
test('sanitizer removes scripts, handlers, unsafe links and images',()=>{
  const {html}=normalize('<p id="ok" onclick="evil()">Text<script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="https://evil.example/a.png" onerror="evil()"></p>');
  assert.doesNotMatch(html,/onclick|onerror|javascript:|<script|https:\/\/evil/);
});
test('normalization preserves IDs and assigns unique IDs',()=>{
  const a=normalize('<h2 id="chapter">Title</h2><p id="chapter">Text</p><p>New</p>');
  const ids=[...a.root.querySelectorAll('[id]')].map(n=>n.id);
  assert.equal(new Set(ids).size,3);assert.equal(ids[0],'chapter');
  assert.equal(normalize(a.html).html,a.html);
});
test('TOC follows h2, h3 and paragraph and persists overrides',()=>{
  const {root}=normalize('<h1>I.</h1><h2 id="part">Part</h2><h3 id="chapter">Chapter</h3><p><span id="para" data-style="paragraph">1. Paragraph</span>Text</p><h3 id="new">New</h3>');
  const toc=makeTOC(root,{chapter:{title:'Manual'},para:{hidden:true}});
  assert.deepEqual(toc.map(t=>t.level),[1,2,3,2]);
  assert.equal(toc[0].title,'I. Part');assert.equal(toc[1].title,'Manual');assert.equal(toc[2].hidden,true);assert.equal(toc[3].title,'New');
});
test('highlight spans inline formatting, supports overlaps, retains text',()=>{
  const html='<p id="a">Hello <em>beautiful</em> world.</p>';
  const result=annotate(html,[{id:'n1',blockId:'a',start:3,quote:'lo beautiful w'},{id:'n2',blockId:'a',start:6,quote:'beautiful'}]);
  assert.equal(parseFragment(result.html).textContent,'Hello beautiful world.');
  assert.match(result.html,/data-notes="n1 n2"/);assert.ok(!result.notes[0].orphan);
});
test('changed unique quote is relocated, ambiguous or missing is orphaned',()=>{
  const root=parseFragment('<p id="a">prefix quote suffix quote</p>');
  assert.equal(resolveNote(root,{blockId:'a',start:0,quote:'quote'}).orphan,true);
  assert.equal(resolveNote(root,{blockId:'a',start:0,quote:'suffix'}).start,13);
  assert.equal(resolveNote(root,{blockId:'missing',start:0,quote:'quote'}).orphan,true);
});
test('custom typography only permits bounded rem sizes and safe font families',()=>{
  const {html}=normalize('<p style="font-size:2.4rem;line-height:2.8rem;text-indent:3rem;font-family:TT Marxiana;background:url(https://evil)">A</p><p style="font-size:50px">B</p>');
  assert.match(html,/font-size:2.4rem/);assert.doesNotMatch(html,/background|50px/);
});
test('notes follow reading order regardless of creation order',()=>{
  const {notes}=annotate('<h1 id="part">ЧАСТЬ I.</h1><h2 id="h2">Общие указания</h2><h3 id="h3">Глава</h3><p id="a">First</p><p id="b">Second</p>',[
    {id:'two',blockId:'b',start:0,quote:'Second'},{id:'one',blockId:'a',start:0,quote:'First'}
  ]);
  assert.deepEqual(notes.map(n=>n.id),['one','two']);
  assert.equal(notes[0].part,'ЧАСТЬ I. Общие указания');
});
test('image wrapping, alignment, width and font changes survive sanitization',()=>{
  const html='<p id="text"><span style="font-size:2.8rem;font-family:Georgia">Text</span><img id="picture" class="book-image wrap-right" src="/books/bees/img/test.png" data-align="right" style="width:35%" alt="Picture"></p>';
  const normalized=normalize(html);
  assert.equal(normalized.root.querySelector('img').getAttribute('data-align'),'right');
  assert.equal(normalized.root.querySelector('img').getAttribute('style'),'width:35%');
  assert.match(normalized.html,/book-image wrap-right/);
  assert.match(normalized.html,/font-family:Georgia/);
  assert.equal(normalize(normalized.html).html,normalized.html);
});
test('figure with text overlay, nbsp and typography signatures survive sanitization',()=>{
  const html='<figure id="fig" class="image-figure"><img id="pic" class="figure-image" src="/books/bees/img/frontispiece.png" data-align="left" style="width:79.19%" alt="Гравюра"><div id="over" class="image-overlay" style="margin-left:45%;margin-top:52%;width:55%"><h1 id="t" data-typo="1abc">ЧАСТЬ\u00A0I.</h1><p id="p" data-typo="zz9" style="text-align:center">Мед в\u00A0улей</p></div></figure>';
  const normalized=normalize(html);
  assert.equal(normalized.root.querySelector('.image-overlay').getAttribute('style'),'margin-left:45%;margin-top:52%;width:55%');
  assert.equal(normalized.root.querySelector('img').getAttribute('style'),'width:79.19%');
  assert.equal(normalized.root.querySelector('#p').getAttribute('data-typo'),'zz9');
  assert.equal(normalized.root.querySelector('#p').textContent,'Мед в\u00A0улей');
  assert.equal(normalize(normalized.html).html,normalized.html);
  assert.doesNotMatch(normalize('<div class="image-overlay" style="margin-top:900%;margin-left:-5%">x</div>').html,/900|-5/);
});
test('notes match quotes regardless of non-breaking spaces',()=>{
  const root=parseFragment('<p id="a">Мед в\u00A0улей и\u00A0воск</p>');
  assert.equal(resolveNote(root,{blockId:'a',start:4,quote:'в улей'}).orphan,false);
  assert.equal(resolveNote(root,{blockId:'a',start:0,quote:'и воск'}).start,11);
  assert.equal(resolveNote(parseFragment('<p id="a">Мед в улей</p>'),{blockId:'a',start:4,quote:'в\u00A0улей'}).orphan,false);
});
