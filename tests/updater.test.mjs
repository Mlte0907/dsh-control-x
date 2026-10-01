/**
 * 自更新（lib/core/updater.js）验收。
 *
 * 重点不是"能下载能解包"，而是几件容易悄悄做错的事：
 *   1. 换装必须整目录 rename 再拷，绝不原地写（原地写会改坏 pnpm store 里的共享 blob）；
 *   2. 锁文件改写必须只落在本插件那个块里——按空行分段会漏掉 resolution 行，
 *      不分段则会把隔壁包的 version 一起改掉；
 *   3. 拿不到远端版本时要报失败，不能给一个"已是最新"的假结论；
 *   4. tarball 是外部下载物，解包必须挡住 `../` 越界路径。
 *
 * 换装链路用**真 tar 字节**（测试里手写 tar 头 + zlib.gzipSync）走完整的
 * 纯 Node 解包器，不 mock 任何一步——mock 掉解包就等于没测解包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareVersions, findProfileDir, checkUpdate, applyUpdate, extractTarGz,
  syncProfileSources, createUpdateController, installedVersion, REPO,
} from '../lib/core/updater.js';
import { WatchServer } from '../lib/browser/watch.js';

const OLD_SHA = 'a3d64ffb0980660972eb608d3ecba9364ac366a5';
const NEW_SHA = `b32335d${'1'.repeat(40 - 7)}`;   // 40 位十六进制，锁文件的硬要求
assert.equal(NEW_SHA.length, 40, '锁文件只认 40 位 sha，测试常量必须合规');
const OLD_INTEGRITY = 'sha512-sQp8ETh02mrvlsUmbom2WWSMvOThWdninqLKeHh3sKv3xyZB9X1iDreQK23c6DpF2z3xJKzGOj+GdMx1mFR/og==';

/** 手写一个 ustar 头。解包器不校验 checksum，但写对了这份样本才有说服力。 */
function tarHeader({ name, size, type = '0' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write('ustar', 257, 'latin1');
  h[262] = 0;                      // ustar magic 的 NUL 结尾
  h.write('00', 263, 'latin1');   // version
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** entries: [{name, data?, type?}] → 真正的 tar.gz 字节。 */
function makeTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    parts.push(tarHeader({ name: e.name, size: data.length, type: e.type ?? '0' }));
    if (data.length > 0) parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));   // tar 以两个空块收尾
  return gzipSync(Buffer.concat(parts));
}

/** 一个"新版本"的 tarball：顶层一个目录，里面 package.json + lib/index.js + 一块填充。 */
function newPackageTarball(version = '0.5.7', root = 'dsh-control-x-abc1234') {
  // 真实包几十上百 KB，填充块让样本也过得了"tarball 太小"的合理性检查。
  // 用 xorshift 而不是 (i*37)&0xff——后者周期只有 256，gzip 一压就剩几百字节。
  let seed = 0x1234567;
  const noise = Buffer.alloc(65536);
  for (let i = 0; i < noise.length; i += 1) {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    noise[i] = seed & 0xff;
  }
  return makeTarGz([
    { name: `${root}/`, type: '5' },
    { name: `${root}/package.json`, data: JSON.stringify({ name: 'dsh-control-x', version }) },
    { name: `${root}/lib/index.js`, data: '// new\n' },
    { name: `${root}/lib/filler.bin`, data: noise },
  ]);
}

/** 照抄真实 profile 的锁文件形状：importers 段 + packages 段 + snapshots 段，隔壁还挂着别的包。 */
function makeLock({ sha = OLD_SHA, integrity = OLD_INTEGRITY, version = '0.5.5' } = {}) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      dsh-control-x:',
    `        specifier: github:${REPO}#${sha}`,
    `        version: https://codeload.github.com/${REPO}/tar.gz/${sha}`,
    '      dsh-cost-meter:',
    '        specifier: 1.8.5',
    '        version: 1.8.5',
    '',
    'packages:',
    '',
    `  dsh-control-x@https://codeload.github.com/${REPO}/tar.gz/${sha}:`,
    `    resolution: {gitHosted: true, integrity: ${integrity}, tarball: https://codeload.github.com/${REPO}/tar.gz/${sha}}`,
    `    version: ${version}`,
    "    engines: {node: '>=22'}",
    '',
    '  dsh-cost-meter@1.8.5:',
    '    resolution: {integrity: sha512-Lsv0Ks4aeFsBn1qn2zdp+HdI8KGwa4b+HhzI0SKSEWH78vJ3ihWl7D2l2Cc+Pv+iMWECAL28DN3skbnqIZBow==}',
    '    version: 1.8.5',
    '',
    'snapshots:',
    '',
    `  dsh-control-x@https://codeload.github.com/${REPO}/tar.gz/${sha}:`,
    '    dependencies:',
    "      '@deepseek-ai/schemastery': 3.18.4",
    '',
    '  dsh-cost-meter@1.8.5:',
    '    dependencies:',
    '      zod: 4.6.5',
    '',
  ].join('\n');
}

