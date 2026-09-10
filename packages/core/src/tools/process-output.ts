// 子进程输出解码（A1-2）：Windows 控制台默认 GBK（代码页 936），直接按 UTF-8 解码会
// 产生替换字符（乱码）并进入模型上下文。策略：
//   1. 先按严格 UTF-8 解码——成功即用（Git Bash / POSIX / 现代工具输出都是 UTF-8）；
//   2. 严格 UTF-8 失败且平台为 Windows → 按 GBK 解码（cmd.exe 内置命令、旧工具输出）；
//   3. 仍失败 → 退回宽松 UTF-8（替换字符兜底，绝不抛错）。
// 已知限制（如实声明）：极少数 GBK 字节序列恰好也是合法 UTF-8，会被优先当 UTF-8 解释；
// 这是无法从字节流本身消歧的固有限制，优先保证常见路径（UTF-8 工具链）正确。
//
// 分块安全：调用方必须累积完整 Buffer 再解码（多字节字符可能跨 chunk）。
// OutputCollector 负责按字节上限累积，避免超大输出吃满内存。

export interface DecodeOptions {
  platform?: NodeJS.Platform;
}

/** 解码一段完整子进程输出（stdout/stderr 各自累积后调用） */
export function decodeProcessOutput(buffer: Buffer, options: DecodeOptions = {}): string {
  if (buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // 非法 UTF-8：Windows 下按 GBK（中文控制台）解释
  }
  if ((options.platform ?? process.platform) === 'win32') {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      // 运行时不带 full ICU（无 gbk 解码器）→ 退回宽松 UTF-8
    }
  }
  return buffer.toString('utf8');
}

/** 按字节上限累积子进程输出，收尾时一次性解码（保证多字节字符不被 chunk 边界切断） */
export class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.maxBytes) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  get capturedBytes(): number {
    return this.bytes;
  }

  decode(options: DecodeOptions = {}): string {
    return decodeProcessOutput(Buffer.concat(this.chunks, this.bytes), options);
  }
}
