// Воспроизведение записанного сценария — без ИИ, только Playwright.
import { performStep } from './browser.js';
import { describeStep } from './scenario.js';

export async function playScenario(session, scenario, { vars = {}, timeout = 10000, log = console.log, failShot = true } = {}) {
  const allVars = { ...(scenario.variables || {}), ...vars };
  const missing = Object.entries(allVars).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  if (missing.length) throw new Error(`Не заданы переменные: ${missing.join(', ')} (используйте --var имя=значение)`);

  if (scenario.startUrl) {
    log(`→ открываю ${scenario.startUrl}`);
    await performStep(session, { action: 'navigate', url: scenario.startUrl }, { vars: allVars, timeout });
  }
  const started = Date.now();
  for (const [i, step] of scenario.steps.entries()) {
    log(describeStep(step, i));
    try {
      await performStep(session, step, { vars: allVars, timeout, log });
    } catch (err) {
      let shot = '';
      if (failShot) {
        shot = `failed-step-${i + 1}.png`;
        await session.page.screenshot({ path: shot }).catch(() => (shot = ''));
      }
      const e = new Error(`Шаг ${i + 1} не выполнен: ${err.message.split('\n')[0]}${shot ? `\nСкриншот: ${shot}` : ''}`);
      e.stepIndex = i;
      throw e;
    }
  }
  log(`✅ Сценарий «${scenario.name}» выполнен: ${scenario.steps.length} шагов за ${((Date.now() - started) / 1000).toFixed(1)}с`);
  return allVars;
}
