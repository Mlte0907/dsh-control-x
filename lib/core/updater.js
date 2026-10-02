/**
 * dsh-control-x 自更新：查 GitHub 上的最新版本，并把新版本换装进当前 profile。
 *
 * 为什么自带而不靠插件市场：2026-10-02 实测市场在 0.5.5 上卡住不动——用户"更新并重启"
 * 之后，profile/package.json 的 specifier 仍停在 #a3d64ff（=0.5.5），盘上跑的也是 0.5.5，
 * 而市场日志里连一条 0.5.6 的记录都没有。更新能力不能寄存在一个会静默不动的第三方身上。
 *
 * 端到端实测（真网络 + 真实 282 行 profile 锁文件，2026-10-02）：0.5.5 → 0.5.6 用时 1992ms，
 * 锁文件只动本插件那一个条目（specifier 的 sha 与 version），其余包一个字节没动。
 *
 * 换装方式（**绝不能原地写文件**）：已安装的 dsh-control-x 顶层文件是 pnpm 内容寻址
 * 存储的**硬链接**——实测 banner-overlay.ps1 有 3 个链接：.pnpm-store\v11\files\<sha512>、
 * profiles\desktop\node_modules\dsh-control-x\lib\、以及一个上次装到一半留下的 tmp 目录。
 * 原地覆写等于改坏 store 里那个按 sha512 命名的 blob，而它还被别的安装面共用。
 * 所以流程是「整目录 rename 走 → 从 tarball 全新拷进来」：rename 只搬走链接、不碰 store，
 * cpSync 落的是全新 inode（链接数 1）。
 *
 * 顺带把 profile 的 package.json 与 pnpm-lock.yaml 一起改对。**绝不写 integrity**
 * （2026-10-02 血泪，事故全文见 syncProfileSources 的注释）：0.5.7 曾把下载时现算的
 * tarball sha512 填进锁文件，当天就把整个 profile 的 pnpm 操作全线打死——
 * 自己算的校验和不可信，这个字段只能由 pnpm 自己写。这里只改 sha 与 version，
 * 并把本插件条目上可能残留的 integrity 一并删掉。手改锁文件这件事本身仍然必要：
 * 插件进程里没有可执行的 pnpm（只有 corepack 的 shim，第一次用要联网下载）；
 * 而锁文件不同步的代价很具体——将来任何一次 pnpm install 都会把插件悄悄打回旧版本，
 * 那时没有任何提示。
 *
 * 解包是纯 Node 实现（见 extractTarGz），不 spawn 外部 tar：换装要发生在 DSH 宿主进程里，
 * 多一个外部二进制就多一份"这台机器上有没有、能不能跑"的变量。
 */
import { gunzipSync } from 'node:zlib';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  cpSync, rmSync, mkdtempSync, readdirSync, openSync, writeSync, closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 上游仓库与跟踪分支。 */
export const REPO = 'Mlte0907/dsh-control-x';
export const REF = 'main';
/** 本插件在 profile 里的包名（也是 node_modules 下的目录名）。 */
export const PKG_NAME = 'dsh-control-x';

const rawUrl = (repo, ref, file) => `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
export const tarballUrl = (repo, ref) => `https://codeload.github.com/${repo}/tar.gz/${ref}`;

/** 本插件包的根目录（lib/core/updater.js → 上三级）。 */
export function packageRoot(moduleUrl = import.meta.url) {
  return dirname(dirname(dirname(fileURLToPath(moduleUrl))));
}

/** 读盘上的真实版本：比内存里那份更可信——更新刚换装完时两者会不一致。 */
export function installedVersion(pkgRoot = packageRoot()) {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 语义化版本比较。返回 >0 表示 a 更新。
 * 只按点分数字段比；预发布段（-beta.1）排在同版本正式版之后（视作更旧）。
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v ?? '').trim().replace(/^v/, '').split('-');
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // 正式版 > 预发布版
  if (pb.pre === null) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/**
 * 从包目录往上找 profile 根：认「有 node_modules 且有 package.json」的目录。
 * 找不到就抛错——宁可明确失败，也不要在猜出来的路径上改 profile 文件。
 */
export function findProfileDir(pkgRoot = packageRoot()) {
  let dir = dirname(pkgRoot);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'node_modules')) && existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`无法定位 profile 目录（从 ${pkgRoot} 向上没找到同时含 node_modules 与 package.json 的目录）`);
}