/** 造一个假的 profile：<root>/node_modules/dsh-control-x + package.json + pnpm-lock.yaml。 */
function makeProfile({ version = '0.5.5' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cx-upd-'));
  const pkgRoot = join(root, 'node_modules', 'dsh-control-x');
  mkdirSync(join(pkgRoot, 'lib'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-control-x', version }, null, 2));
  writeFileSync(join(pkgRoot, 'lib', 'index.js'), '// old\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop', private: true,
    dependencies: { 'dsh-control-x': `github:${REPO}#${OLD_SHA}`, 'dsh-cost-meter': '1.8.5' },
  }, null, 2));
  writeFileSync(join(root, 'pnpm-lock.yaml'), makeLock());
  return { root, pkgRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 只回 tarball 的 fetch；GitHub API 那条单独答。 */
function tarballFetch(tarball, { sha = NEW_SHA } = {}) {
  return async (url) => {
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ sha }) };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array(tarball).buffer,
    };
  };
}

test('版本比较：点分数字、位数不齐、预发布', () => {
  assert.equal(compareVersions('0.5.7', '0.5.6'), 1);
  assert.equal(compareVersions('0.5.6', '0.5.6'), 0);
  assert.equal(compareVersions('0.5.5', '0.5.6'), -1);
  assert.equal(compareVersions('0.6', '0.5.9'), 1, '位数不齐时按缺的位当 0 比');
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1, '大版本优先，不能只比小节');
  assert.equal(compareVersions('0.5.6', '0.5.6-beta.1'), 1, '正式版比预发布版新');
  assert.equal(compareVersions('0.5.6-beta.1', '0.5.6'), -1);
  assert.equal(compareVersions('v0.5.7', '0.5.6'), 1, '容忍 v 前缀');
  assert.equal(compareVersions('0.5.6', undefined), 1, '远端没版本号时不能崩');
});

test('网络抖动：直连卡住时先重试，重试也不行才用镜像', async () => {
  // 直连第 1 次"卡住"（ECONNRESET 这类没有答复的失败），第 2 次成功
  let direct = 0;
  let mirror = 0;
  const flaky = async (url) => {
    if (url.startsWith('https://gh-proxy.org/')) { mirror += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ version: '0.5.7' }) }; }
    direct += 1;
    if (direct < 2) throw new Error('ECONNRESET');
    return { ok: true, status: 200, text: async () => JSON.stringify({ version: '0.5.7' }) };
  };
  const ok = await checkUpdate({ current: '0.5.5', fetchImpl: flaky });
  assert.equal(ok.ok, true, '一次瞬时抖动不该让检查失败');
  assert.equal(direct, 2, '直连应重试一次再放弃');
  assert.equal(mirror, 0, '直连成功就不该碰镜像');

  // 直连全挂 → 走镜像
  let mirror2 = 0;
  const dead = async (url) => {
    if (url.startsWith('https://gh-proxy.org/')) { mirror2 += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ version: '0.5.7' }) }; }
    throw new Error('ETIMEDOUT');
  };
  const viaMirror = await checkUpdate({ current: '0.5.5', fetchImpl: dead, mirror: 'https://gh-proxy.org' });
  assert.equal(viaMirror.ok, true, '直连全失败时镜像应兜住');
  assert.equal(mirror2, 1);
});

