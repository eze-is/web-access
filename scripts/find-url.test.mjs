import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const sqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8', windowsHide: true });
const sqliteOptions = { skip: sqlite.error?.code === 'ENOENT' ? '需要 sqlite3（find-url 的历史检索依赖）' : false };
const quote = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;

// 只构造临时浏览器资料：子进程的 homedir 与平台分支由 preload 固定，不读取真实浏览器或 HOME。
async function fixture(t, rows = [], bookmarks = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Web Access find-url with spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'fixture-home');
  const browser = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  const profile = path.join(browser, 'Default');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(browser, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Fixture' } } } }));
  await fs.writeFile(path.join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: bookmarks } } }));
  const statements = ['CREATE TABLE urls (title TEXT, url TEXT, last_visit_time INTEGER, visit_count INTEGER);'];
  rows.forEach((row, index) => statements.push(`INSERT INTO urls VALUES (${quote(row.title)}, ${quote(row.url)}, ${13400000000000000n + BigInt(index) * 1000000n}, ${row.visits});`));
  execFileSync('sqlite3', [path.join(profile, 'History')], { input: statements.join('\n'), windowsHide: true });
  const script = path.join(root, 'find-url.mjs');
  await fs.copyFile(path.join(SCRIPTS, 'find-url.mjs'), script);
  const preload = path.join(root, 'preload.mjs');
  await fs.writeFile(preload, `import os from 'node:os';\nos.homedir = () => process.env.TEST_BROWSER_HOME;\nos.platform = () => 'darwin';\n`);
  return (...args) => {
    const child = spawnSync(process.execPath, ['--import', preload, script, ...args], {
      env: { ...process.env, TEST_BROWSER_HOME: home }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return child.stdout.trimEnd().split(/\r?\n/);
  };
}

function historyFields(lines) {
  return lines.slice(1).map(line => {
    const fields = line.trim().split(' | ');
    assert.match(fields[2], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    return [fields[0], fields[1], ...fields.slice(3)];
  });
}

test('历史标题含制表符或换行时，记录数、URL、访问次数与排序保持正确，输出仍为一条一行', sqliteOptions, async t => {
  const run = await fixture(t, [
    { title: 'Project\tDashboard', url: 'https://fixture.example/dashboard', visits: 7 },
    { title: 'Project\r\nRelease', url: 'https://fixture.example/release', visits: 3 },
    { title: 'Project\n筆記 | 更新', url: 'https://fixture.example/notes', visits: 2 },
  ]);
  const lines = run('Project', '--only', 'history', '--sort', 'visits');
  assert.equal(lines[0], '[历史] 3 条（按访问次数）');
  assert.deepEqual(historyFields(lines), [
    ['Project Dashboard', 'https://fixture.example/dashboard', 'visits=7'],
    ['Project Release', 'https://fixture.example/release', 'visits=3'],
    ['Project 筆記 │ 更新', 'https://fixture.example/notes', 'visits=2'],
  ]);
});

test('首条空标题、NULL 标题与非 ASCII 文字不会使历史字段错位', sqliteOptions, async t => {
  const run = await fixture(t, [
    { title: '中文 "引號" | 筆記', url: 'https://fixture.example/文件?q=%25&lang=zh-TW', visits: 2 },
    { title: null, url: 'https://fixture.example/null-title', visits: 3 },
    { title: '', url: 'https://fixture.example/empty-title', visits: 4 },
  ]);
  const lines = run('--only', 'history');
  assert.equal(lines[0], '[历史] 3 条（按最近访问）');
  assert.deepEqual(historyFields(lines), [
    ['(无标题)', 'https://fixture.example/empty-title', 'visits=4'],
    ['(无标题)', 'https://fixture.example/null-title', 'visits=3'],
    ['中文 "引號" │ 筆記', 'https://fixture.example/文件?q=%25&lang=zh-TW', 'visits=2'],
  ]);
});

test('URL 字段中的制表符和换行不会变成额外记录或访问次数字段', sqliteOptions, async t => {
  const run = await fixture(t, [
    { title: 'Fixture', url: 'https://fixture.example/?note=one\tvalue\nnext', visits: 8 },
  ]);
  const lines = run('--only', 'history');
  assert.equal(lines[0], '[历史] 1 条（按最近访问）');
  assert.deepEqual(historyFields(lines), [
    ['Fixture', 'https://fixture.example/?note=one value next', 'visits=8'],
  ]);
});

test('没有匹配的历史时仍输出零条', sqliteOptions, async t => {
  const run = await fixture(t, [{ title: 'Fixture', url: 'https://fixture.example/', visits: 1 }]);
  assert.deepEqual(run('missing', '--only', 'history'), ['[历史] 0 条（按最近访问）']);
});

test('书签中的制表符、换行与竖线保持一条一行的输出格式', sqliteOptions, async t => {
  const run = await fixture(t, [], [
    { type: 'url', name: 'Team\tLinks\r\n查詢 | 文件', url: 'https://fixture.example/bookmark' },
  ]);
  assert.deepEqual(run('Team', '--only', 'bookmarks'), [
    '[书签] 1 条', '  Team Links 查詢 │ 文件 | https://fixture.example/bookmark',
  ]);
});
