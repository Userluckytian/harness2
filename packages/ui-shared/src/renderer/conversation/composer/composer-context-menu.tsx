// composer-context-menu.tsx — P0「添加上下文」选择器（ZCode composer 底部行最左按钮 + 弹出面板）。
//
// ZCode 实测（1440×900）：composer 底部行最左的 `添加上下文` 钮（28×28）弹出面板，组标题
// 「添加上下文」，条目分三类：附件 / 目标 / 工作区文件清单（当前目录文件树，带搜索）。
//
// 本组件**壳无关**：不抓 IPC、不抓全局单例；目录数据源与插回动作全部经 props 注入
// （壳注入数据源，Composer 注入 onInsertPath——它持有草稿 store 与编辑器 ref）。渲染端零 Node。
//
// 三条通道的**如实判定**（红线⑩，依据写进交付报告）：
//   * 附件：composer 自身已有 `<input type="file">` 真入口（浏览器 File 通道）→ 本项**接真**
//     （点击 = 打开同一文件选择器）；壳若不传 attachmentsAvailable 则如实 disabled + 占位说明。
//   * 目标：全仓 grep 无 composer 目标/goal 通道（core 的 plan-state 是计划账本，非 composer 入口）
//     → 恒 disabled + `data-placeholder` + title「目标通道未接入」。
//   * 文件清单：数据源 = `listDir`（桌面 preload 白名单 IPC，根为主进程持有的 serve --root）；
//     壳不注入（web 无目录通道）→ 该区显示「web 无目录通道」，不摆假文件树。
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeftIcon, FileIcon, FolderIcon, LinkIcon, PlusIcon, PaperclipIcon, TargetIcon } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';

/** 目录条目类型（与桌面 `listDir` 协议同形） */
export type ContextEntryKind = 'dir' | 'file' | 'symlink' | 'other';
export interface ContextListEntry {
  readonly name: string;
  readonly kind: ContextEntryKind;
}
/** 列目录结果（与桌面 `Harness2Api.listDir` 结构一致；ui-shared 只认结构，不依赖壳类型） */
export type ContextListResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: readonly ContextListEntry[];
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly error: string };
/** 目录数据源（壳注入；桌面 = listDir IPC） */
export type ContextListDir = (relativePath: string) => Promise<ContextListResult>;

/**
 * 壳注入的数据面（进 ComposerProps / ConversationSeatProps）。
 * 缺省（web）= 无目录通道，面板如实降级；Composer 另注 onInsertPath / 附件回调。
 */
export interface ComposerContextPickerOptions {
  /** 文件清单数据源；undefined = 该壳无目录通道（web） */
  readonly listDir?: ContextListDir;
}

/** 选择器组件 props（Composer 装配：数据源经 contextPicker 透传，插入动作内部提供） */
export interface ComposerContextMenuProps {
  readonly disabled?: boolean;
  /** 目录数据源；undefined = 无目录通道，文件清单区如实降级 */
  readonly listDir?: ContextListDir;
  /** 选中条目 → 把相对路径插回 composer（Composer 接到草稿 store） */
  readonly onInsertPath: (relativePath: string) => void;
  /** 附件通道是否可用（缺省 false = disabled 占位） */
  readonly attachmentsAvailable?: boolean;
  readonly onPickAttachment?: () => void;
  /** 目标通道是否可用（当前恒 false = disabled 占位） */
  readonly goalsAvailable?: boolean;
  readonly onPickGoal?: () => void;
}

type ListingState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ok';
      readonly path: string;
      readonly entries: readonly ContextListEntry[];
      readonly truncated: boolean;
    }
  | { readonly status: 'error'; readonly error: string };

/** 上级路径（去掉结尾 `/` 与最后一段；根本身返回 ''） */
function parentPath(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf('/');
  return index < 0 ? '' : trimmed.slice(0, index + 1);
}

function EntryIcon({ kind }: { kind: ContextEntryKind }): ReactNode {
  if (kind === 'dir') return <FolderIcon className="size-4" />;
  if (kind === 'symlink') return <LinkIcon className="size-4" />;
  return <FileIcon className="size-4" />;
}

/**
 * 壳无关的「添加上下文」选择器：28×28 图标钮 + Radix DropdownMenu 面板。
 * 文件清单支持进入子目录与名称过滤；选中文件把 `相对路径` 经 onInsertPath 交回。
 */
