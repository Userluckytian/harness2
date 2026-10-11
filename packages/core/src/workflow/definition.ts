// A14 工作流定义：解析（fail-closed）+ 项目/用户目录发现。
//
// 格式：JSON 文件，路径 `<root>/.harness2/workflows/<name>.json`（项目）与
// `~/.harness2/workflows/<name>.json`（用户）——对齐 ZCode 的 `.zcode/workflows/`
// 约定与我们的 `.harness2` 目录惯例（config/load.ts 的 HARNESS_DIR）。
// 与 ZCode 的差异：ZCode 的工作流是**可执行 TS 脚本**（含 agent() 调用）；我们不执行
// 用户脚本（无沙箱、不引依赖），只读**声明式 JSON**——步骤类型与执行体由宿主注入的
// runner 决定。这是刻意的裁剪（见报告）。
//
// fail-closed 口径：
//   - 任一字段缺失/类型不符/取值越界/未知键 → 抛错（不部分接受、不静默截断）；
//   - 步骤 id 重复、dependsOn 指向未知步骤或自环、依赖图有环 → 抛错；
//   - 步骤数 > WORKFLOW_MAX_STEPS、timeout > 上限、并发 > 天花板、重试 > 上限 → 抛错。
// 发现时每个文件独立判定：非法文件不进可运行集，如实登记进 errors（不 throw 中断整轮）。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_DIR } from '../config/load.js';
import {
  WORKFLOW_DEFAULT_MAX_CONCURRENCY,
  WORKFLOW_DEFAULT_RETRIES,
  WORKFLOW_DEFAULT_STEP_TIMEOUT_MS,
  WORKFLOW_FAILURE_POLICIES,
  WORKFLOW_MAX_CONCURRENCY_CEILING,
  WORKFLOW_MAX_RETRIES,
  WORKFLOW_MAX_STEP_TIMEOUT_MS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_TYPES,
  type DiscoveredWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowDefinitionError,
  type WorkflowDefinitionScope,
  type WorkflowFailurePolicy,
  type WorkflowStepDefinition,
  type WorkflowStepType,
  type WorkflowStepWriteMode,
} from './types.js';

/** 定义 id 约束（与命令 id 同风格：小写字母开头，仅小写字母/数字/连字符） */
const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** 步骤 id 约束（允许大写/下划线，仍禁空白与路径分隔） */
const STEP_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 定义文件所在目录名（`<root>/.harness2/workflows`） */
export const WORKFLOW_DIR_NAME = 'workflows';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function fail(message: string): never {
  throw new Error(`workflow definition invalid: ${message}`);
}

function assertKnownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}"`);
  }
}

const DEFINITION_KEYS = [
  'name',
  'description',
  'version',
  'failurePolicy',
  'maxConcurrency',
  'maxRetries',
  'steps',
] as const;

const STEP_KEYS = [
  'id',
  'type',
  'title',
  'prompt',
  'model',
  'tool',
  'args',
  'dependsOn',
  'timeoutMs',
  'writeMode',
  'maxRetries',
] as const;

/** 解析并校验一个工作流定义；非法即抛（fail-closed）。 */
export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (!isRecord(raw)) fail('root must be a JSON object');
  assertKnownKeys(raw, DEFINITION_KEYS, 'root');

  const name = raw['name'];
  if (!isNonEmptyString(name) || !NAME_RE.test(name)) {
    fail(`name must match ${NAME_RE}（小写字母开头，仅小写字母/数字/连字符）`);
  }
  const description = raw['description'];
  if (!isNonEmptyString(description)) fail('description must be a non-empty string');
  const version = raw['version'] === undefined ? '1' : raw['version'];
  if (!isNonEmptyString(version)) fail('version must be a non-empty string');

  const failurePolicyRaw = raw['failurePolicy'] ?? 'stop';
  if (
    typeof failurePolicyRaw !== 'string' ||
    !(WORKFLOW_FAILURE_POLICIES as readonly string[]).includes(failurePolicyRaw)
  ) {
    fail(`failurePolicy must be one of ${WORKFLOW_FAILURE_POLICIES.join('|')}`);
  }
  const failurePolicy = failurePolicyRaw as WorkflowFailurePolicy;

  const maxConcurrencyRaw = raw['maxConcurrency'] ?? WORKFLOW_DEFAULT_MAX_CONCURRENCY;
  if (!isPositiveInteger(maxConcurrencyRaw) || maxConcurrencyRaw > WORKFLOW_MAX_CONCURRENCY_CEILING) {
    fail(`maxConcurrency must be an integer in 1..${WORKFLOW_MAX_CONCURRENCY_CEILING}`);
  }
  const maxConcurrency = maxConcurrencyRaw;

  const maxRetriesRaw = raw['maxRetries'] ?? WORKFLOW_DEFAULT_RETRIES;
  if (!isNonNegativeInteger(maxRetriesRaw) || maxRetriesRaw > WORKFLOW_MAX_RETRIES) {
    fail(`maxRetries must be an integer in 0..${WORKFLOW_MAX_RETRIES}`);
  }
  const maxRetries = maxRetriesRaw;

  const stepsRaw = raw['steps'];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) fail('steps must be a non-empty array');
  if (stepsRaw.length > WORKFLOW_MAX_STEPS) {
    fail(`steps length ${stepsRaw.length} exceeds limit ${WORKFLOW_MAX_STEPS}`);
  }

  const steps: WorkflowStepDefinition[] = [];
  let previousId: string | undefined;
  stepsRaw.forEach((step, index) => {
    const parsed = parseStep(step, index, failurePolicy, previousId);
    steps.push(parsed);
    previousId = parsed.id;
  });

  validateStepGraph(steps);
  return { name, description, version, failurePolicy, maxConcurrency, maxRetries, steps };
}

