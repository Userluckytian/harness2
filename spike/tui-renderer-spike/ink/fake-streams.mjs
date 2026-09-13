// fake-streams.mjs — bench 用假 stdout/stdin：stdout 丢弃字节但记录写入次数/时间戳，
// stdin 是带 setRawMode 的 Readable（ink App 需要 isTTY/setEncoding/ref/unref/setRawMode）。
// 仅服务 spike，不代表真实终端性能；真实终端 I/O 由 demo.mjs 人工复跑。
import { Writable, Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';

export class NullStdout extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  writes = 0;
  bytes = 0;
  firstWriteAt = 0;
  lastWriteAt = 0;
  _write(chunk, _enc, cb) {
    const now = performance.now();
    if (this.firstWriteAt === 0) this.firstWriteAt = now;
    this.lastWriteAt = now;
    this.writes += 1;
    this.bytes += chunk.length;
    cb();
  }
}

export class FakeStdin extends Readable {
  isTTY = true;
  setRawMode() {}
  setEncoding(enc) {
    super.setEncoding(enc);
  }
  ref() {}
  unref() {}
  _read() {}
  // 直接注入一段字节（触发 'readable'，ink 在同一事件周期 read）
  emitInput(text) {
    this.push(text);
  }
}