const shortErr = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').trim().slice(0, 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 镜像前缀：把整条 URL 接在前面，例如 https://gh-proxy.org/ 。空 = 只走直连。 */
const candidateUrls = (url, mirror) => {
  const m = typeof mirror === 'string' ? mirror.trim() : '';
  if (!m) return [url];
  return [url, m.endsWith('/') ? m + url : `${m}/${url}`];
};

/**
 * 按「直连 → 镜像」各重试若干次，只对**没有答复**的失败重试。
 *
 * 为什么要有这一层：2026-10-02 实测这台机器到 GitHub 的表现是
 * `raw` 中位 78ms、`tarball` 中位 523ms（都很快），但偶发 **19 秒后 ECONNRESET**。
 * 那不是慢，是连接卡住——重试一下就好，套代理反而更慢（同轮实测：镜像 raw 中位 247ms、
 * tarball 中位 731ms，分别慢 3.2 倍与 1.4 倍）。所以顺序是"先重试直连，再考虑镜像"。
 *
 * HTTP 4xx/5xx 是明确答复，不重试——重试也还是那个答复。
 */
async function fetchAny(fetchImpl, url, { mirror = '', attempts = 2, timeoutMs = 15000, headers = {} } = {}) {
  const errors = [];
  for (const candidate of candidateUrls(url, mirror)) {
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await sleep(400 * i);
      // 第一次给足 timeout，之后收窄：整体不能变成"干等一分钟才报错"
      const budget = i === 0 ? timeoutMs : Math.min(timeoutMs, 8000);
      try {
        return await fetchImpl(candidate, { signal: AbortSignal.timeout(budget), headers });
      } catch (err) {
        errors.push(`${hostOf(candidate)}: ${shortErr(err)}`);
      }
    }
  }
  throw new Error(errors.slice(-2).join('；'));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return '地址'; }
}

/**
 * 查最新版本。走 raw.githubusercontent 读远端 package.json——没有 API 限流，
 * 也不需要 token。ref 用分支名而不是 sha：少一次 API 调用，代价是理论上存在
 * 「读到的版本号」与「随后下载到的 tarball」之间的一次竞态，applyUpdate 里会
 * 拿解包后的真实 package.json 复核，对不上就如实报错，不会装出不明版本。
 */
export async function checkUpdate({
  current = installedVersion(), repo = REPO, ref = REF, fetchImpl = fetch,
  timeoutMs = 15000, mirror = '',
} = {}) {
  try {
    const res = await fetchAny(fetchImpl, rawUrl(repo, ref, 'package.json'), {
      mirror, timeoutMs, headers: { 'User-Agent': PKG_NAME },
    });
    if (!res.ok) return { ok: false, current, error: `远端返回 HTTP ${res.status}` };
    const latest = JSON.parse(await res.text()).version;
    if (typeof latest !== 'string' || !latest) return { ok: false, current, error: '远端 package.json 里没有 version 字段' };
    return { ok: true, current, latest, updateAvailable: compareVersions(latest, current) > 0, ref };
  } catch (err) {
    return { ok: false, current, error: shortErr(err) };
  }
}