function parseStep(
  raw: unknown,
  index: number,
  policy: WorkflowFailurePolicy,
  previousId: string | undefined,
): WorkflowStepDefinition {
  const where = `steps[${index}]`;
  if (!isRecord(raw)) fail(`${where} must be an object`);
  assertKnownKeys(raw, STEP_KEYS, where);

  const id = raw['id'];
  if (!isNonEmptyString(id) || !STEP_ID_RE.test(id)) fail(`${where}.id must match ${STEP_ID_RE}`);
  const typeRaw = raw['type'];
  if (typeof typeRaw !== 'string' || !(WORKFLOW_STEP_TYPES as readonly string[]).includes(typeRaw)) {
    fail(`${where}.type must be one of ${WORKFLOW_STEP_TYPES.join('|')}`);
  }
  const type = typeRaw as WorkflowStepType;

  const title = raw['title'] === undefined ? id : raw['title'];
  if (!isNonEmptyString(title)) fail(`${where}.title must be a non-empty string`);

  const prompt = raw['prompt'];
  if (prompt !== undefined && !isNonEmptyString(prompt)) fail(`${where}.prompt must be a non-empty string`);
  const model = raw['model'];
  if (model !== undefined && !isNonEmptyString(model)) fail(`${where}.model must be a non-empty string`);
  const tool = raw['tool'];
  if (tool !== undefined && !isNonEmptyString(tool)) fail(`${where}.tool must be a non-empty string`);

  // 类型专属必填（fail-closed：缺执行体即无意义步骤）
  if (type === 'prompt' && prompt === undefined) fail(`${where}: prompt step requires "prompt"`);
  if (type === 'subagent' && prompt === undefined) fail(`${where}: subagent step requires "prompt"`);
  if (type === 'tool' && tool === undefined) fail(`${where}: tool step requires "tool"`);

  const timeoutRaw = raw['timeoutMs'] ?? WORKFLOW_DEFAULT_STEP_TIMEOUT_MS;
  if (!isPositiveInteger(timeoutRaw) || timeoutRaw > WORKFLOW_MAX_STEP_TIMEOUT_MS) {
    fail(`${where}.timeoutMs must be an integer in 1..${WORKFLOW_MAX_STEP_TIMEOUT_MS}`);
  }
  const timeoutMs = timeoutRaw;

  const writeModeRaw = raw['writeMode'] ?? 'readonly';
  if (writeModeRaw !== 'readonly' && writeModeRaw !== 'write') {
    fail(`${where}.writeMode must be "readonly" | "write"`);
  }
  const writeMode = writeModeRaw as WorkflowStepWriteMode;

  const maxRetriesRaw = raw['maxRetries'];
  if (maxRetriesRaw !== undefined && (!isNonNegativeInteger(maxRetriesRaw) || maxRetriesRaw > WORKFLOW_MAX_RETRIES)) {
    fail(`${where}.maxRetries must be an integer in 0..${WORKFLOW_MAX_RETRIES}`);
  }
  const maxRetries = maxRetriesRaw as number | undefined;

  // dependsOn：缺席 = 依赖声明前一步（链式）；显式数组 = 按其内容（可空 = 无依赖/可并发）
  let dependsOn: readonly string[];
  if (raw['dependsOn'] === undefined) {
    dependsOn = previousId === undefined ? [] : [previousId];
  } else {
    const depsRaw = raw['dependsOn'];
    if (!Array.isArray(depsRaw)) fail(`${where}.dependsOn must be an array of step ids`);
    const seen = new Set<string>();
    for (const dep of depsRaw) {
      if (!isNonEmptyString(dep) || !STEP_ID_RE.test(dep)) fail(`${where}.dependsOn has invalid step id`);
      if (seen.has(dep)) fail(`${where}.dependsOn has duplicate "${dep}"`);
      seen.add(dep);
    }
    dependsOn = [...depsRaw] as string[];
  }

  const step: WorkflowStepDefinition = {
    id,
    type,
    title,
    dependsOn,
    timeoutMs,
    writeMode,
  };
  if (prompt !== undefined) step.prompt = prompt;
  if (model !== undefined) step.model = model;
  if (tool !== undefined) step.tool = tool;
  if (raw['args'] !== undefined) step.args = raw['args'];
  if (maxRetries !== undefined) step.maxRetries = maxRetries;
  // policy 参数预留给未来按策略做额外校验；当前不改变解析结果
  void policy;
  return step;
}

