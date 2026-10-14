#!/usr/bin/env node
/*
 * manual-pack.mjs —— cmd.exe 缺失环境下的 electron-builder 逃生门。
 *
 * 背景：本机 C:\Windows\System32\cmd.exe 被移除，electron-builder 的依赖收集器
 * 需经 .cmd shim 起 npm → 直接失败并把 release/win-unpacked 清成半成品。
 * 本脚本手工完成「组 asar → 填 win-unpacked 壳 → resedit 改 exe 元数据」，
 * 产物目录可直接交给 `electron-builder --prepackaged <dir> --win nsis portable`
 * （prepackaged 短路依赖收集器；NSIS/portable 只 execFile 直调 makensis/7za，不吃 cmd）。
 *
 * 用法：node packages/desktop/scripts/manual-pack.mjs
 * 前提：packages/desktop/{dist-electron,dist/renderer}、packages/core/dist、
 *       packages/ui-shared/dist、packages/cli/dist-bundle 均为当前构建。
 *
 * 说明（与本仓库现状绑定，改动需谨慎）：
 *  - node_modules 布局取自一份历史 asar 解包（pnpm 正常收集结果，生产依赖零变化时有效）；
 *    workspace 三包（core / ui-shared）的 dist 用当前构建覆盖。
 *  - 用 @electron/asar createPackageFromStreams：手工遍历 stage/app，对所有
 *    *.node 置 unpacked=true 并把 unpacked 标记向父目录传播（对齐 electron-builder
 *    out/asar/asarUtil.js 的语义），避免 3.4.1 createPackageWithOptions 在 Windows
 *    绝对路径 + matchBase 下 unpack glob 命不中的坑。
 *  - 元数据/改名：builder 26 已弃 rcedit（纯 JS resedit），prepackaged 又会跳过
 *    ElectronFramework.prepareApplicationStageDirectory 的改名 + signAndEditResources，
 *    故这里自己拷 electron.exe → harness2.exe 并用 resedit 写回
 *    ProductName/FileDescription/LegalCopyright + 图标（等价 signAndEditExecutable）。
 *  - asar integrity 资源（addWinAsarIntegrity）同样被 prepackaged 跳过 —— 与
 *    `electron .` 直跑语义一致，Electron 无 fuse 时不校验，可正常启动。
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');

// —— 可复用资产路径（见任务上下文；换环境改这里）——
const NM_LAYOUT_SRC = path.join(repoRoot, '.tmp-cmp', 'new-x', 'node_modules'); // 历史 asar 解包的 node_modules 布局
const ASAR_LIB = path.join(repoRoot, 'node_modules', '.pnpm', '@electron+asar@3.4.1', 'node_modules', '@electron/asar');
const RESEDIT_LIB = require_.resolve('resedit', {
  paths: [path.join(repoRoot, 'node_modules', '.pnpm', 'app-builder-lib@26.15.3_dmg_c5739d9600ac3f98a55503c35c5a46a9', 'node_modules', 'app-builder-lib')],
});
const CLI_BUNDLE = path.join(repoRoot, 'packages', 'cli', 'dist-bundle', 'harness2-cli.cjs');
const ICON_ICO = path.join(desktopDir, 'assets', 'icon.ico');
const SHELL_SRC = path.join(desktopDir, 'release', 'win-unpacked');

// —— 工作目录 ——
const STAGE = path.join(repoRoot, '.tmp-cmp', 'u1-stage');
const APP = path.join(STAGE, 'stage', 'app');
const OUT = path.join(STAGE, 'stage', 'out');

const asar = require_(path.join(ASAR_LIB, 'lib', 'asar.js'));
const { NtExecutable, NtExecutableResource, Data, Resource } = require_(RESEDIT_LIB);

const log = (...a) => console.log('[manual-pack]', ...a);

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

/** robocopy 镜像一棵树（cmd.exe 不在场时最快最稳的 win32 递归拷贝；rc<=7 均为成功） */
import { execFile } from 'node:child_process';
function robocopy(src, dest) {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.SystemRoot + '\\System32\\robocopy.exe',
      [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code !== undefined && typeof err.code === 'number' && err.code <= 7) return resolve();
        if (err) return reject(new Error(`robocopy ${src} -> ${dest} failed rc=${err.code}: ${stderr}`));
        resolve();
      },
    );
  }).catch(async () => {
    // robocopy 不可用时的纯 node 兜底
    await cpRecursive(src, dest);
  });
}

