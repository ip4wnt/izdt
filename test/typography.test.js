import test from 'node:test';
import assert from 'node:assert/strict';
import {applyNbsp, nbspIndices, signature, NBSP} from '../client/typography.js';
const shown=text=>applyNbsp(text).replaceAll(NBSP,'_');
test('prepositions, conjunctions and particles stick to the next or previous word',()=>{
  assert.equal(shown('Мед в улей и воск, а не так же ли, из-за пчел, для них.'),'Мед в_улей и_воск, а_не_так_же_ли, из-за_пчел, для_них.');
  assert.equal(shown('Корова и теленок.'),'Корова и_теленок.');
});
test('numbers stay with digit groups, units, currency and years',()=>{
  assert.equal(shown('178 138 пуд. за 1901 г. по 5 руб., 12 %, 3 ₽, № 5, стр. 12'),'178_138_пуд. за_1901_г. по_5_руб., 12_%, 3_₽, №_5, стр._12');
});
test('dash never starts a line; abbreviations and initials hold together',()=>{
  assert.equal(shown('Пчеловодство — уход за пчелами - вот так, т. е. и т. д., И. И. Иванов.'),'Пчеловодство_— уход за_пчелами_- вот так, т._е. и_т._д., И._И._Иванов.');
  assert.equal(shown('— Начало реплики.'),'—_Начало реплики.');
});
test('only existing plain spaces change; length and other characters are preserved',()=>{
  const text='Уже\u00A0стоит и обычный пробел, слово-с-дефисом, «в» кавычках.';
  const out=applyNbsp(text);
  assert.equal(out.length,text.length);
  assert.equal(out.replaceAll(NBSP,' '),text.replaceAll(NBSP,' '));
  assert.equal(applyNbsp(out),out);
  assert.deepEqual(nbspIndices('без пробелов'),[3]);
  assert.deepEqual(nbspIndices('слово другое'),[]);
});
test('signature is stable, short and changes with text',()=>{
  assert.equal(signature('abc'),signature('abc'));
  assert.notEqual(signature('abc'),signature('abd'));
  assert.match(signature('Мед в улей'),/^[0-9a-z]{1,8}$/);
});
