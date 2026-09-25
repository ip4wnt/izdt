import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeStyles, stylesCSS, mergeStyles, BASE_STYLES} from '../shared/model.js';

test('sanitizeStyles оставляет только допустимые отличия от базовых стилей', () => {
  const clean = sanitizeStyles({p:{align:'justify', size:2.05, family:'Comic Sans', leading:99, indent:'2'}, h9:{align:'center'}, h1:{align:'center'}});
  assert.deepEqual(clean, {p:{align:'justify', indent:2}});
  assert.deepEqual(sanitizeStyles(null), {});
});

test('stylesCSS пишет правила только для изменённых стилей и не трогает подписи', () => {
  assert.equal(stylesCSS({}), '');
  const css = stylesCSS({p:{align:'justify'}});
  assert.match(css, /^\.book p:not\(\.small\):not\(\.signature\):not\(\[data-style=paragraph\]\)\{/);
  assert.match(css, /text-align:justify/);
  assert.match(css, /font-size:2\.05rem;line-height:2\.1525rem;text-indent:3\.075rem/);
  assert.equal(mergeStyles({h1:{size:4}}).h1.size, 4);
  assert.equal(BASE_STYLES.h1.size, 3.3825);
});
