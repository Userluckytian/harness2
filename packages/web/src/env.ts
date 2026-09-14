// web 壳环境读取（唯一的 `import.meta.env` 读取点，便于其余模块保持可注入/可测）。
//
// 三件事：
//   1. serve 源：缺省**同源**（dev 由 vite 代理 /api 与 /ws 到本地 serve，见 vite.config.mts）；
//      部署侧若已把 web 与 serve 放在同一源下，也应保持同源。
//   2. token：serve 严格模式必需（一次性 token）。优先环境变量，其次页面 URL 的 `?token=`——
//      后者方便本地手测（serve 端不记录/不回显 token）。
//   3. 新建会话所需的 cwd：serve 的 POST /api/sessions 强制要求它，而 web 没有目录选择通道，
//      故运行时取「最近一个会话的 cwd」（见 app 组装根）。取不到就如实禁用新建按钮。
export interface WebEnv {
  readonly origin: string;
  readonly token: string;
  readonly defaultServeOrigin: string;
}

export function readWebEnv(search: string = globalThis.location?.search ?? ''): WebEnv {
  const env = import.meta.env;
  const fromQuery = new URLSearchParams(search).get('token') ?? '';
  return {
    origin: env.VITE_HARNESS2_ORIGIN ?? '',
    token: env.VITE_HARNESS2_TOKEN ?? fromQuery,
    defaultServeOrigin: env.VITE_HARNESS2_PROXY ?? 'http://127.0.0.1:46213',
  };
}
