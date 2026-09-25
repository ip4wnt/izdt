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
<div id="editor-toolbar" class="toolbar ribbon" hidden aria-label="Форматирование">
<div class="ribbon-row">
<div class="ribbon-group history-controls">
<button data-command="undo" title="Отменить (Ctrl+Z)" aria-label="Отменить">${icon('undo-2')}</button>
<button data-command="redo" title="Повторить (Ctrl+Y)" aria-label="Повторить">${icon('redo-2')}</button></div>
<label>Стиль<select id="text-style" aria-label="Стиль текста"><option value="" disabled>Разные стили</option><option value="p">Обычный текст</option><option value="h1">Заголовок 1</option><option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option><option value="paragraph">Параграф оглавления</option><option value="small">Малый текст</option></select></label>
<label>Шрифт<select id="font-family" aria-label="Шрифт"><option value="" disabled>Разные шрифты</option><option>TT Marxiana</option><option>Akzidenz-Grotesk Pro</option><option>Georgia</option><option>Arial</option></select></label>
<label>Размер · rem<input id="font-size" aria-label="Размер шрифта" type="number" min=".5" max="8" step=".05"></label>
<div class="ribbon-group inline-controls">
<button data-command="bold" title="Полужирный (Ctrl+B)" aria-label="Полужирный" aria-pressed="false"><b>B</b></button>
<button data-command="italic" title="Курсив (Ctrl+I)" aria-label="Курсив" aria-pressed="false"><i>I</i></button>
<button data-command="underline" title="Подчёркивание (Ctrl+U)" aria-label="Подчёркивание" aria-pressed="false"><u>U</u></button>
<button data-command="strikeThrough" title="Зачёркивание" aria-label="Зачёркивание" aria-pressed="false"><s>S</s></button>
<button id="clear-format" title="Убрать ручное форматирование, сохранив стиль" aria-label="Сбросить форматирование">T×</button></div>
<div class="ribbon-save"><span id="save-status" role="status">Сохранено</span><button id="save-book" title="Сохранить (Ctrl+S)" aria-label="Сохранить">${icon('check')}</button><button id="exit-editor" title="Закончить редактирование (Esc)" aria-label="Выйти из редактора">${icon('x')}</button></div>
</div>
<div class="ribbon-row paragraph-controls">
<label>Выравнивание<select id="text-align" aria-label="Выравнивание текста"><option value="" disabled>Разное</option><option value="left">По левому краю</option><option value="center">По центру</option><option value="justify">По ширине</option><option value="right">По правому краю</option></select></label>
<label>↕ Интерлиньяж · rem<input id="line-height" aria-label="Интерлиньяж" type="number" min=".5" max="16" step=".05"></label>
<label>Красная строка · rem<input id="text-indent" aria-label="Красная строка" type="number" min="0" max="10" step=".25"></label>
<div class="ribbon-group insert-controls">
<button id="add-image" title="Вставить изображение из файла" aria-label="Вставить изображение">${icon('image')}<span>Изображение</span></button>
<button id="short-divider" title="Короткий разделитель" aria-label="Короткий разделитель">―<span>Короткая линия</span></button>
<button id="long-divider" title="Длинный разделитель" aria-label="Длинный разделитель">──<span>Длинная линия</span></button>
<button id="typography-all" title="Расставить неразрывные пробелы во всей книге: после предлогов и союзов, между цифрами, перед тире" aria-label="Проверить типографику всей книги">␣<span>Типографика книги</span></button></div>
</div>
<div id="image-tools" class="ribbon-row image-controls">
<span id="image-selection-label">Выберите изображение</span>
<label>Обтекание<select id="image-wrap" aria-label="Обтекание изображения" disabled><option value="inline">В строке с текстом</option><option value="square">Вокруг рамки</option><option value="block">Сверху и снизу</option></select></label>
<label>Положение<select id="image-align" aria-label="Положение изображения" disabled><option value="left">Слева</option><option value="center">По центру</option><option value="right">Справа</option></select></label>
<label>Ширина · %<input id="image-width" aria-label="Ширина изображения" type="number" min="5" max="100" step="5" disabled></label>
<label class="image-alt-label">Описание<input id="image-alt" aria-label="Описание изображения" type="text" maxlength="500" disabled></label>
<button id="figure-text" title="Положить текст поверх картинки: плашку можно перетаскивать и менять по ширине" hidden>Текст на картинке</button>
<button id="delete-image" title="Удалить выбранное изображение" aria-label="Удалить изображение" disabled>${icon('x')}</button>
</div>
<div id="overlay-tools" class="ribbon-row overlay-controls" hidden>
<span class="overlay-label">Текст на картинке</span>
<label>Слева · %<input id="overlay-x" aria-label="Отступ плашки слева" type="number" min="0" max="90" step="1"></label>
<label>Сверху · % ширины<input id="overlay-y" aria-label="Отступ плашки сверху" type="number" min="0" max="300" step="1"></label>
<label>Ширина · %<input id="overlay-width" aria-label="Ширина плашки" type="number" min="10" max="100" step="1"></label>
<button id="detach-overlay" title="Снять текст с картинки: абзацы встанут под ней обычным текстом">Снять текст с картинки</button>
</div></div>
<main id="reading-stage"><article id="book" class="book" spellcheck="false" aria-label="Текст книги">${book.html}</article>
<footer class="colophon"><svg viewBox="0 0 100 24" width="76" height="24" aria-label="IZDT" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h12M9 3v18M3 21h12M23 3h19L23 21h19M51 3v18h7c15 0 15-18 0-18zM78 3h21M88.5 3v18"/></svg><p>Подготовлено издательством IZDT.RU в 2026 году<br>по тексту издания 1907 года.</p></footer></main>
<button id="bookmark-ribbon" class="bookmark-ribbon gone" title="Вернуться к закладке" aria-label="Вернуться к закладке" hidden><img src="./assets/bookmark.png" alt="Цветочная закладка"></button>
<button id="selection-note" class="selection-note" hidden>${icon('pencil-line')} В заметки</button>
<div id="notice" class="notice" role="status" hidden></div>
<input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
<dialog id="help"><button class="dialog-close" aria-label="Закрыть">${icon('x')}</button><h2>IZDT / Чтение и редактура</h2><p>Выделите текст, чтобы сохранить цитату в заметки.</p><dl><dt>E / У</dt><dd>Редактор. Esc: сохранить и выйти</dd><dt>B / И</dt><dd>Заметки</dd><dt>C / С</dt><dd>Оглавление</dd><dt>Ctrl + I</dt><dd>Курсив в редакторе</dd><dt>Ctrl + V</dt><dd>Вставка текста или изображения</dd><dt>Ctrl + S</dt><dd>Сохранить книгу</dd></dl><p>Редактор сам заменяет пробелы на неразрывные в изменённых абзацах: после предлогов и союзов, между цифрами, перед единицами измерения и тире. Кнопка «Типографика книги» проверяет весь текст.</p><p>Версия для настольного браузера. ${book.sharedData?'Заметки и закладка общие: сохраняются в папке книги и синхронизируются командами Git.':'Заметки сохраняются на сервере, закладка хранится в этом браузере.'}</p></dialog>
<script id="initial-state" type="application/json">${JSON.stringify({title:book.title,revision:book.revision,toc:book.toc,overrides:book.overrides,notes:book.notes||[],sharedData:book.sharedData||false,apiBase:base}).replace(/</g,'\\u003c')}</script>
<script type="module" src="./js/app.js"></script></body></html>`;
}
