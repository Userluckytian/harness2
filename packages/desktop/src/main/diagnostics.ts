// 诊断（B2 第 12 类）：doctor 六项 + 崩溃报告列表，复用 @harness2/core 的 runDoctor / crash 目录。
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crashReportDir, runDoctor } from './core.js';
import type { SettingsCrashReportShape, SettingsDoctorReportShape } from '../shared/protocol.js';

export async function getDoctorReport(home: string, root: string): Promise<SettingsDoctorReportShape> {
  const report = await runDoctor({ root, home });
  return { checks: report.checks, exitCode: report.exitCode };
}

/** 崩溃报告列表（~/.harness2/crash/*.log 按 mtime 倒序；目录缺失/空 → []） */
export function getCrashReports(home: string): SettingsCrashReportShape[] {
  const dir = crashReportDir(home);
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.log'))
      .map((fileName) => {
        const st = statSync(join(dir, fileName));
        return { fileName, mtime: st.mtime.toISOString(), size: st.size };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  } catch {
    return [];
  }
}