/** 取分支当前 commit sha：锁文件里要的是 40 位 sha，不是分支名。取不到就如实降级。 */
export async function resolveSha({ repo = REPO, ref = REF, fetchImpl = fetch, timeoutMs = 8000, mirror = '' } = {}) {
  try {
    const res = await fetchAny(fetchImpl, `https://api.github.com/repos/${repo}/commits/${ref}`, {
      mirror, attempts: 1, timeoutMs,
      headers: { 'User-Agent': PKG_NAME, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const sha = JSON.parse(await res.text()).sha;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** 下载 tarball。（不再算 integrity：见 syncProfileSources 的注释，那条路走过一次就炸了。） */
async function downloadTarball({ repo, ref, fetchImpl, timeoutMs, onProgress, mirror }) {
  onProgress?.('downloading', '正在下载新版本…');
  const res = await fetchAny(fetchImpl, tarballUrl(repo, ref), {
    mirror, attempts: 3, timeoutMs, headers: { 'User-Agent': PKG_NAME },
  });
  if (!res.ok) throw new Error(`下载 tarball 失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载到的 tarball 只有 ${buf.length} 字节，不像一个完整的包`);
  return { buf };
}

const BLOCK = 512;
const readStr = (buf, start, len) => {
  const raw = buf.subarray(start, start + len);
  const end = raw.indexOf(0);
  return raw.toString('utf8', 0, end === -1 ? len : end);
};
const readOctal = (buf, start, len) => {
  const s = readStr(buf, start, len).trim();
  // pax/gnu 有时写 base-256（超长数字），这里遇到非八进制就当 0
  if (s === '' || !/^[0-7]+$/.test(s)) return 0;
  return Number.parseInt(s, 8);
};
/** pax 记录形如 "<len> path=xxx\n"，取最后一个 path=。 */
const paxPath = (buf) => {
  const m = [...buf.toString('utf8').matchAll(/\d+ path=([^\n]*)\n/g)].pop();
  return m ? m[1] : null;
};

/**
 * 解 tar.gz —— 纯 Node，不 spawn 外部 tar。
 *
 * tar 格式本身很简单：512 字节头 + 数据按 512 对齐。这里处理 ustar 的常规文件/目录，
 * 外加 GNU 长名（typeflag 'L'）与 pax 扩展头（'x'/'g'，取其中的 path=）——
 * 仓库里只要有超过 100 字节的路径就会用到后者。
 *
 * typeflag 归一化：`header[156]` 为 0（旧式无 typeflag）时按 '0'（常规文件）算，
 * 所以下面只需认 '0'/'1'/'2'/'5'/'L'/'x'/'g'，其余（设备/FIFO）一个包用不上，跳过。
 *
 * 安全：解出来的每一条路径都必须落在目标目录内，否则整包拒绝（tar 路径穿越）。
 * 符号链接不还原：远端 tarball 里出现时如实记一条警告，不去构造它。
 */
export function extractTarGz(buf, destDir) {
  const tar = gunzipSync(buf);
  const written = [];
  const warnings = [];
  const root = resolve(destDir);
  const safeJoin = (name) => {
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`tarball 里出现越界路径，已拒绝：${name}`);
    }
    return target;
  };
  const writeAt = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, 'w');
    try { writeSync(fd, data); } finally { closeSync(fd); }
  };

  let offset = 0;
  let longName = null;
  let paxName = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((b) => b === 0)) break;              // 结束标记：两个空块
    const size = readOctal(header, 124, 12);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('tarball 头里声明的长度超出数据范围');
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156] || 0x30);
    if (type === 'L') { longName = readStr(data, 0, data.length); continue; }
    if (type === 'x' || type === 'g') { paxName = paxPath(data); continue; }

    const prefix = readStr(header, 345, 155);
    const base = readStr(header, 0, 100);
    const name = paxName ?? longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = null;
    paxName = null;

    if (type === '5') { mkdirSync(safeJoin(name), { recursive: true }); continue; }
    if (type === '2') { warnings.push(`tarball 里的符号链接未还原：${name}`); continue; }
    if (type === '1') {                                    // 硬链接：内容取自同包内已解出的那个文件
      const target = safeJoin(readStr(header, 157, 100));
      if (!existsSync(target)) { warnings.push(`tarball 里的硬链接指向不存在的文件：${name}`); continue; }
      writeAt(safeJoin(name), readFileSync(target));
      written.push(name);
      continue;
    }
    if (type !== '0') continue;                            // 设备/FIFO 等，跳过
    writeAt(safeJoin(name), data);
    written.push(name);
  }
  if (written.length === 0) throw new Error('tarball 解包后一个文件也没有');
  return { written, warnings };
}

/**
 * 解包到临时目录，返回其中的 src。
 *
 * 2026-10-02 修：临时目录此前**只在 catch 里**被删，成功路径直接泄漏——每次成功更新都在
 * %TEMP% 留一个完整的解包副本（本机实测累计 68 个目录 / 11.7 MB，且每份都是一份可执行的
 * 插件代码副本躺在临时目录里）。实测：跑一次成功的 applyUpdate，cx-update-* 计数 +1。
 * 这个插件在另外两处对同一类泄漏都有专门的回归记录（banner-win.js 的临时目录、
 * host-contract-verify.mjs 的 pkgRoot），updater 这处漏了。
 *
 * 现在 src 的生命周期跟着调用方走：调用方必须在用完后调 cleanup()。
 */
function extractTarball({ buf, onProgress }) {
  onProgress?.('extracting', '正在解包…');
  const dir = mkdtempSync(join(tmpdir(), 'cx-update-'));
  try {
    const out = extractTarGz(buf, dir);
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (entries.length !== 1) {
      throw new Error(`tarball 解包后有 ${entries.length} 个顶层目录，预期 1 个`);
    }
    return {
      src: join(dir, entries[0].name),
      warnings: out.warnings,
      cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已清理 */ } },
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`解包失败：${shortErr(err)}`);
  }
}

