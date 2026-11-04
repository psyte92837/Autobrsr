// Помощник, который встраивается в каждую страницу WebView.
// Делает снимок страницы для ИИ, строит устойчивые селекторы, ищет элементы
// по записанным селекторам, выполняет действия и (при записи) ловит ручные
// нажатия пользователя. Все функции возвращают JSON-строку.
(function () {
  if (window.__ab) return;

  var INTERACTIVE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  var TEXTY = 'a,button,label,span,div,li,td,th,p,h1,h2,h3,h4,h5,h6,summary,option,[role]';

  function clean(t, n) {
    t = (t || '').replace(/\s+/g, ' ').trim();
    return n ? t.slice(0, n) : t;
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function q(v) { return JSON.stringify(v); }
  function out(obj) { return JSON.stringify(obj); }

  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
        search: 'searchbox', range: 'slider', number: 'spinbutton' })[t] || 'textbox';
    }
    return null;
  }
  function nameOf(el) {
    var tag = el.tagName.toLowerCase();
    var aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (tag === 'input' && (el.type === 'submit' || el.type === 'button')) return clean(el.value);
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
      var t = clean(el.innerText || el.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute('title') || '');
  }
  function labelOf(el) {
    if (el.labels && el.labels[0]) return clean(el.labels[0].innerText);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var l = document.getElementById(by.split(' ')[0]);
      if (l) return clean(l.innerText);
    }
    return '';
  }
  function cssPath(el) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      var part = cur.tagName.toLowerCase();
      var parent = cur.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === cur.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ---------- поиск по стратегиям ----------

  function findAll(s) {
    var list = [];
    try {
      if (s.type === 'css') {
        list = Array.prototype.slice.call(document.querySelectorAll(s.value));
      } else if (s.type === 'role') {
        var cand = document.querySelectorAll(INTERACTIVE + ',[role]');
        for (var i = 0; i < cand.length; i++) {
          if (roleOf(cand[i]) === s.role && nameOf(cand[i]) === s.name) list.push(cand[i]);
        }
      } else if (s.type === 'placeholder') {
        var ph = document.querySelectorAll('[placeholder]');
        for (var j = 0; j < ph.length; j++) if (clean(ph[j].getAttribute('placeholder')) === s.value) list.push(ph[j]);
      } else if (s.type === 'label') {
        var f = document.querySelectorAll('input,select,textarea,[aria-labelledby]');
        for (var k = 0; k < f.length; k++) if (labelOf(f[k]) === s.value) list.push(f[k]);
      } else if (s.type === 'text') {
        var all = document.querySelectorAll(TEXTY);
        for (var m = 0; m < all.length; m++) {
          if (clean(all[m].innerText || all[m].textContent) === s.value) list.push(all[m]);
        }
        // оставляем самые вложенные совпадения
        list = list.filter(function (a) {
          return !list.some(function (b) { return b !== a && a.contains(b); });
        });
      }
    } catch (e) { list = []; }
    return list;
  }

  function strategiesFor(el) {
    var tag = el.tagName.toLowerCase();
    var c = [];
    ['data-testid', 'data-test', 'data-qa', 'data-cy'].forEach(function (a) {
      var v = el.getAttribute(a);
      if (v) c.push({ type: 'css', value: '[' + a + '=' + q(v) + ']' });
    });
    if (el.id && !/\d{3,}|[a-f0-9]{8,}|^:r/i.test(el.id)) c.push({ type: 'css', value: '#' + CSS.escape(el.id) });
    var nm = el.getAttribute('name');
    if (nm) c.push({ type: 'css', value: tag + '[name=' + q(nm) + ']' });
    var aria = el.getAttribute('aria-label');
    if (aria) c.push({ type: 'css', value: tag + '[aria-label=' + q(aria) + ']' });
    var role = roleOf(el), name = nameOf(el);
    if (role && name && name.length <= 80) c.push({ type: 'role', role: role, name: name });
    var lbl = labelOf(el);
    if (lbl) c.push({ type: 'label', value: lbl });
    var ph = el.getAttribute('placeholder');
    if (ph) c.push({ type: 'placeholder', value: clean(ph) });
    var href = el.getAttribute('href');
    if (tag === 'a' && href && href.indexOf('javascript') !== 0) c.push({ type: 'css', value: 'a[href=' + q(href) + ']' });
    var text = clean(el.innerText || el.textContent);
    if (text && text.length <= 60 && tag !== 'input') c.push({ type: 'text', value: text });
    var path = cssPath(el);
    c.push({ type: 'css', value: path });

    var res = [], seen = {};
    c.forEach(function (s) {
      var key = JSON.stringify(s);
      if (seen[key]) return;
      var found = findAll(s);
      if (found.length === 1 && found[0] === el) { res.push(s); seen[key] = 1; }
    });
    if (!res.length) res.push({ type: 'css', value: path });
    return res;
  }

  var targets = [];
  function mark(el) { targets.push(el); return targets.length - 1; }
  function byRef(ref) {
    if (typeof ref === 'number') return targets[ref];
    return document.querySelector('[data-ab-id="' + ref + '"]');
  }

  // ---------- имитация ввода ----------

  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype :
      el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var ab = {
    suppressUntil: 0,

    snapshot: function (limit, textChars) {
      var old = document.querySelectorAll('[data-ab-id]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-ab-id');
      var items = [], id = 0, els = document.querySelectorAll(INTERACTIVE);
      for (var j = 0; j < els.length && items.length < limit; j++) {
        var el = els[j];
        if (!visible(el)) continue;
        el.setAttribute('data-ab-id', String(++id));
        var tag = el.tagName.toLowerCase(), r = el.getBoundingClientRect();
        var parts = ['[' + id + '] <' + tag];
        if (tag === 'input') parts.push('type="' + (el.type || 'text') + '"');
        var role = el.getAttribute('role');
        if (role) parts.push('role="' + role + '"');
        var text = clean(el.innerText || el.textContent, 80);
        if (text) parts.push('text="' + text + '"');
        ['aria-label', 'placeholder', 'name', 'title', 'alt'].forEach(function (a) {
          var v = el.getAttribute(a);
          if (v) parts.push(a + '="' + clean(v, 60) + '"');
        });
        if (tag === 'a') parts.push('href="' + clean(el.getAttribute('href'), 100) + '"');
        if ('value' in el && el.value && tag !== 'button' && el.type !== 'password') parts.push('value="' + clean(String(el.value), 40) + '"');
        if (el.checked) parts.push('checked');
        if (el.disabled) parts.push('disabled');
        if (r.bottom < 0 || r.top > innerHeight) parts.push('offscreen');
        items.push(parts.join(' ') + '>');
      }
      var body = (document.body && document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, textChars);
      return out({ url: location.href, title: document.title, elements: items, text: body });
    },

    // id из снимка → селекторы + ссылка на элемент
    describe: function (snapId) {
      var el = byRef(String(snapId));
      if (!el) return out({ error: 'элемента [' + snapId + '] нет на странице' });
      return out({ ref: mark(el), strategies: strategiesFor(el) });
    },

    // селекторы → ссылка на элемент (при воспроизведении)
    resolve: function (strategiesJson) {
      var list = JSON.parse(strategiesJson), fallback = null;
      for (var i = 0; i < list.length; i++) {
        var found = findAll(list[i]).filter(visible);
        if (found.length === 1) return out({ ref: mark(found[0]), used: i });
        if (found.length > 1 && fallback === null) fallback = { ref: mark(found[0]), used: i, ambiguous: true };
      }
      return out(fallback || { error: 'not_found' });
    },

    // прокручивает к элементу и возвращает его центр (CSS-пиксели) для нативного касания
    point: function (ref) {
      var el = byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var top = document.elementFromPoint(x, y);
      var hittable = !!top && (top === el || el.contains(top) || top.contains(el));
      return out({ x: x, y: y, dpr: window.devicePixelRatio || 1, hittable: hittable });
    },

    jsClick: function (ref) {
      var el = byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
      el.click();
      return out({ ok: true });
    },

    type: function (ref, value, clear) {
      var el = byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = clear ? value : el.textContent + value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        setValue(el, clear ? value : (el.value || '') + value);
      }
      return out({ ok: true });
    },

    focus: function (ref) {
      var el = byRef(ref);
      if (el) el.focus();
      return out({ ok: !!el });
    },

    // Enter для поля: сначала событие клавиши, затем отправка формы, если её не перехватили
    submit: function (ref) {
      var el = byRef(ref) || document.activeElement;
      if (!el) return out({ error: 'нет активного поля' });
      var prevented = false;
      ['keydown', 'keypress', 'keyup'].forEach(function (t) {
        var ev = new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        if (!el.dispatchEvent(ev)) prevented = true;
      });
      if (!prevented && el.form) {
        if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
      }
      return out({ ok: true });
    },

    key: function (key) {
      var el = document.activeElement || document.body;
      ['keydown', 'keyup'].forEach(function (t) {
        el.dispatchEvent(new KeyboardEvent(t, { key: key, bubbles: true, cancelable: true }));
      });
      return out({ ok: true });
    },

    select: function (ref, option) {
      var el = byRef(ref);
      if (!el || el.tagName !== 'SELECT') return out({ error: 'это не выпадающий список' });
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (clean(o.text) === clean(option) || o.value === option) {
          setValue(el, o.value);
          return out({ ok: true });
        }
      }
      return out({ error: 'нет пункта «' + option + '»' });
    },

    isChecked: function (ref) {
      var el = byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      var v = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
      return out({ checked: !!v });
    },

    hover: function (ref) {
      var el = byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      ['pointerover', 'mouseover', 'mouseenter'].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter', view: window }));
      });
      return out({ ok: true });
    },

    scroll: function (dir) {
      window.scrollBy(0, (dir === 'up' ? -1 : 1) * innerHeight * 0.8);
      return out({ ok: true });
    },

    text: function (ref) {
      var el = ref === null ? document.body : byRef(ref);
      if (!el) return out({ error: 'элемент пропал со страницы' });
      return out({ text: clean(el.innerText || el.textContent || '', 4000) });
    },

    hasText: function (t) {
      return out({ found: (document.body && document.body.innerText || '').indexOf(t) >= 0 });
    },

    ready: function () {
      return out({ state: document.readyState });
    },

    suppress: function (ms) {
      ab.suppressUntil = Date.now() + ms;
      return out({ ok: true });
    }
  };
  window.__ab = ab;

  // ---------- запись ручных действий пользователя ----------
  // Реагируем только на настоящие (isTrusted) события, когда приложение не
  // выполняет действие само (suppressUntil).

  function report(kind, el, extra) {
    if (!window.AB || !window.AB.onUserAction) return;
    if (Date.now() < ab.suppressUntil) return;
    var payload = { kind: kind, strategies: strategiesFor(el), description: describeHuman(el) };
    for (var k in extra) payload[k] = extra[k];
    window.AB.onUserAction(JSON.stringify(payload));
  }
  function describeHuman(el) {
    var tag = el.tagName.toLowerCase();
    var kind = { a: 'ссылка', button: 'кнопка', input: 'поле', select: 'список', textarea: 'поле' }[tag] || tag;
    var name = nameOf(el) || labelOf(el) || clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
    return clean(kind + (name ? ' «' + clean(name, 40) + '»' : ''));
  }
  function isTextField(el) {
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return ['checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'file', 'range', 'color'].indexOf((el.type || 'text').toLowerCase()) < 0;
  }

  var lastEnterAt = 0;

  document.addEventListener('click', function (e) {
    if (!e.isTrusted) return;
    // Enter в поле формы порождает «клик» по кнопке отправки — он уже записан как submit
    if (e.detail === 0 && Date.now() - lastEnterAt < 1000) return;
    var el = e.target.closest ? e.target.closest(INTERACTIVE + ',label') : null;
    if (!el) el = e.target;
    if (el.nodeType !== 1) return;
    var tag = el.tagName;
    // переключатели и поля записываются через change, клик по label дублирует их
    if (tag === 'SELECT' || isTextField(el)) return;
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
    if (tag === 'LABEL' && el.control) return;
    report('click', el, {});
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    // выбор в нативном списке на некоторых WebView приходит как недоверенное событие
    if (!e.isTrusted && el.tagName !== 'SELECT') return;
    if (el.tagName === 'SELECT') {
      report('select', el, { value: clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value) });
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      report('check', el, { checked: el.checked });
    } else if (isTextField(el)) {
      report('type', el, { value: el.value, password: el.type === 'password' });
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!e.isTrusted || e.key !== 'Enter') return;
    lastEnterAt = Date.now();
    var el = e.target;
    if (el && isTextField(el) && el.tagName !== 'TEXTAREA') {
      // сначала значение поля (change может не успеть сработать до отправки формы)
      report('type', el, { value: el.value, password: el.type === 'password', submit: true });
    }
  }, true);
})();
