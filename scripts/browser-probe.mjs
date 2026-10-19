#!/usr/bin/env node
// 首次配置的浏览器探测 - 单一职责模块
// 被 check-deps.mjs 共享（未设置浏览器时列出应用数据根目录的最外层文件夹名），也是给 Agent 的探测命令：
//   node browser-probe.mjs <文件夹> [更多文件夹]
// 文件夹是应用数据根目录下的相对路径：通常是一个文件夹名（如 Dia、Google、BraveSoftware），
// 也可以多级（如 Windows 的 Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4）。
//
// 边界（由代码保证，不靠 Agent 自觉；不读取浏览器数据内容）：
//   - 列根目录只 readdir 根目录本身，不进入任何子文件夹
//   - 探测范围限定在应用数据根目录之内：拒绝 ~、..越界、根目录本身、根目录之外的绝对路径，以及经软链接指向根目录之外的文件夹
//     （根目录内的软链接允许，如 snap 的 ~/snap/<名>/current → 修订目录；经 current 探测得到的数据目录保留 current 写法，snap 升级后配置仍有效）
//   - 只在指定文件夹内向下最多 MAX_DEPTH 层，以 `Local State` 文件识别 Chromium 用户数据目录，识别后不再深入；无权限的目录跳过并注明
//   - 对识别出的数据目录只看 `Local State` 是否存在、读 DevToolsActivePort 的端口，并只做 TCP 探测（不建 WebSocket，不触发授权）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLoopbackHost, displayName, readActivePort, INSPECT_HINT } from './browser-discovery.mjs';

const MAX_DEPTH = 3;
const MAX_DIRS = 500; // 防止误指向巨大目录时无界遍历

// 各平台应用数据根目录（浏览器数据目录通常在其下 1～3 层）。
// Linux 另含 snap（~/snap/<应用>/…）与 flatpak（~/.var/app/<应用 id>/…）的沙盒数据目录。
export function appDataRoots() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin': return [path.join(home, 'Library', 'Application Support')];
    case 'linux': return [path.join(home, '.config'), path.join(home, 'snap'), path.join(home, '.var', 'app')];
    case 'win32': return [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
    default: return [];
  }
}

// 只列根目录本身的子文件夹名；返回 { root, folders } 或 { root, code }
export function listTopFolders(root) {
  try {
    const folders = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    return { root, folders };
  } catch (error) {
    return { root, code: error.code || 'EIO' };
  }
}

// 首次配置的列表：每个存在的根目录及其最外层文件夹名；不存在的根目录（如没有 snap 的 Linux）不列出
export function listAppDataRoots() {
  return appDataRoots().map(listTopFolders).filter(listing => listing.code !== 'ENOENT');
}

// target 是否严格位于 base 之内（不等于 base 本身）
function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realpathOrSelf(dir) {
  try { return fs.realpathSync.native(dir); }
  catch { return dir; }
}

// 文件夹参数 → 待探测的绝对路径（可能在多个根目录下各有一个）。越界参数抛出可直接展示的错误；
// 根目录下不存在时返回空数组。
export function resolveFolder(arg) {
  const value = String(arg ?? '').trim();
  const roots = appDataRoots();
  const hint = `只能写应用数据根目录（${roots.join('、') || '当前平台未知'}）下的文件夹，如 Dia、Google`;
  if (!value) throw new Error(`文件夹参数为空；${hint}`);
  if (value.startsWith('~')) throw new Error(`不接受 ~ 路径；${hint}`);
  let candidates;
  if (path.isAbsolute(value)) {
    const target = path.resolve(value);
    candidates = roots.filter(root => isInside(root, target)).map(root => ({ root, target }));
    if (!candidates.length) throw new Error(`${target} 不在应用数据根目录之内，已拒绝；${hint}`);
  } else {
    candidates = roots.map(root => ({ root, target: path.resolve(root, value) }));
    if (!candidates.every(({ root, target }) => isInside(root, target))) {
      throw new Error(`"${value}" 指向应用数据根目录本身或其外部，已拒绝；${hint}`);
    }
  }
  const folders = [];
  for (const { root, target } of candidates) {
    if (!fs.existsSync(target)) continue;
    // 软链接可能把根目录内的名字指到外部（如 ~/Documents），按真实路径再确认一次
    if (!isInside(realpathOrSelf(root), realpathOrSelf(target))) {
      throw new Error(`${target} 经软链接指向应用数据根目录之外，已拒绝`);
    }
    folders.push(target);
  }
  return folders;
}

