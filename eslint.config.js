// ESLint flat config（阶段 15 B2）。
//
// 分级原则（计划书 B2 红线 3「存量正常代码不得因新规则误标红」）：
//   error = 明显错误：未使用变量、any 泄漏、floating promise；
//   其余 eslint:recommended / typescript-eslint recommended 规则首轮一律降级为 warn，
//   先让 CI 跑通，后续再逐条收紧（收紧时改 ERROR_RULES 即可）。
//
// 类型感知（no-floating-promises 需要）：projectService 按文件就近找所属 tsconfig；
//   纯 JS 文件（scripts/*.mjs 等）不在任何 tsconfig project 内，用 disableTypeChecked 关掉类型规则。
'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const eslintConfigPrettier = require('eslint-config-prettier');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

/** 首轮保留为 error 的「明显错误」规则（其余推荐规则降 warn） */
const ERROR_RULES = new Set([
  'no-unused-vars',
  '@typescript-eslint/no-unused-vars',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-floating-promises',
]);

/** 把 configs 中的 error 规则降级为 warn，ERROR_RULES 里的规则保持原级别 */
function downgradeErrorsToWarn(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = {};
    for (const [name, value] of Object.entries(config.rules)) {
      rules[name] = ERROR_RULES.has(name) || value !== 'error' ? value : 'warn';
    }
    return { ...config, rules };
  });
}

module.exports = tseslint.config(
  {
    name: 'harness2/ignores',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-*/**',
      '**/dist-electron/**',
      '**/release/**',
      '**/coverage/**',
      // 本机临时目录（.gitignore 的 .tmp-*/；A0 起用于各类一次性脚本，不入库）
      '**/.tmp-*/**',
      // 基线快照与 fixture：格式化/自动修复会污染 api-surface.test.ts 的比对基准（B2 红线 1）
      'packages/core/test/fixtures/**',
      'packages/core/fixtures/**',
    ],
  },
  ...downgradeErrorsToWarn([js.configs.recommended, ...tseslint.configs.recommended]),
  {
    name: 'harness2/language-options',
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // 同一仓库混有 node（core/cli/gateway）与 browser（desktop renderer）代码，两者都声明，
      // no-undef 本身已降为 warn，不会误伤。
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: {
          // 不在任何 tsconfig include 内的独立脚本（B2 实测：projectService 找不到会报 parsing error）
          allowDefaultProject: ['packages/cli/scripts/tui-spike.tsx'],
        },
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // JS 版交给 TS 版接管（TS 版能正确处理类型标注与 interface）
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: true }],
    },
  },
  {
    // 测试夹具：HTTP 响应解析、假 api 对象在测试里用 any 是常见写法（B2 红线 3：存量正常代码不误标红）；
    // 生产代码（packages/*/src）仍保持 error，防止 any 泄漏到公共类型。
    name: 'harness2/tests-relaxed',
    files: ['**/test/**/*.ts', '**/test/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // React（desktop renderer / cli ink TUI）：注册 plugin 让存量 eslint-disable react-hooks/* 注释可解析；
    // 首轮两条规则均 warn（v7 recommended 新增的编译器类规则不启用，避免误标红存量组件）
    name: 'harness2/react-hooks',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    name: 'harness2/js-disable-type-checked',
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  eslintConfigPrettier,
);
