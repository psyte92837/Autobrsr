// Работа с браузером: запуск, снимок страницы для ИИ, построение устойчивых
// селекторов для записи и выполнение действий (общий код для записи и воспроизведения).
import { chromium } from 'playwright';
import fs from 'node:fs';

const FALLBACK_CHROMIUM = '/opt/pw-browsers/chromium';

export async function launchBrowser({ headless = false, slowMo = 0 } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ headless, slowMo });
  } catch (err) {
    // Если браузер Playwright не скачан, пробуем системный путь.
    if (fs.existsSync(FALLBACK_CHROMIUM)) {
      browser = await chromium.launch({ headless, slowMo, executablePath: FALLBACK_CHROMIUM });
    } else {
      throw new Error(`Не удалось запустить Chromium: ${err.message}\nВыполните: npx playwright install chromium`);
    }
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const session = { browser, context, page: await context.newPage() };
  // Новая вкладка (target=_blank, window.open) автоматически становится текущей —
  // одинаково при записи и при воспроизведении.
  context.on('page', (p) => {
    session.page = p;
    p.on('close', () => {
      if (session.page === p) session.page = context.pages().at(-1);
    });
  });
  return session;
}

export async function settle(page, timeout = 5000) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 3000) });
  } catch {
    /* страницы с постоянными запросами никогда не становятся idle — это нормально */
  }
}

// ---------- Снимок страницы для ИИ ----------

// Выполняется внутри страницы: помечает видимые интерактивные элементы
// атрибутом data-ab-id и возвращает их краткое описание.
function collectElements(limit) {
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  document.querySelectorAll('[data-ab-id]').forEach((el) => el.removeAttribute('data-ab-id'));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const clean = (t, n = 80) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const out = [];
  let id = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= limit) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < innerHeight;
    el.setAttribute('data-ab-id', String(++id));
    const tag = el.tagName.toLowerCase();
    const item = { id, tag };
    if (el.type && tag === 'input') item.type = el.type;
    const role = el.getAttribute('role');
    if (role) item.role = role;
    const text = clean(el.innerText || el.textContent);
    if (text) item.text = text;
    for (const a of ['aria-label', 'placeholder', 'name', 'title', 'alt']) {
      const v = el.getAttribute(a);
      if (v) item[a] = clean(v, 60);
    }
    if (tag === 'a') item.href = clean(el.getAttribute('href'), 100);
    if ('value' in el && el.value && tag !== 'button') item.value = clean(String(el.value), 40);
    if (el.checked) item.checked = true;
    if (el.disabled) item.disabled = true;
    if (!inView) item.offscreen = true;
    out.push(item);
  }
  return out;
}

export async function snapshot(page, { limit = 250, textChars = 3000 } = {}) {
  await settle(page, 3000);
  const elements = await page.evaluate(collectElements, limit).catch(() => []);
  const bodyText = await page
    .evaluate((n) => (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, n), textChars)
    .catch(() => '');
  const lines = elements.map((e) => {
    const { id, tag, ...rest } = e;
    const attrs = Object.entries(rest)
      .map(([k, v]) => (v === true ? k : `${k}="${v}"`))
      .join(' ');
    return `[${id}] <${tag}${attrs ? ' ' + attrs : ''}>`;
  });
  return [
    `URL: ${page.url()}`,
    `Заголовок: ${await page.title().catch(() => '')}`,
    '',
    'Интерактивные элементы (используй номер в element_id):',
    lines.join('\n') || '(нет)',
    '',
    'Видимый текст страницы (обрезан):',
    bodyText,
  ].join('\n');
}

export async function screenshotBase64(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
  return buf ? buf.toString('base64') : null;
}

// ---------- Устойчивые селекторы ----------

// Выполняется внутри страницы для конкретного элемента: собирает кандидаты
// селекторов. Уникальность проверяется позже, в Node.
function describeElement(el) {
  const q = (v) => JSON.stringify(v);
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const tag = el.tagName.toLowerCase();
  const css = [];
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(a);
    if (v) css.push(`[${a}=${q(v)}]`);
  }
  // id, похожие на сгенерированные (много цифр, хэши), пропускаем
  if (el.id && !/\d{3,}|[a-f0-9]{8,}|^:r/i.test(el.id)) css.push(`#${CSS.escape(el.id)}`);
  const name = el.getAttribute('name');
  if (name) css.push(`${tag}[name=${q(name)}]`);
  const aria = el.getAttribute('aria-label');
  if (aria) css.push(`${tag}[aria-label=${q(aria)}]`);
  const ph = el.getAttribute('placeholder');
  if (ph) css.push(`${tag}[placeholder=${q(ph)}]`);
  const href = el.getAttribute('href');
  if (tag === 'a' && href && !href.startsWith('javascript')) css.push(`a[href=${q(href)}]`);

  // Абсолютный CSS-путь — самый хрупкий, идёт последним
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    let part = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  const path = parts.join(' > ');

  const implicitRole = {
    a: el.hasAttribute('href') ? 'link' : null, button: 'button', select: 'combobox',
    textarea: 'textbox', summary: null,
  }[tag];
  let role = el.getAttribute('role') || implicitRole || null;
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    role = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', search: 'searchbox',
      range: 'slider', number: 'spinbutton' }[t] || 'textbox';
  }
  const text = clean(el.innerText || el.textContent).slice(0, 100);
  const accName = clean(aria || (['input', 'textarea', 'select'].includes(tag) ? '' : text) ||
    el.getAttribute('title') || (tag === 'input' && ['submit', 'button'].includes(el.type) ? el.value : ''));
  const labelText = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : '';
  return { css, path, role, accName, text, placeholder: ph, label: labelText };
}