// 只判断 `Local State` 是否存在；无权限（EACCES / EPERM）时抛出，由调用方把该目录记为跳过
function hasLocalState(dir) {
  return fs.statSync(path.join(dir, 'Local State'), { throwIfNoEntry: false })?.isFile() === true;
}

// 一个数据目录的远程调试状态：只读端口文件 + TCP 探测
async function describe(dataDir) {
  const active = readActivePort(dataDir);
  let remoteDebugging;
  if (active.port) {
    remoteDebugging = (await findLoopbackHost(active.port))
      ? { enabled: true, port: active.port }
      : { enabled: false, detail: `DevToolsActivePort 记录的端口 ${active.port} 未在监听（浏览器未运行或开关已关闭）` };
  } else {
    remoteDebugging = {
      enabled: false,
      detail: {
        'not-enabled': '没有 DevToolsActivePort（浏览器未运行或远程调试开关未开启）',
        unreadable: `无法读取 DevToolsActivePort（${active.code}）`,
        invalid: 'DevToolsActivePort 内容无效',
      }[active.reason] || active.reason,
    };
  }
  return { dataDir, name: displayName(dataDir), remoteDebugging };
}

// 在文件夹内按层查找 Chromium 用户数据目录。返回 { folder, browsers, skipped, truncated } 或 { folder, code }
export async function probeFolder(folder) {
  const browsers = [];
  const skipped = [];
  const queue = [{ dir: folder, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (++visited > MAX_DIRS) return { folder, browsers, skipped, truncated: true };
    let isBrowser = false;
    let entries = null;
    try {
      isBrowser = hasLocalState(dir);
      if (!isBrowser && depth < MAX_DEPTH) entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // 无权限的目录（macOS TCC、root 所有、Windows ACL）只跳过它自己，同一文件夹里其他浏览器照常报告
      if (depth === 0) return { folder, code: error.code || 'EIO' };
      skipped.push({ dir, code: error.code || 'EIO' });
      continue;
    }
    if (isBrowser) {
      browsers.push(await describe(dir));
      continue;
    }
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return { folder, browsers, skipped, truncated: false };
}

function printProbe(result) {
  console.log(`probe: ${result.folder}`);
  if (result.code) {
    console.log(`  无法读取该文件夹（${result.code}），已跳过`);
    return;
  }
  if (!result.browsers.length) {
    console.log(`  未找到 Chromium 浏览器数据目录（向下 ${MAX_DEPTH} 层内没有 Local State）`);
  }
  for (const browser of result.browsers) {
    const state = browser.remoteDebugging;
    console.log(`  - ${browser.name}：${browser.dataDir}`);
    console.log(state.enabled
      ? `    远程调试：已开启（端口 ${state.port} 在监听）`
      : `    远程调试：未开启 — ${state.detail}；需用户在该浏览器${INSPECT_HINT}`);
    console.log(`    配置写法：WEB_ACCESS_BROWSER=${browser.dataDir}`);
  }
  for (const item of result.skipped) console.log(`  无法读取，已跳过（${item.code}）：${item.dir}`);
  if (result.truncated) console.log(`  文件夹过大，已在 ${MAX_DIRS} 个目录后停止；请指定更具体的子文件夹`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('用法：node browser-probe.mjs <文件夹> [更多文件夹]');
    console.log(`  文件夹为应用数据根目录（${appDataRoots().join('、') || '当前平台未知'}）下的相对路径，通常就是文件夹名`);
    process.exitCode = args.length ? 0 : 2;
    return;
  }
  let found = 0;
  for (const arg of args) {
    let folders;
    try { folders = resolveFolder(arg); }
    catch (error) {
      console.log(`probe: ${arg}\n  参数无效 — ${error.message}`);
      continue;
    }
    if (!folders.length) {
      console.log(`probe: ${arg}\n  应用数据根目录下没有这个文件夹（${appDataRoots().join('、') || '当前平台未知'}）`);
      continue;
    }
    for (const folder of folders) {
      const result = await probeFolder(folder);
      printProbe(result);
      found += result.browsers?.length || 0;
    }
  }
  process.exitCode = found ? 0 : 1;
}

// 作为命令运行时才执行；被 check-deps 导入时只提供函数。比较真实路径：Skill 常经软链接引用，入口路径与模块路径可能不同。
function isEntry() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (process.argv[1] && isEntry()) await main();