test('网络抖动：全挂时报的是最后一次的真实原因，不是一句"失败"', async () => {
  const r = await checkUpdate({
    current: '0.5.5',
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNRESET/);
  assert.equal(r.current, '0.5.5', '失败时也要报当前版本，别让人不知道自己在哪一版');
});

test('网络抖动：HTTP 4xx/5xx 是明确答复，不重试也不走镜像', async () => {
  let calls = 0;
  const r = await checkUpdate({
    current: '0.5.5',
    mirror: 'https://gh-proxy.org',
    fetchImpl: async () => { calls += 1; return { ok: false, status: 404, text: async () => '' }; },
  });
  assert.equal(calls, 1, '404 重试没有意义');
  assert.match(r.error, /HTTP 404/);
});

test('解包：常规文件/目录、GNU 长名、符号链接只报不建', () => {
  const dest = mkdtempSync(join(tmpdir(), 'cx-tar-'));
  try {
    const long = `pkg/very/deeply/nested/${'x'.repeat(90)}/file.txt`;
    const gz = makeTarGz([
      { name: 'pkg/', type: '5' },
      { name: 'pkg/a.txt', data: 'hello' },
      { name: 'pkg/deep/', type: '5' },
      { name: 'pkg/deep/b.bin', data: Buffer.from([1, 2, 3, 4]) },
      { name: 'pkg/link', data: 'a.txt', type: '2' },        // 符号链接
      // 100 字节以上的路径：头里的 name 放不下，GNU tar 会先写一条 typeflag='L' 的长名条目
      { name: '././@LongLink', data: long, type: 'L' },
      { name: 'junk', data: 'x' },
    ]);
    const out = extractTarGz(gz, dest);
    assert.equal(readFileSync(join(dest, 'pkg', 'a.txt'), 'utf8'), 'hello');
    assert.deepEqual([...readFileSync(join(dest, 'pkg', 'deep', 'b.bin'))], [1, 2, 3, 4]);
    assert.ok(out.written.includes('pkg/a.txt'));
    assert.ok(existsSync(join(dest, long)), 'GNU 长名条目应按完整路径落盘');
    assert.ok(out.warnings.some((w) => w.includes('符号链接未还原')), '符号链接要如实报，不静默');
    assert.equal(existsSync(join(dest, 'pkg', 'link')), false, '符号链接不应被构造出来');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('解包：越界路径整包拒绝（tar 路径穿越）', () => {
  const dest = mkdtempSync(join(tmpdir(), 'cx-tar-'));
  try {
    const gz = makeTarGz([
      { name: 'pkg/ok.txt', data: 'fine' },
      { name: '../escaped.txt', data: 'pwned' },
    ]);
    assert.throws(() => extractTarGz(gz, dest), /越界路径/);
    assert.equal(existsSync(join(dest, '..', 'escaped.txt')), false);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('findProfileDir：认 node_modules + package.json，认不到就抛', () => {
  const { root, pkgRoot, cleanup } = makeProfile();
  try {
    assert.equal(findProfileDir(pkgRoot), root);
  } finally {
    cleanup();
  }
  assert.throws(() => findProfileDir(join(tmpdir(), 'definitely-not-a-profile', 'pkg')), /无法定位 profile 目录/);
});

test('checkUpdate：远端更高 / 相同 / HTTP 失败 / 网络异常 / 没有 version 字段', async () => {
  const ok = (body) => async () => ({ ok: true, status: 200, text: async () => body });
  const newer = await checkUpdate({ current: '0.5.5', fetchImpl: ok(JSON.stringify({ version: '0.5.7' })) });
  assert.equal(newer.ok, true);
  assert.equal(newer.latest, '0.5.7');
  assert.equal(newer.updateAvailable, true);

  const same = await checkUpdate({ current: '0.5.7', fetchImpl: ok(JSON.stringify({ version: '0.5.7' })) });
  assert.equal(same.updateAvailable, false, '同版本不能报"有新版"');

  const http500 = await checkUpdate({ current: '0.5.5', fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
  assert.equal(http500.ok, false);
  assert.match(http500.error, /HTTP 503/);

  const dead = await checkUpdate({
    current: '0.5.5',
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /fetch failed/);

  const noVersion = await checkUpdate({ current: '0.5.5', fetchImpl: ok(JSON.stringify({ name: 'x' })) });
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.error, /没有 version 字段/);
});

test('换装：整目录搬走再拷新文件，profile 来源与锁文件一起改对', async () => {
  const { root, pkgRoot, cleanup } = makeProfile();
  try {
    const stages = [];
    const result = await applyUpdate({
      pkgRoot,
      fetchImpl: tarballFetch(newPackageTarball('0.5.7')),
      onProgress: (s) => stages.push(s),
    });

    assert.equal(result.ok, true);
    assert.equal(result.from, '0.5.5');
    assert.equal(result.to, '0.5.7');
    assert.equal(installedVersion(pkgRoot), '0.5.7', '盘上版本应变成新版本');
    assert.equal(readFileSync(join(pkgRoot, 'lib', 'index.js'), 'utf8'), '// new\n', '文件内容应来自新包');
    assert.equal(result.restartRequired, true);

    // 旧目录是"搬走"而不是"被覆盖"：备份仍在，且内容还是旧的。
    assert.ok(existsSync(result.backupDir), '旧版本应保留在备份目录里');
    assert.equal(installedVersion(result.backupDir), '0.5.5');
    assert.deepEqual(stages, ['downloading', 'extracting', 'backing-up', 'installing', 'syncing']);

    // profile/package.json 的 pin 跟着走
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['dsh-control-x'], `github:${REPO}#${NEW_SHA}`);
    assert.equal(pkg.dependencies['dsh-cost-meter'], '1.8.5', '不该动到别的依赖');

    // 锁文件：五处 sha 全换（含 importers 段的 specifier/version，它们不在条目块里）、
    // version 换新；**integrity 一律不写**
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    assert.equal(lock.includes(OLD_SHA), false, '旧 sha 不该残留');
    assert.equal((lock.match(new RegExp(NEW_SHA, 'g')) ?? []).length, 5, 'importers×2 + packages×2 + snapshots×1 都要换');
    assert.equal(lock.includes('version: 0.5.7'), true);
    assert.equal(lock.includes(OLD_INTEGRITY), false, '旧 integrity 必须被删掉');
    // 形状要和本 profile 里能正常工作的 dsh-teams-x 一致：gitHosted 无 integrity。
    // 0.5.7 就是因为自写 integrity 让整个 profile 的 pnpm 全线失败（ERR_PNPM_TARBALL_INTEGRITY）。
    const ourLine = lock.split('\n').find((l) => l.includes('resolution: {gitHosted') && l.includes('control-x'));
    assert.equal(ourLine.includes('integrity'), false, `本插件的 resolution 行绝不该有 integrity：${ourLine}`);
    // 隔壁包一个字节都不能动（它们的 integrity 是 pnpm 自己写的，必须留着）
    assert.equal(lock.includes('version: 1.8.5'), true, '隔壁包的 version 必须原样保留');
    assert.equal(lock.includes('sha512-Lsv0Ks4aeFsBn1qn2zdp+HdI8KGwa4b+HhzI0SKSEWH78vJ3ihWl7D2l2Cc+Pv+iMWECAL28DN3skbnqIZBow=='), true, '隔壁包的 integrity 必须留着');
    assert.equal(result.lockSynced, true);
    assert.deepEqual(result.warnings, [], `不该有警告：${JSON.stringify(result.warnings)}`);

    // 两个来源文件都留了备份
    const names = readdirSync(root);
    assert.ok(names.includes('package.json'), '原文件应仍在');
    assert.ok(names.some((n) => n.startsWith('package.json.cx-bak-')), 'package.json 应有带时间戳的备份');
    assert.ok(names.some((n) => n.startsWith('pnpm-lock.yaml.cx-bak-')), '锁文件应有备份');
  } finally {
    cleanup();
  }
});

test('换装：远端不比本地新就拒绝，不做任何写入', async () => {
  const { root, pkgRoot, cleanup } = makeProfile();
  try {
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    await assert.rejects(
      applyUpdate({ pkgRoot, fetchImpl: tarballFetch(newPackageTarball('0.5.4')) }),
      /不比本地 0.5.5 新/,
    );
    assert.equal(installedVersion(pkgRoot), '0.5.5', '盘上必须还是原版本');
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before, 'profile 文件一个字节都不该动');
  } finally {
    cleanup();
  }
});

test('syncProfileSources：锁文件里找不到本插件条目时如实报警告，不硬改', () => {
  const root = mkdtempSync(join(tmpdir(), 'cx-upd-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'dsh-control-x': 'github:x/y#abc' } }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n");
    const out = syncProfileSources({
      profileDir: root, repo: REPO, sha: NEW_SHA, newVersion: '0.5.7', backupSuffix: '.bak',
    });
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /未改写 pnpm-lock\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('作业控制器：单飞、TTL、阶段、检查失败说人话', async () => {
  const { pkgRoot, cleanup } = makeProfile();
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ version: '0.5.9' }) };
    };
    const ctl = createUpdateController({ pkgRoot, fetchImpl });
    const a = await ctl.check();
    const b = await ctl.check();
    assert.equal(calls, 1, 'TTL 内不该重复检查');
    assert.equal(a.updateAvailable, true);
    assert.equal(a.latest, '0.5.9');
    assert.equal(b.current, '0.5.5');
    await ctl.check({ force: true });
    assert.equal(calls, 2, 'force 必须真的重新打网络');

    const bad = createUpdateController({ pkgRoot, fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    const r = await bad.check();
    assert.equal(r.status, 'error');
    assert.equal(r.failedPhase, 'check');
    assert.match(r.error, /ENOTFOUND/);
    assert.equal(r.updateAvailable, false, '检查失败时必须带 error，不能只说"没新版"');
  } finally {
    cleanup();
  }
});

test('作业控制器：连点两次更新只跑一次', async () => {
  const { pkgRoot, cleanup } = makeProfile();
  try {
    let downloads = 0;
    const base = tarballFetch(newPackageTarball('0.5.7'));
    const fetchImpl = async (url) => {
      if (!url.includes('api.github.com')) downloads += 1;
      return base(url);
    };
    const ctl = createUpdateController({ pkgRoot, fetchImpl });

    const first = ctl.startApply();
    assert.equal(first.busy, true, 'apply 立即返回 busy，不阻塞 HTTP');
    const second = ctl.startApply();
    assert.equal(second.busy, true);

    for (let i = 0; i < 100 && ctl.snapshot().busy; i += 1) await new Promise((r) => setTimeout(r, 20));
    const after = ctl.snapshot();
    assert.equal(after.busy, false, '作业结束后不能再报 busy');
    assert.equal(after.status, 'done', `应更新成功，实际 ${after.status} / ${after.error}`);
    assert.equal(after.result.from, '0.5.5');
    assert.equal(after.result.to, '0.5.7');
    assert.equal(after.current, '0.5.7', '完成后当前版本应刷新');
    assert.equal(after.updateAvailable, false);
    assert.equal(downloads, 1, `连点两次只该下载一次，实际 ${downloads}`);
    assert.equal(installedVersion(pkgRoot), '0.5.7');
  } finally {
    cleanup();
  }
});

test('watch 路由：GET /update 与 POST /update 转发到控制器，缺控制器时如实报不可用', async () => {
  const calls = [];
  const updater = {
    snapshot: () => ({ status: 'idle', current: '0.5.5', updateAvailable: true, latest: '0.5.7' }),
    check: async ({ force }) => { calls.push(['check', force]); return updater.snapshot(); },
    startApply: () => { calls.push(['apply']); return { status: 'working', busy: true }; },
  };
  const ws = new WatchServer({}, () => {}, null, null, null, updater);
  let route = null;
  ws.attach({ register: (r) => { route = r; } });
  function fakeRes() {
    return { headersSent: false, status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b; } };
  }
  async function request(method, path, body) {
    const res = fakeRes();
    const payload = body === undefined ? '' : JSON.stringify(body);
    await route.handler({
      method, url: 'http://local/api/x-control' + path, on() {},
      async *[Symbol.asyncIterator]() { if (payload) yield payload; },
    }, res);
    return res;
  }

  const got = JSON.parse((await request('GET', '/update')).body);
  assert.equal(got.available, true);
  assert.equal(got.updateAvailable, true);
  await request('POST', '/update', { action: 'check' });
  await request('POST', '/update', { action: 'check', force: true });
  const applied = JSON.parse((await request('POST', '/update', { action: 'apply' })).body);
  assert.equal(applied.busy, true, 'apply 立即返回 busy，由客户端轮询');
  assert.deepEqual(calls, [['check', false], ['check', true], ['apply']]);
  const bad = JSON.parse((await request('POST', '/update', { action: 'nope' })).body);
  assert.match(bad.error, /check 或 apply/);

  const bare = new WatchServer({});
  let route2 = null;
  bare.attach({ register: (r) => { route2 = r; } });
  const res = fakeRes();
  await route2.handler({ method: 'GET', url: 'http://local/api/x-control/update', on() {} }, res);
  const off = JSON.parse(res.body);
  assert.equal(off.available, false, '没有控制器时不能说"已是最新"');
});
