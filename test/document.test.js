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