/**
 * 把 profile/package.json 与 pnpm-lock.yaml 里的来源一起改到新 commit。
 * 先各自备份；锁文件改到一半失败就整体还原，绝不留下"改了一半"的锁文件。
 *
 * 锁文件按块处理：条目头是「两空格 + 非空格」，块内是四空格缩进的键。
 * 用缩进判断块的起止，而不是"遇到空行就结束"——后者会在紧邻的空行处截断。
 *
 * **绝不写 integrity**（2026-10-02 血泪）：早先这里会把下载到的 tarball 现算一个
 * sha512 填进去。0.5.7 装机当天就炸了——插件管理器跑 pnpm 时直接
 * `ERR_PNPM_TARBALL_INTEGRITY`：Wanted 是我写的值、Got 是 pnpm 自己下载到的值。
 * 而同一个 commit 现在连下三次哈希都相同，说明**当时那份字节与后来不是同一份**
 * （新推的 commit，codeload 的归档可能重新生成过），具体成因没查清。
 * 结论很明确：**自己算出来的 integrity 不可信**。错一个值，之后每一次 pnpm 操作
 * 都会以"疑似供应链投毒"的名义全线失败——那正是用户"连卸载插件市场都操作不了"的原因。
 * 所以这里只改 sha，并把我们那条上可能存在的 integrity **删掉**，让 pnpm 自己写。
 * 本 profile 里 `dsh-teams-x` 就是无 integrity 的形状，且工作正常。
 */
export function syncProfileSources({ profileDir, repo, sha, newVersion, backupSuffix = '' }) {
  const warnings = [];
  const pkgPath = join(profileDir, 'package.json');
  const lockPath = join(profileDir, 'pnpm-lock.yaml');
  const specifier = `github:${repo}#${sha}`;

  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const deps = pkg.dependencies ?? {};
  if (!(PKG_NAME in deps)) throw new Error(`profile/package.json 的 dependencies 里没有 ${PKG_NAME}，放弃改写`);
  const oldSpecifier = deps[PKG_NAME];
  deps[PKG_NAME] = specifier;
  writeFileSync(`${pkgPath}${backupSuffix}`, pkgRaw);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // 锁文件里的旧 sha 从文件自身读出，不写死——pin 早就换过好几轮了。
  const lockRaw = readFileSync(lockPath, 'utf8');
  const oldSha = lockRaw.match(
    new RegExp(`${PKG_NAME}@https://codeload\\.github\\.com/[^\\s]+/tar\\.gz/([0-9a-f]{40})`),
  )?.[1];
  if (!oldSha) {
    warnings.push('锁文件里没找到本插件的 codeload 条目，未改写 pnpm-lock.yaml；将来一次 pnpm install 可能会把版本改回去。');
  } else {
    // oldSha === sha 时替换是空操作，但 version 仍要刷新，所以不特判。
    writeFileSync(`${lockPath}${backupSuffix}`, lockRaw);
    try {
      // 旧 sha 是 40 位十六进制的独占标记，全文替换是安全的——它只可能属于本包。
      // importers 段的 specifier/version 在 6~8 空格的缩进层里，不属于任何条目块，
      // 所以必须全文替换；块内只需要处理 version 与 integrity 两个键。
      const lines = lockRaw.split(oldSha).join(sha).split('\n');
      let inBlock = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (/^ {2}\S/.test(lines[i])) {
          inBlock = lines[i].startsWith(`  ${PKG_NAME}@https://codeload.github.com/`);
          continue;
        }
        if (!inBlock) continue;
        if (/^ {4}version: /.test(lines[i])) lines[i] = `    version: ${newVersion}`;
        if (lines[i].includes('integrity: sha512-')) {
          // 删掉而不是改写：见函数头注释。自己算的值留着比删掉更危险。
          lines[i] = lines[i].replace(/integrity: sha512-[A-Za-z0-9+/=]+, /, '');
        }
      }
      writeFileSync(lockPath, lines.join('\n'));
    } catch (err) {
      writeFileSync(lockPath, lockRaw);   // 改一半的锁文件比不改更糟
      warnings.push(`改写 pnpm-lock.yaml 失败已还原：${shortErr(err)}`);
    }
  }
  return { warnings, oldSpecifier, specifier };
}

