// Хранение сценариев: обычные JSON-файлы в папке scenarios/.
import fs from 'node:fs';
import path from 'node:path';

export const SCENARIO_DIR = process.env.AUTOBRSR_SCENARIOS || path.resolve('scenarios');

export function scenarioPath(nameOrPath) {
  if (nameOrPath.endsWith('.json') || nameOrPath.includes('/')) return path.resolve(nameOrPath);
  return path.join(SCENARIO_DIR, `${nameOrPath}.json`);
}

export function newScenario(name, startUrl) {
  return { name, version: 1, createdAt: new Date().toISOString(), startUrl: startUrl || null, variables: {}, steps: [] };
}

export function saveScenario(scenario, nameOrPath = scenario.name) {
  const file = scenarioPath(nameOrPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  scenario.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(scenario, null, 2) + '\n');
  return file;
}

export function loadScenario(nameOrPath) {
  const file = scenarioPath(nameOrPath);
  if (!fs.existsSync(file)) throw new Error(`Сценарий не найден: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listScenarios() {
  if (!fs.existsSync(SCENARIO_DIR)) return [];
  return fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, f), 'utf8'));
        return { file: f, name: s.name, steps: s.steps.length, variables: Object.keys(s.variables || {}) };
      } catch {
        return { file: f, name: '(повреждён)', steps: 0, variables: [] };
      }
    });
}

// Человекочитаемое описание шага.
export function describeStep(step, i) {
  const t = step.target?.description ? ` «${step.target.description}»` : '';
  const v = step.value !== undefined ? ` = "${step.value}"` : '';
  const extra = {
    navigate: ` ${step.url}`, press: ` ${step.key}`, wait: ` ${step.seconds}с`,
    scroll: step.target ? '' : ` ${step.direction || 'down'}`,
  }[step.action] || '';
  return `${String(i + 1).padStart(2)}. ${step.action}${t}${v}${extra}${step.submit ? ' + Enter' : ''}`;
}
