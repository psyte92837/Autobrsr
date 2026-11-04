#!/usr/bin/env node
// Точка входа: autobrsr record | run | list | show
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import fs from 'node:fs';
import { launchBrowser, performStep } from './browser.js';
import { BrowserAgent } from './agent.js';
import { playScenario } from './player.js';
import { newScenario, saveScenario, loadScenario, listScenarios, describeStep, scenarioPath } from './scenario.js';

const HELP = `autobrsr — ИИ-автобраузер с записью сценариев

  autobrsr record <имя> [--url URL] [--continue] [--headless] [--no-vision]
      Интерактивный режим: пишете ИИ, что сделать, он кликает, шаги записываются.
      --continue  сначала воспроизвести уже записанный сценарий и дописывать его

  autobrsr run <имя|файл.json> [--var имя=значение ...] [--headless] [--slow-mo мс] [--timeout мс] [--keep-open]
      Запуск записанного сценария БЕЗ ИИ.

  autobrsr list                 список сценариев
  autobrsr show <имя>           шаги сценария

Для записи нужен ключ API: ANTHROPIC_API_KEY (модель: AUTOBRSR_MODEL, по умолчанию claude-opus-5-5).`;

const REPL_HELP = `Пишите команды обычным языком, например: «открой google.com и найди погоду в Москве».
Служебные команды:
  /steps            показать записанные шаги
  /undo             удалить последний шаг из сценария (в браузере ничего не откатывается)
  /go <url>         открыть адрес вручную (тоже записывается)
  /var имя=значение задать значение переменной по умолчанию
  /save [имя]       сохранить сценарий
  /replay           воспроизвести записанное в новой вкладке (проверка без ИИ)
  /quit             сохранить и выйти`;

function parseArgs(argv) {
  const opts = { _: [], vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--var') {
      const [k, ...v] = (argv[++i] || '').split('=');
      opts.vars[k] = v.join('=');
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['url', 'slow-mo', 'timeout'].includes(key)) opts[key] = next, i++;
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

function normalizeUrl(u) {
  if (!u) return u;
  return /^[a-z]+:\/\//i.test(u) ? u : `https://${u}`;
}

async function record(name, opts) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn('⚠ ANTHROPIC_API_KEY не задан — запросы к ИИ, скорее всего, не пройдут.');
  }
  const exists = fs.existsSync(scenarioPath(name));
  let scenario;
  if (exists && opts.continue) scenario = loadScenario(name);
  else if (exists) {
    console.error(`Сценарий «${name}» уже есть. Используйте --continue, чтобы дописать, или другое имя.`);
    process.exit(1);
  } else scenario = newScenario(name, normalizeUrl(opts.url));

  const session = await launchBrowser({ headless: !!opts.headless });
  const log = (m) => console.log(m);
  if (opts.continue && exists) {
    console.log('↻ Воспроизвожу уже записанные шаги...');
    await playScenario(session, scenario, { log });
  } else if (scenario.startUrl) {
    await performStep(session, { action: 'navigate', url: scenario.startUrl }, {});
  }

  const agent = new BrowserAgent({ session, scenario, vision: !opts['no-vision'], log });
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`\nЗапись сценария «${name}». /help — справка.\n`);
  let dirty = false;

  try {
    while (true) {
      let line;
      try {
        line = (await rl.question('вы> ')).trim();
      } catch {
        break; // Ctrl+D / закрытый ввод
      }
      if (!line) continue;
      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.slice(1).split(' ');
        const arg = rest.join(' ').trim();
        if (cmd === 'quit' || cmd === 'exit') break;
        else if (cmd === 'help') console.log(REPL_HELP);
        else if (cmd === 'steps') console.log(scenario.steps.map(describeStep).join('\n') || '(пусто)');
        else if (cmd === 'undo') {
          const s = scenario.steps.pop();
          console.log(s ? `Удалён: ${describeStep(s, scenario.steps.length)}` : 'Нечего удалять');
          dirty = true;
        } else if (cmd === 'go') {
          const step = { action: 'navigate', url: normalizeUrl(arg) };
          if (!scenario.startUrl && scenario.steps.length === 0) scenario.startUrl = step.url;
          else scenario.steps.push(step);
          await performStep(session, step, {}).catch((e) => console.log(`✘ ${e.message}`));
          dirty = true;
        } else if (cmd === 'var') {
          const [k, ...v] = arg.split('=');
          scenario.variables[k.trim()] = v.join('=');
          dirty = true;
        } else if (cmd === 'save') {
          if (arg) scenario.name = arg;
          console.log(`💾 Сохранено: ${saveScenario(scenario, scenario.name)}`);
          dirty = false;
        } else if (cmd === 'replay') {
          const page = await session.context.newPage();
          const s2 = { ...session, page };
          await playScenario(s2, scenario, { log }).catch((e) => console.log(`✘ ${e.message}`));
          await page.close();
        } else console.log('Неизвестная команда. /help — справка.');
        continue;
      }
      const before = scenario.steps.length;
      try {
        await agent.command(line);
      } catch (err) {
        console.log(`✘ Ошибка ИИ: ${err.message}`);
      }
      if (scenario.steps.length !== before) dirty = true;
    }
  } finally {
    rl.close();
    if (dirty || !exists) console.log(`💾 Сохранено: ${saveScenario(scenario, scenario.name)}`);
    await session.browser.close();
  }
}

async function run(name, opts) {
  const scenario = loadScenario(name);
  const session = await launchBrowser({ headless: !!opts.headless, slowMo: Number(opts['slow-mo'] || 0) });
  let code = 0;
  try {
    await playScenario(session, scenario, { vars: opts.vars, timeout: Number(opts.timeout || 10000) });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    code = 1;
  }
  if (opts['keep-open'] && !opts.headless) {
    console.log('Браузер открыт. Нажмите Enter, чтобы закрыть.');
    const rl = readline.createInterface({ input: stdin, output: stdout });
    await rl.question('');
    rl.close();
  }
  await session.browser.close();
  process.exit(code);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const name = opts._[0];
  switch (cmd) {
    case 'record':
      if (!name) return console.log(HELP);
      return record(name, opts);
    case 'run':
      if (!name) return console.log(HELP);
      return run(name, opts);
    case 'list': {
      const items = listScenarios();
      if (!items.length) return console.log('Сценариев пока нет. Создайте: autobrsr record <имя> --url <адрес>');
      for (const s of items) {
        console.log(`${s.file.replace(/\.json$/, '')}  — ${s.steps} шагов${s.variables.length ? `, переменные: ${s.variables.join(', ')}` : ''}`);
      }
      return;
    }
    case 'show': {
      if (!name) return console.log(HELP);
      const s = loadScenario(name);
      console.log(`«${s.name}»  старт: ${s.startUrl || '-'}`);
      if (Object.keys(s.variables || {}).length) console.log('Переменные:', s.variables);
      console.log(s.steps.map(describeStep).join('\n'));
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
