// Composer：常驻底部多行输入框（受控 value + cursor，不依赖第三方 textarea）。
// 按键：可打印字符插入光标位；Backspace/Delete 删除；左右键移光标；Enter 发送（清空，
// 触发 onSend）；Shift+Enter 或行尾 \ 续行不发送；上下键在本会话已发送历史回溯/前进
// （仅本会话，不跨会话持久化）；Ctrl+C 两次退出；空 buffer 时 Ctrl+D 退出。
// 退出逻辑经 onExit 回调上交（复用 existing 退出语义）。
import React from 'react';
import { useInput, Box, Text } from 'ink';
import { matchCommands } from '../command-registry.js';

export interface ComposerProps {
  /** 双行视觉提示当前输入多行状态 */
  busy?: boolean;
  /** 输入焦点（浮层打开时 false，卸载非激活键盘监听实现互斥） */
  active?: boolean;
  /** Enter 发送（携带清空后的内容；由调用方决定语义） */
  onSend: (text: string) => void;
  /** Ctrl+C 两次 / 空 buffer 时 Ctrl+D 的上交退出钩子 */
  onExit: () => void;
}

export function Composer({ busy = false, active = true, onSend, onExit }: ComposerProps): React.ReactElement {
  const [value, setValue] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const [candidateIndex, setCandidateIndex] = React.useState(0);
  const historyRef = React.useRef<string[]>([]);
  const historyIdxRef = React.useRef(-1);
  const lastCtrlCAtRef = React.useRef(0);

  // 命令名阶段：value 以 / 开头且不含空格/换行（输入单个命令名，未进入参数）
  const commandNameActive = value.startsWith('/') && !value.includes(' ') && !value.includes('\n');
  const candidates = commandNameActive ? matchCommands(value) : [];
  // 防越界：候选变化后 clamp 高亮索引
  const safeCandidateIndex = candidates.length === 0 ? 0 : Math.min(candidateIndex, candidates.length - 1);

  const insertAt = (text: string, pos: number, insert: string): string => text.slice(0, pos) + insert + text.slice(pos);
  const removeAt = (text: string, pos: number, count: number): string => text.slice(0, pos) + text.slice(pos + count);

  useInput(
    (input, key) => {
      if (busy) return; // turn 期间不响应输入（发送后清空，缓冲由上层策略处理）

      // —— 命令名阶段：↑↓ 切候选、Tab 补全候选（不发送）；其余按键照常（含字符输入） ——
      if (candidates.length > 0) {
        if (key.upArrow) {
          setCandidateIndex((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (key.downArrow) {
          setCandidateIndex((i) => (i + 1) % candidates.length);
          return;
        }
        if (key.tab) {
          const chosen = candidates[safeCandidateIndex];
          if (chosen !== undefined) {
            setValue(chosen);
            setCursor(chosen.length);
            setCandidateIndex(0);
          }
          return;
        }
        // 其余按键落到普通输入流（Enter 触发 onSend 等）
      }

    if (key.ctrl && input === 'c') {
      const now = Date.now();
      if (now - lastCtrlCAtRef.current < 2000) {
        onExit();
        return;
      }
      lastCtrlCAtRef.current = now;
      setValue((v) => v + '（再按一次 Ctrl+C 退出）');
      setCursor((c) => c + 1);
      return;
    }
    if (key.ctrl && input === 'd') {
      if (value.trim().length === 0) onExit();
      return;
    }
    if (key.shift && key.return) {
      // Shift+Enter 续行（不发送）
      setValue((v) => {
        const next = insertAt(v, cursor, '\n');
        setCursor((c) => c + 1);
        return next;
      });
      return;
    }
    if (key.return) {
      const text = value;
      if (text.trim().length === 0) return;
      if (text.trimEnd().endsWith('\\')) {
        // 行尾 \ 续行（不发送，去掉该反斜杠后换行）
        setValue((v) => {
          const trimmed = v.trimEnd().slice(0, -1);
          const next = trimmed + '\n';
          setCursor(next.length);
          return next;
        });
        return;
      }
      setValue('');
      setCursor(0);
      historyRef.current.push(text);
      historyIdxRef.current = -1;
      onSend(text);
      return;
    }
    if (key.upArrow) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      const idx = historyIdxRef.current < 0 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
      historyIdxRef.current = idx;
      setValue(hist[idx] ?? '');
      setCursor((hist[idx] ?? '').length);
      return;
    }
    if (key.downArrow) {
      const hist = historyRef.current;
      if (hist.length === 0 || historyIdxRef.current < 0) return;
      const idx = historyIdxRef.current + 1;
      if (idx >= hist.length) {
        setValue('');
        setCursor(0);
        historyIdxRef.current = -1;
        return;
      }
      historyIdxRef.current = idx;
      setValue(hist[idx] ?? '');
      setCursor((hist[idx] ?? '').length);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    if (key.backspace) {
      if (cursor === 0) return;
      setValue((v) => removeAt(v, cursor - 1, 1));
      setCursor((c) => c - 1);
      return;
    }
    if (key.delete) {
      if (cursor >= value.length) return;
      setValue((v) => removeAt(v, cursor, 1));
      return;
    }
    if (key.escape) {
      setValue('');
      setCursor(0);
      return;
    }
    if (input !== undefined && input !== '' && !key.ctrl && !key.meta) {
      setValue((v) => {
        const next = insertAt(v, cursor, input);
        setCursor((c) => c + input.length);
        return next;
      });
    }
  },
  { isActive: active && !busy },
);

  const visualValue = value.replace(/\n/g, '¶\n');

  return (
    <Box flexDirection="column" borderStyle="round" flexShrink={0}>
      {busy && <Text color="gray">忙碌中…（等待当前 turn 完成）</Text>}
      <Box flexDirection="row">
        <Text color="green">&gt; </Text>
        <Text>{visualValue}</Text>
      </Box>
      {candidates.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {candidates.map((c, i) => (
            <Box key={c} minWidth={1}>
              <Text color={i === safeCandidateIndex ? 'cyan' : undefined}>
                {i === safeCandidateIndex ? '› ' : '  '}
                {c}
              </Text>
            </Box>
          ))}
          <Text color="gray">↑↓ 切换 · Tab 补全 · Enter 发送当前内容</Text>
        </Box>
      )}
    </Box>
  );
}