/** 校验依赖图：id 唯一、依赖存在、无自环、无环 */
function validateStepGraph(steps: readonly WorkflowStepDefinition[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) fail(`duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) fail(`step "${step.id}" depends on itself`);
      if (!ids.has(dep)) fail(`step "${step.id}" depends on unknown step "${dep}"`);
    }
  }
  // 拓扑排序检测环（Kahn；全用整数索引避免依赖字符串序）
  const indexOf = new Map(steps.map((step, i) => [step.id, i]));
  const indegree = steps.map(() => 0);
  const outgoing: number[][] = steps.map(() => []);
  steps.forEach((step, i) => {
    for (const dep of step.dependsOn) {
      const from = indexOf.get(dep);
      if (from === undefined) continue;
      outgoing[from]!.push(i);
      indegree[i] = (indegree[i] ?? 0) + 1;
    }
  });
  const queue: number[] = [];
  indegree.forEach((degree, i) => {
    if (degree === 0) queue.push(i);
  });
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const next of outgoing[current]!) {
      indegree[next] = (indegree[next] ?? 0) - 1;
      if (indegree[next] === 0) queue.push(next);
    }
  }
  if (visited !== steps.length) fail('steps contain a dependency cycle');
}

/** 工作流定义目录（`<root>/.harness2/workflows`） */
export function workflowDefinitionsDir(root: string): string {
  return join(root, HARNESS_DIR, WORKFLOW_DIR_NAME);
}

/**
 * 从项目目录与用户目录发现工作流定义（项目覆盖用户同名）。
 * 只读、确定性（按文件名排序）；单文件错误不影响其它文件（登记进 errors）。
 */
export function discoverWorkflowDefinitions(options: {
  /** 项目根（通常 cwd） */
  cwd: string;
  /** 用户主目录（测试可注入；缺省 os.homedir()） */
  home?: string;
}): { definitions: DiscoveredWorkflowDefinition[]; errors: WorkflowDefinitionError[] } {
  const home = options.home ?? homedir();
  const dirs: Array<{ dir: string; scope: WorkflowDefinitionScope }> = [
    { dir: workflowDefinitionsDir(options.cwd), scope: 'project' },
    { dir: workflowDefinitionsDir(home), scope: 'user' },
  ];
  const errors: WorkflowDefinitionError[] = [];
  const byName = new Map<string, DiscoveredWorkflowDefinition>();

  for (const { dir, scope } of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch (e) {
      errors.push({ path: dir, scope, message: (e as Error)?.message ?? String(e) });
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      let parsed: WorkflowDefinition;
      try {
        parsed = parseWorkflowDefinition(JSON.parse(readFileSync(path, 'utf8')));
      } catch (e) {
        errors.push({ path, scope, message: (e as Error)?.message ?? String(e) });
        continue;
      }
      // 项目先于用户：同名时先到者（项目）胜出；用户层重复项被忽略（不报错）
      if (!byName.has(parsed.name)) byName.set(parsed.name, { definition: parsed, path, scope });
    }
  }

  const definitions = [...byName.values()].sort((a, b) =>
    a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0,
  );
  return { definitions, errors };
}