async function cpRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await cpRecursive(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

async function walk(dir, rel, out) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`unexpected symlink in stage (robocopy must materialize): ${abs}`);
    if (e.isDirectory()) {
      out.push({ rel: r, abs, dir: true });
      await walk(abs, r, out);
    } else if (e.isFile()) {
      out.push({ rel: r, abs, dir: false });
    }
  }
}

async function buildAsar() {
  const entries = [];
  await walk(APP, '', entries);
  const isNode = (rel) => rel.toLowerCase().endsWith('.node');
  const streams = [];
  // 对齐 electron-builder out/asar/asarUtil.js：模式命中的文件自身节点 unpacked:true，
  // 目录节点一律 false（builder 只对被识别为 unpacked *目录* 的路径传播父级标记，
  // 模式命中不传播）。注意：若把祖先目录标 unpacked，@electron/asar insertFile 的
  // `dirNode.unpacked` 分支会连带把同目录其它文件在头里标成 unpacked → 运行期读不到。
  for (const e of entries) {
    if (e.dir) {
      streams.push({ path: e.rel, unpacked: false, type: 'directory' });
      continue;
    }
    const st = await fs.stat(e.abs);
    streams.push({
      path: e.rel,
      unpacked: isNode(e.rel),
      type: 'file',
      stat: st,
      streamGenerator: () => fsSync.createReadStream(e.abs),
    });
  }
  const nodeFileCount = entries.filter((e) => !e.dir && isNode(e.rel)).length;
  const dest = path.join(OUT, 'resources', 'app.asar');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });
  await fs.rm(`${dest}.unpacked`, { recursive: true, force: true });
  log(`asar: ${streams.length} entries, ${nodeFileCount} .node files unpacked → ${dest}`);
  await asar.createPackageFromStreams(dest, streams);
}

async function editExe(exePath) {
  const pkg = require_(path.join(APP, 'package.json'));
  const buffer = await fs.readFile(exePath);
  const executable = NtExecutable.from(buffer);
  const res = NtExecutableResource.from(executable);
  const viList = Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList.length > 0 ? viList[0] : Resource.VersionInfo.createEmpty();
  const langs = vi.getAllLanguagesForStringValues();
  const lang = langs.length > 0 ? langs[0] : { lang: 0x0409, codepage: 1200 };
  vi.setStringValues(lang, {
    CompanyName: 'harness2',
    FileDescription: 'harness2',
    ProductName: 'harness2',
    LegalCopyright: 'harness2',
    OriginalFilename: 'harness2.exe',
  });
  vi.setFileVersion(pkg.version);
  vi.setProductVersion(pkg.version);
  // 字符串版本还原为原样（对齐 builder util/resEdit.js：setFileVersion 会归一化 4 段数字）
  vi.setStringValues(lang, { FileVersion: pkg.version, ProductVersion: pkg.version });
  vi.outputToResourceEntries(res.entries);
  const iconBuf = await fs.readFile(ICON_ICO);
  const iconFile = Data.IconFile.from(iconBuf);
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang.lang, iconFile.icons.map((i) => i.data));
  res.outputResource(executable);
  await fs.writeFile(exePath, Buffer.from(executable.generate()));
  log(`resedit ok: ${path.basename(exePath)} version=${pkg.version} icon=embedded`);
}