export function locatorFor(page, s) {
  switch (s.type) {
    case 'css': return page.locator(s.value);
    case 'role': return page.getByRole(s.role, { name: s.name, exact: true });
    case 'text': return page.getByText(s.value, { exact: true });
    case 'label': return page.getByLabel(s.value, { exact: true });
    case 'placeholder': return page.getByPlaceholder(s.value, { exact: true });
    default: throw new Error(`Неизвестная стратегия: ${s.type}`);
  }
}

// Строит список стратегий поиска элемента, оставляя только те, что находят
// ровно этот элемент. Порядок — от самых устойчивых к самым хрупким.
export async function buildStrategies(page, handle) {
  const d = await handle.evaluate(describeElement);
  const candidates = [];
  for (const c of d.css.filter((c) => !c.startsWith('a[href') && !c.includes('[placeholder'))) {
    candidates.push({ type: 'css', value: c });
  }
  if (d.role && d.accName && d.accName.length <= 80) candidates.push({ type: 'role', role: d.role, name: d.accName });
  if (d.label) candidates.push({ type: 'label', value: d.label });
  if (d.placeholder) candidates.push({ type: 'placeholder', value: d.placeholder });
  for (const c of d.css.filter((c) => c.startsWith('a[href'))) candidates.push({ type: 'css', value: c });
  if (d.text && d.text.length <= 60) candidates.push({ type: 'text', value: d.text });
  candidates.push({ type: 'css', value: d.path });

  const unique = [];
  for (const s of candidates) {
    try {
      const loc = locatorFor(page, s);
      if ((await loc.count()) !== 1) continue;
      const same = await loc.evaluate((el, target) => el === target, handle);
      if (same && !unique.some((u) => JSON.stringify(u) === JSON.stringify(s))) unique.push(s);
    } catch {
      /* некорректный селектор — пропускаем */
    }
  }
  return unique.length ? unique : [{ type: 'css', value: d.path }];
}

// Ищет элемент по записанным стратегиям, пока не истечёт таймаут.
export async function resolveTarget(page, target, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let ambiguous = null;
  while (true) {
    for (const s of target.strategies) {
      try {
        const loc = locatorFor(page, s);
        const n = await loc.count();
        if (n === 1 && (await loc.isVisible())) return { locator: loc, strategy: s };
        if (n > 1 && !ambiguous) ambiguous = { locator: loc.first(), strategy: s };
      } catch {
        /* пробуем следующую стратегию */
      }
    }
    if (Date.now() > deadline) {
      if (ambiguous) return ambiguous;
      throw new Error(`Элемент не найден: ${target.description || JSON.stringify(target.strategies)}`);
    }
    await page.waitForTimeout(250);
  }
}

// ---------- Выполнение шага ----------

export function substitute(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// Выполняет один шаг сценария. `locator` передаётся при записи (элемент уже
// известен), при воспроизведении элемент ищется по target.strategies.
export async function performStep(session, step, { vars = {}, timeout = 10000, locator = null, log = () => {} } = {}) {
  const page = session.page;
  const getLoc = async () => locator || (await resolveTarget(page, step.target, timeout)).locator;
  const value = substitute(step.value, vars);
  let result;
  switch (step.action) {
    case 'navigate':
      await page.goto(substitute(step.url, vars), { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30000) });
      break;
    case 'click': {
      const loc = await getLoc();
      await loc.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
      await loc.click({ timeout });
      break;
    }
    case 'hover':
      await (await getLoc()).hover({ timeout });
      break;
    case 'type': {
      const loc = await getLoc();
      if (step.clear !== false) await loc.fill('', { timeout }).catch(() => {});
      await loc.fill(value ?? '', { timeout }).catch(async () => {
        await loc.click({ timeout });
        await page.keyboard.type(value ?? '', { delay: 20 });
      });
      if (step.submit) await loc.press('Enter', { timeout });
      break;
    }
    case 'select':
      await (await getLoc()).selectOption({ label: value }, { timeout }).catch(async () => {
        await (await getLoc()).selectOption(value, { timeout });
      });
      break;
    case 'check':
      await (await getLoc()).setChecked(step.checked !== false, { timeout });
      break;
    case 'press':
      await page.keyboard.press(step.key);
      break;
    case 'scroll':
      if (step.target) await (await getLoc()).scrollIntoViewIfNeeded({ timeout });
      else await page.mouse.wheel(0, step.direction === 'up' ? -(step.amount || 600) : (step.amount || 600));
      break;
    case 'wait':
      await page.waitForTimeout((step.seconds || 1) * 1000);
      break;
    case 'wait_for_text':
      await page.getByText(value).first().waitFor({ state: 'visible', timeout: Math.max(timeout, (step.seconds || 0) * 1000) });
      break;
    case 'extract': {
      result = step.target ? await (await getLoc()).innerText({ timeout }) : await page.locator('body').innerText();
      result = result.trim();
      log(`  ⇒ ${step.save_as || 'текст'}: ${result.slice(0, 500)}`);
      if (step.save_as) vars[step.save_as] = result;
      break;
    }
    case 'screenshot': {
      const file = substitute(step.path, vars) || `screenshot-${Date.now()}.png`;
      await page.screenshot({ path: file, fullPage: !!step.full_page });
      log(`  ⇒ скриншот: ${file}`);
      result = file;
      break;
    }
    default:
      throw new Error(`Неизвестное действие: ${step.action}`);
  }
  if (!['wait', 'extract', 'screenshot', 'hover'].includes(step.action)) await settle(session.page, 4000);
  return result;
}
