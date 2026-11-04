// Проверка цикла агента против поддельного API: модель «кликает» кнопку,
// затем отвечает текстом. Настоящий ключ не нужен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

test('цикл агента: tool_use → выполнение → запись шага', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      bodies.push(body);
      const snap = body.messages.at(-1).content[0].text ?? '';
      const id = Number((snap.match(/\[(\d+)\] <button/) || [])[1]);
      const content = bodies.length === 1
        ? [{ type: 'tool_use', id: 'tu_1', name: 'click', input: { element_id: id, description: 'кнопка Войти' } }]
        : [{ type: 'text', text: 'Нажал «Войти».' }];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_' + bodies.length, type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { launchBrowser } = await import('../src/browser.js');
  const { BrowserAgent } = await import('../src/agent.js');
  const { newScenario } = await import('../src/scenario.js');
  const url = 'file://' + path.resolve('test/fixture.html');
  const scenario = newScenario('t', url);
  const session = await launchBrowser({ headless: true });
  await session.page.goto(url);
  const logs = [];
  const agent = new BrowserAgent({ session, scenario, vision: true, log: (m) => logs.push(m) });
  await agent.command('нажми Войти');
  await session.browser.close();
  server.close();

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].fallbacks, 'default');
  assert.equal(bodies[0].messages[0].content[1].type, 'image');
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.is_error, false);
  assert.equal(scenario.steps.length, 1);
  assert.equal(scenario.steps[0].action, 'click');
  assert.ok(logs.some((l) => l.includes('Нажал')));
});