export function ComposerContextMenu(props: ComposerContextMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<ListingState>({ status: 'idle' });
  const requestRef = useRef(0);

  const load = useCallback(
    (next: string): void => {
      const listDir = props.listDir;
      if (listDir === undefined) {
        setListing({ status: 'idle' });
        return;
      }
      const request = requestRef.current + 1;
      requestRef.current = request;
      setListing({ status: 'loading' });
      void listDir(next).then(
        (result) => {
          if (request !== requestRef.current) return;
          setListing(
            result.ok
              ? { status: 'ok', path: result.path, entries: result.entries, truncated: result.truncated }
              : { status: 'error', error: result.error },
          );
        },
        (error: unknown) => {
          if (request !== requestRef.current) return;
          setListing({ status: 'error', error: error instanceof Error ? error.message : String(error) });
        },
      );
    },
    [props.listDir],
  );

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) {
      setQuery('');
      setPath('');
      load('');
    }
  };

  const entries = listing.status === 'ok' ? listing.entries : [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? entries : entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, query]);

  const enterDir = (name: string): void => {
    const next = path === '' ? `${name}/` : `${path}${name}/`;
    setPath(next);
    setQuery('');
    load(next);
  };

  const attachmentsAvailable = props.attachmentsAvailable === true;
  const goalsAvailable = props.goalsAvailable === true;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="rounded-lg text-foreground-subtle hover:text-foreground"
          data-testid="composer-context-trigger"
          aria-label="添加上下文"
          title="添加上下文"
          disabled={props.disabled}
        >
          <PlusIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96" data-testid="composer-context-menu">
        <DropdownMenuLabel data-testid="composer-context-title">添加上下文</DropdownMenuLabel>

        {/* 附件：composer 已有真 File 入口 → 接真；壳无通道则 disabled 占位（红线⑩） */}
        <DropdownMenuItem
          data-testid="composer-context-attach"
          data-placeholder={attachmentsAvailable ? undefined : ''}
          disabled={!attachmentsAvailable}
          title={attachmentsAvailable ? undefined : '附件通道未接入'}
          onSelect={() => {
            if (attachmentsAvailable) props.onPickAttachment?.();
          }}
        >
          <PaperclipIcon className="size-4" />
          <span>附件</span>
        </DropdownMenuItem>

        {/* 目标：无 composer 目标通道 → disabled 占位（红线⑩） */}
        <DropdownMenuItem
          data-testid="composer-context-goal"
          data-placeholder={goalsAvailable ? undefined : ''}
          disabled={!goalsAvailable}
          title={goalsAvailable ? undefined : '目标通道未接入'}
          onSelect={() => {
            if (goalsAvailable) props.onPickGoal?.();
          }}
        >
          <TargetIcon className="size-4" />
          <span>目标</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>文件清单</DropdownMenuLabel>

        {props.listDir === undefined ? (
          <div
            className="px-2 py-1 text-ui-xs text-foreground-subtlest"
            data-testid="composer-context-files-unavailable"
          >
            web 无目录通道
          </div>
        ) : (
          <div className="flex flex-col gap-1" data-testid="composer-context-files">
            <div className="flex items-center gap-1 px-1">
              {path !== '' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="composer-context-up"
                  aria-label="返回上级目录"
                  title="返回上级目录"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const up = parentPath(path);
                    setPath(up);
                    setQuery('');
                    load(up);
                  }}
                >
                  <ChevronLeftIcon className="size-3.5" />
                </Button>
              )}
              {/* 拦截按键冒泡：避免 Radix 菜单 typeahead 吞掉搜索输入 */}
              <Input
                size="sm"
                autoFocus
                className="flex-1"
                data-testid="composer-context-search"
                aria-label="过滤文件"
                placeholder="过滤文件…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="truncate px-2 text-ui-xs text-foreground-subtlest" data-testid="composer-context-path">
              {path === '' ? '工作区根' : path}
            </div>
            {listing.status === 'loading' && (
              <div className="px-2 py-1 text-ui-sm text-foreground-subtlest" data-testid="composer-context-loading">
                读取中…
              </div>
            )}
            {listing.status === 'error' && (
              <div className="px-2 py-1 text-ui-sm text-destructive" data-testid="composer-context-error">
                无法读取目录：{listing.error}
              </div>
            )}
            {listing.status === 'ok' &&
              (filtered.length === 0 ? (
                <div className="px-2 py-1 text-ui-sm text-foreground-subtlest" data-testid="composer-context-empty">
                  {entries.length === 0 ? '目录为空' : '无匹配项'}
                </div>
              ) : (
                filtered.map((entry) => {
                  const entryPath = `${path}${entry.name}`;
                  if (entry.kind === 'dir') {
                    return (
                      <DropdownMenuItem
                        key={`dir-${entryPath}`}
                        data-testid="composer-context-entry"
                        data-kind="dir"
                        data-path={entryPath}
                        onSelect={(event) => {
                          // 目录 = 进入而非选中：阻止菜单关闭，保持面板打开以继续下钻
                          event.preventDefault();
                          enterDir(entry.name);
                        }}
                      >
                        <EntryIcon kind={entry.kind} />
                        <span className="truncate">{entry.name}</span>
                      </DropdownMenuItem>
                    );
                  }
                  return (
                    <DropdownMenuItem
                      key={`file-${entryPath}`}
                      data-testid="composer-context-entry"
                      data-kind={entry.kind}
                      data-path={entryPath}
                      title={entryPath}
                      onSelect={() => props.onInsertPath(entryPath)}
                    >
                      <EntryIcon kind={entry.kind} />
                      <span className="truncate">{entry.name}</span>
                    </DropdownMenuItem>
                  );
                })
              ))}
            {listing.status === 'ok' && listing.truncated && (
              <div className="px-2 py-1 text-ui-xs text-foreground-subtlest" data-testid="composer-context-truncated">
                （列表被截断）
              </div>
            )}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
