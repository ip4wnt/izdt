import {escapeHTML as e} from '../shared/model.js';
const icon=(name)=>`<img src="./assets/icons/${name}.svg" alt="" width="22" height="22">`;
export function pageHTML(book, base='') {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(book.title)} · IZDT</title><link rel="icon" href="./assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="./style.css"></head>
<body><a class="skip-link" href="#book">К тексту книги</a>
<nav class="rail" aria-label="Инструменты чтения">
<button id="toggle-toc" title="Оглавление (C / С)" aria-label="Оглавление" aria-expanded="false" class="section-symbol">§</button>
<button id="toggle-notes" title="Заметки (B / И)" aria-label="Заметки" aria-expanded="false">${icon('pencil-line')}</button>
<button id="set-bookmark" title="Поставить или переставить закладку" aria-label="Поставить закладку">${icon('bookmark')}</button>
<div class="rail-bottom"><button id="toggle-editor" title="Редактор (E / У), выход: Esc" aria-label="Редактор"><span class="edit-glyph">A<span>Ⅰ</span></span></button>
<button id="toggle-theme" title="Светлая / тёмная бумага" aria-label="Сменить тему">${icon('sun-moon')}</button>
<button id="show-help" title="Клавиши и сведения" aria-label="Помощь">${icon('info')}</button></div>
</nav>
<aside id="panel" class="panel" inert aria-label="Навигация">
<header class="panel-header"><h2 id="panel-title">ОГЛАВЛЕНИЕ.</h2><div><button id="edit-toc" title="Редактировать оглавление" aria-label="Редактировать оглавление"><span class="edit-glyph">A<span>Ⅰ</span></span></button><button id="close-panel" title="Закрыть панель" aria-label="Закрыть панель">${icon('x')}</button></div></header>
<div id="panel-content"></div></aside>
<div id="editor-toolbar" class="toolbar" hidden aria-label="Форматирование">
<button data-command="undo" title="Отменить" aria-label="Отменить">${icon('undo-2')}</button>
<button data-command="redo" title="Повторить" aria-label="Повторить">${icon('redo-2')}</button>
<select id="text-style" aria-label="Стиль текста"><option value="p">Основной текст</option><option value="h1">Заголовок H1</option><option value="h2">Заголовок H2</option><option value="h3">Заголовок H3</option><option value="paragraph">Параграф</option><option value="small">Малый текст</option></select>
<button data-command="bold" title="Полужирный" aria-label="Полужирный"><b>B</b></button>
<button data-command="italic" title="Курсив (Ctrl+I)" aria-label="Курсив"><i>I</i></button>
<button data-command="underline" title="Подчёркивание" aria-label="Подчёркивание"><u>U</u></button>
<button data-command="strikeThrough" title="Зачёркивание" aria-label="Зачёркивание"><s>S</s></button>
<select id="text-align" aria-label="Выравнивание"><option value="left">По левому</option><option value="center">По центру</option><option value="justify">По ширине</option><option value="right">По правому</option></select>
<button id="more-format" title="Размер, интерлиньяж и отступ" aria-label="Параметры текста">${icon('sliders-horizontal')}</button>
<button id="add-image" title="Вставить изображение" aria-label="Вставить изображение">${icon('image')}</button>
<button id="short-divider" title="Короткий разделитель" aria-label="Короткий разделитель">―</button>
<button id="long-divider" title="Длинный разделитель" aria-label="Длинный разделитель">──</button>
<button id="save-book" title="Сохранить (Ctrl+S)" aria-label="Сохранить">${icon('check')}</button>
<button id="exit-editor" title="Выйти из редактора" aria-label="Выйти из редактора">${icon('x')}</button>
<span id="save-status" role="status">Сохранено</span>
</div>
<form id="format-popover" class="format-popover" hidden>
<label>Размер, rem<input id="font-size" type="number" min=".5" max="8" step=".05" value="2.05"></label>
<label>Интерлиньяж, rem<input id="line-height" type="number" min=".5" max="12" step=".05" value="2.1525"></label>
<label>Красная строка, rem<input id="text-indent" type="number" min="0" max="10" step=".25" value="3.075"></label>
<label>Гарнитура<select id="font-family"><option>TT Marxiana</option><option>Old Standard TT</option><option>Akzidenz-Grotesk Pro</option><option>Roboto Condensed</option></select></label>
<label>Обтекание картинки<select id="image-wrap"><option value="wrap-block">Сверху и снизу</option><option value="wrap-left">Слева, текст справа</option><option value="wrap-right">Справа, текст слева</option><option value="wrap-inline">В строке</option></select></label>
<label>Ширина картинки, %<input id="image-width" type="number" min="10" max="100" step="5" value="45"></label>
<button type="submit">Применить</button></form>
<main id="reading-stage"><article id="book" class="book" spellcheck="false" aria-label="Текст книги">${book.html}</article>
<footer class="colophon"><svg viewBox="0 0 100 24" width="76" height="24" aria-label="IZDT" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h12M9 3v18M3 21h12M23 3h19L23 21h19M51 3v18h7c15 0 15-18 0-18zM78 3h21M88.5 3v18"/></svg><p>Подготовлено издательством IZDT.RU в 2026 году<br>по тексту издания 1907 года.</p></footer></main>
<button id="bookmark-ribbon" class="bookmark-ribbon gone" title="Вернуться к закладке" aria-label="Вернуться к закладке" hidden><img src="./assets/bookmark.png" alt="Цветочная закладка"></button>
<button id="selection-note" class="selection-note" hidden>${icon('pencil-line')} В заметки</button>
<div id="notice" class="notice" role="status" hidden></div>
<input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
<dialog id="help"><button class="dialog-close" aria-label="Закрыть">${icon('x')}</button><h2>IZDT / Чтение и редактура</h2><p>Выделите текст, чтобы сохранить цитату в заметки.</p><dl><dt>E / У</dt><dd>Редактор. Esc: сохранить и выйти</dd><dt>B / И</dt><dd>Заметки</dd><dt>C / С</dt><dd>Оглавление</dd><dt>Ctrl + I</dt><dd>Курсив в редакторе</dd><dt>Ctrl + V</dt><dd>Вставка текста или изображения</dd><dt>Ctrl + S</dt><dd>Сохранить книгу</dd></dl><p>Тестовая версия для настольного браузера. Заметки сохраняются на сервере, закладка хранится в этом браузере.</p></dialog>
<script id="initial-state" type="application/json">${JSON.stringify({title:book.title,revision:book.revision,toc:book.toc,overrides:book.overrides,notes:book.notes||[],apiBase:base}).replace(/</g,'\\u003c')}</script>
<script type="module" src="./js/app.js"></script></body></html>`;
}