async function main() {
  // 0. 前置检查
  for (const [label, p] of [
    ['desktop dist-electron', path.join(desktopDir, 'dist-electron', 'main', 'main.js')],
    ['desktop renderer', path.join(desktopDir, 'dist', 'renderer', 'index.html')],
    ['core dist', path.join(repoRoot, 'packages', 'core', 'dist', 'index.js')],
    ['ui-shared dist cjs', path.join(repoRoot, 'packages', 'ui-shared', 'dist', 'cjs', 'renderer', 'store.js')],
    ['cli bundle', CLI_BUNDLE],
    ['icon', ICON_ICO],
    ['electron shell exe', path.join(SHELL_SRC, 'electron.exe')],
    ['nm layout src', path.join(NM_LAYOUT_SRC, 'zod', 'package.json')],
  ]) {
    if (!fsSync.existsSync(p)) throw new Error(`missing ${label}: ${p}`);
  }
  await rmrf(path.join(STAGE, 'stage'));
  await fs.mkdir(APP, { recursive: true });
  await fs.mkdir(path.join(OUT, 'resources'), { recursive: true });

  // 1. node_modules 布局（历史 asar 解包）
  log('copy node_modules layout ...');
  await robocopy(NM_LAYOUT_SRC, path.join(APP, 'node_modules'));

  // 2. workspace 包：package.json + 当前 dist 覆盖（结构对齐历史布局）
  log('overlay @harness2/* workspace dists ...');
  for (const [pkg, srcDir] of [
    ['core', path.join(repoRoot, 'packages', 'core')],
    ['ui-shared', path.join(repoRoot, 'packages', 'ui-shared')],
  ]) {
    const dest = path.join(APP, 'node_modules', '@harness2', pkg);
    await rmrf(dest);
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(path.join(srcDir, 'package.json'), path.join(dest, 'package.json'));
    await robocopy(path.join(srcDir, 'dist'), path.join(dest, 'dist'));
  }
  // @harness2/desktop = root package 本身，历史 asar 内不存在该目录，保持不存在。

  // 3. app 根三件套
  log('stage app root files ...');
  await robocopy(path.join(desktopDir, 'dist-electron'), path.join(APP, 'dist-electron'));
  await robocopy(path.join(desktopDir, 'dist', 'renderer'), path.join(APP, 'dist', 'renderer'));
  await fs.copyFile(path.join(desktopDir, 'package.json'), path.join(APP, 'package.json'));

  // 4. asar
  await buildAsar();

  // 5. electron 壳（排除 resources 里的旧内容）→ 改名 harness2.exe + resedit
  log('copy electron shell ...');
  for (const e of await fs.readdir(SHELL_SRC, { withFileTypes: true })) {
    if (e.name === 'resources') continue; // 壳内 resources 已被上次失败构建清空，产物以我们 stage/out/resources 为准
    const s = path.join(SHELL_SRC, e.name);
    const d = path.join(OUT, e.name === 'electron.exe' ? 'harness2.exe' : e.name);
    if (e.isDirectory()) await robocopy(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
  await editExe(path.join(OUT, 'harness2.exe'));

  // 6. extraResources（对齐 electron-builder.yml：cli bundle + tray_icon + elevate）
  log('extraResources ...');
  await fs.mkdir(path.join(OUT, 'resources', 'cli'), { recursive: true });
  await fs.copyFile(CLI_BUNDLE, path.join(OUT, 'resources', 'cli', 'harness2-cli.cjs'));
  await fs.copyFile(ICON_ICO, path.join(OUT, 'resources', 'tray_icon.ico'));
  // elevate.exe 进包（builder 的 CopyElevateHelper 也会往 resources/elevate.exe 放一份；这里预置，双保险）
  const elevates = [
    'D:/hermes/.build-caches/electron-builder/nsis-3.0.4.1/nsis-3.0.4.1-w8az6/elevate.exe',
    'D:/hermes/.build-caches/electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-w8az6/elevate.exe',
  ].find((p) => fsSync.existsSync(p));
  if (elevates) await fs.copyFile(elevates, path.join(OUT, 'resources', 'elevate.exe'));
  else log('WARN elevate.exe not found in caches — nsis will try its own resolution');

  log('DONE. prepackaged dir =', OUT);
  log('next: cd packages/desktop && ./node_modules/.bin/electron-builder --win nsis portable --prepackaged <OUT>');
}

await main();