/**
 * 执行更新：下载 → 解包 → 校验版本 → 整目录换装 → 同步 profile 来源。
 *
 * 换装失败（拷贝异常等）会回滚：删掉装了一半的新目录，把备份原样搬回去，
 * 让 profile 回到"能跑"的状态，而不是留一个残缺的插件。
 */
export async function applyUpdate({
  repo = REPO, ref = REF, pkgRoot = packageRoot(), fetchImpl = fetch,
  timeoutMs = 120000, onProgress = null, mirror = '',
} = {}) {
  const from = installedVersion(pkgRoot);
  const profileDir = findProfileDir(pkgRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // 下载**前**先把 ref 钉成 40 位 commit sha（2026-10-02 修）。
  //
  // 此前是 `downloadTarball({ ref })` 直接拉分支名，也就是 codeload 的 tar.gz/main——
  // 一个**会移动**的引用。而 resolveSha() 明明就在下面被调用（只拿去写锁文件），
  // 于是"检查时看到的版本"与"随后下载到的字节"之间存在一次真实的竞态。
  // 钉成 sha 之后，下载的是检查阶段确定的那一份，风险从"随时可能变"降到"锁定"。
  //
  // 取不到 sha 时**不降级**：如实失败。退化成分支名等于把刚消除的竞态又请回来，
  // 而"降级"看起来像成功更糟（这是 applyUpdate 里 syncProfileSources 那条警告的同一条道理）。
  const sha = await resolveSha({ repo, ref, fetchImpl, mirror });
  if (sha === null) {
    throw new Error(
      `无法确定 ${repo}@${ref} 的 commit sha（GitHub API 不可用或限流），已放弃更新。` +
      '不接受"退化成拉分支名"：那会让检查阶段看到的版本与实际下载到的字节之间出现竞态。' +
      '请检查网络后重试。',
    );
  }

  const { buf } = await downloadTarball({ repo, ref: sha, fetchImpl, timeoutMs, onProgress, mirror });
  const { src, warnings: unpackWarnings, cleanup } = extractTarball({ buf, onProgress });

  // 从这里往后的每一次退出都必须清掉解包临时目录，所以整段包在一个 try/finally 里。
  // （此前成功路径完全不清理：每次成功更新都在 %TEMP% 留一份完整代码副本。）
  try {
    // 复核：以解包出来的真实 package.json 为准，不拿检查阶段的字符串当既成事实。
    const newPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    if (typeof newPkg.version !== 'string' || !newPkg.version) {
      throw new Error('新包里没有 package.json 的 version 字段，放弃更新');
    }
    if (compareVersions(newPkg.version, from) <= 0) {
      throw new Error(`远端版本 ${newPkg.version} 不比本地 ${from} 新，放弃更新`);
    }

    onProgress?.('backing-up', '正在备份当前版本…');
    const backupDir = join(profileDir, '.cx-backups', `${PKG_NAME}-${from}-${stamp}`);
    mkdirSync(dirname(backupDir), { recursive: true });
    renameSync(pkgRoot, backupDir);

    onProgress?.('installing', '正在安装新版本…');
    try {
      cpSync(src, pkgRoot, { recursive: true });
    } catch (err) {
      try { rmSync(pkgRoot, { recursive: true, force: true }); } catch { /* 下面整体回滚 */ }
      renameSync(backupDir, pkgRoot);
      throw new Error(`安装失败已回滚到 ${from}：${shortErr(err)}`);
    }

    onProgress?.('syncing', '正在同步 profile 来源…');
    const warnings = [...unpackWarnings];
    let sync = null;
    // sha 已在下载前解析并用于下载（见上），这里直接复用，不再二次调用 resolveSha。
    try {
      sync = syncProfileSources({
        profileDir, repo, sha,
        newVersion: newPkg.version, backupSuffix: `.cx-bak-${stamp}`,
      });
      warnings.push(...sync.warnings);
    } catch (err) {
      // 插件本体已经装好了，只是 profile 的来源说明没跟上：这是"更新成功 + 一条警告"，
      // 不是"更新失败"。两件事分开报，不混成一个失败。
      warnings.push(`profile 来源未同步（${shortErr(err)}）；插件本体已是 ${newPkg.version}，但将来一次 pnpm install 可能把它改回去。`);
    }

    return {
      ok: true, from, to: newPkg.version, backupDir,
      restartRequired: true,
      lockSynced: sync !== null,
      warnings,
    };
  } finally {
    cleanup();
  }
}

const BUSY_STATUS = new Set(['checking', 'working']);

/**
 * 更新作业的状态机：单飞（同一时刻只有一个作业）、可轮询的阶段快照。
 *
 * 检查与更新的等待时间差一个量级（检查 ~1s，更新含下载解包可能几十秒），所以两者
 * 的 HTTP 语义刻意不同：check **await 到结束**再返回（客户端一次请求就拿到结论），
 * apply **立即返回**、客户端轮询 snapshot()。两者共用一个 inflight 闸，避免连点两次
 * 就装出两个目录。
 */
export function createUpdateController({
  pkgRoot = packageRoot(), repo = REPO, ref = REF, checkTtlMs = 60000, logger = null,
  // fetchImpl 只给测试用：生产走真实 fetch。mirror 是 URL 前缀，可以传函数——
  // 设置页改镜像后不用重启插件：cfg 是 getter，每次作业都现读一次。
  fetchImpl = fetch, timeoutMs = 120000, mirror = '',
  // 内存里真正在执行的插件版本（apply 之后它与磁盘上的 current 会暂时不一致，
  // 客户端靠这个差值稳定显示「已换装，重启生效」——磁盘版本换装完就变，靠它判断会丢提醒）。
  runningVersion = '',
} = {}) {
  const mirrorOf = () => (typeof mirror === 'function' ? mirror() : mirror) ?? '';
  let state = {
    status: 'idle',
    stage: '',
    current: installedVersion(pkgRoot),
    latest: '',
    updateAvailable: false,
    checkedAt: 0,
    error: '',
    /** 出错的是哪一步：'check' 还是 'apply'。缺了它，"检查失败"会出现在更新失败的场景里。 */
    failedPhase: '',
    result: null,
    runningVersion,
  };
  let inflight = null;

  const publish = (patch) => { state = Object.assign({}, state, patch); };
  const snapshot = () => Object.assign({ busy: BUSY_STATUS.has(state.status) }, state);

  async function check({ force = false } = {}) {
    if (inflight) return snapshot();
    if (!force && state.checkedAt > 0 && Date.now() - state.checkedAt < checkTtlMs) return snapshot();
    publish({ status: 'checking', stage: '正在检查版本…', error: '', failedPhase: '' });
    const job = (async () => {
      const r = await checkUpdate({ current: installedVersion(pkgRoot), repo, ref, fetchImpl, mirror: mirrorOf() });
      if (r.ok) {
        publish({
          status: 'idle', stage: '', current: r.current, latest: r.latest,
          updateAvailable: r.updateAvailable, checkedAt: Date.now(), error: '', failedPhase: '',
        });
      } else {
        publish({
          status: 'error', stage: '', current: r.current, checkedAt: Date.now(),
          error: r.error, failedPhase: 'check',
        });
      }
    })();
    inflight = job;
    try {
      await job;
    } finally {
      inflight = null;
    }
    return snapshot();
  }

  function startApply() {
    if (inflight) return snapshot();
    publish({ status: 'working', stage: '正在准备…', error: '', failedPhase: '', result: null });
    const job = applyUpdate({
      repo, ref, pkgRoot, fetchImpl, timeoutMs, mirror: mirrorOf(),
      onProgress: (_stage, message) => publish({ status: 'working', stage: message }),
    })
      .then((r) => {
        publish({
          status: 'done', stage: '', current: r.to, latest: r.to,
          updateAvailable: false, result: r, error: '', failedPhase: '',
        });
        logger?.info?.(`dsh-control-x: 自更新完成 ${r.from} → ${r.to}（备份 ${r.backupDir}）`);
        return r;
      })
      .catch((err) => {
        publish({
          status: 'error', stage: '', current: installedVersion(pkgRoot),
          error: shortErr(err), failedPhase: 'apply',
        });
        logger?.warn?.(`dsh-control-x: 自更新失败：${shortErr(err)}`);
        throw err;
      })
      .finally(() => { inflight = null; });
    // 单飞闸：漏了这一行的话，连点两次"更新"会并行跑两个 applyUpdate，
    // 两个都在 rename 同一个包目录，Windows 上第二个直接 EPERM——
    // 而且是在第一个已经把目录搬走之后才炸。
    inflight = job;
    job.catch(() => undefined);   // 失败信息已进 state；不让它变成 unhandledRejection
    return snapshot();
  }

  return { snapshot, check, startApply };
}
