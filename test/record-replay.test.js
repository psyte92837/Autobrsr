// Сквозной тест без обращения к API: имитируем вызовы инструментов ИИ,
// затем воспроизводим записанный сценарий в новом браузере.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchBrowser, snapshot } from '../src/browser.js';
import { BrowserAgent } from '../src/agent.js';
import { playScenario } from '../src/player.js';
import { newScenario } from '../src/scenario.js';

process.env.ANTHROPIC_API_KEY ||= 'test-key';
const URL = 'file://' + path.resolve('test/fixture.html');

function idOf(snap, needle) {
  const line = snap.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `нет элемента ${needle}`);
  return Number(line.match(/^\[(\d+)\]/)[1]);
}

test('запись действий и воспроизведение без ИИ', async () => {
  const scenario = newScenario('t', URL);
  const s1 = await launchBrowser({ headless: true });
  await s1.page.goto(URL);
  const agent = new BrowserAgent({ session: s1, scenario, vision: false, log: () => {} });
  const call = async (name, input) => {
    const r = await agent.execute({ name, input });
    assert.ok(r.ok, r.message);
  };
  let snap = await snapshot(s1.page);
  await call('type_text', { element_id: idOf(snap, 'name="login"'), description: 'поле логина', text: 'ivan', submit: false, variable: 'login' });
  snap = await snapshot(s1.page);
  await call('select_option', { element_id: idOf(snap, '<select'), description: 'город', option: 'Питер' });
  snap = await snapshot(s1.page);
  await call('set_checkbox', { element_id: idOf(snap, 'type="checkbox"'), description: 'согласие', checked: true });
  snap = await snapshot(s1.page);
  await call('click', { element_id: idOf(snap, 'text="Войти"'), description: 'кнопка Войти' });
  snap = await snapshot(s1.page);
  await call('click', { element_id: idOf(snap, 'Подробнее'), description: 'ссылка Подробнее' });
  await call('extract_text', { element_id: null, description: 'страница', save_as: null });
  assert.equal(await s1.page.textContent('#out'), 'Привет, ivan (spb)');
  await s1.browser.close();

  assert.equal(scenario.steps.length, 6);
  assert.equal(scenario.steps[0].value, '{{login}}');
  assert.equal(scenario.variables.login, 'ivan');

  // Воспроизведение с другой переменной
  const s2 = await launchBrowser({ headless: true });
  const logs = [];
  await playScenario(s2, scenario, { vars: { login: 'petr' }, log: (m) => logs.push(m), failShot: false });
  assert.equal(await s2.page.textContent('#out'), 'Привет, petr (spb)');
  assert.ok(await s2.page.isVisible('#more'));
  await s2.browser.close();
});
