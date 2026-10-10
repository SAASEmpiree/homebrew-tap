// Small helpers shared by ship / sync-after-install / audit. No npm dependencies.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c('1');
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

export const state = { dryRun: false };

export function step(label, text) {
  console.log(`\n${cyan(bold(`[${label}]`))} ${bold(text)}`);
}
export const info = (s) => console.log(`    ${s}`);
export const ok = (s) => console.log(`    ${green('✓')} ${s}`);
export const warn = (s) => console.log(`    ${yellow('⚠')} ${yellow(s)}`);

export class Stop extends Error {}
// Loud stop: prints a banner and exits non-zero. Nothing after it runs.
export function die(msg) {
  const bar = '█'.repeat(72);
  console.error(`\n${red(bar)}\n${red(bold('  STOPPED: '))}${red(msg)}\n${red(bar)}\n`);
  throw new Stop(msg);
}

const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
export const fmt = (cmd, args = []) => [cmd, ...args].map(q).join(' ');

// Run a command. Read-only commands pass {read: true} and run even in dry-run.
// Mutating commands are printed and skipped in dry-run.
export function run(cmd, args = [], opts = {}) {
  const { cwd, read = false, inherit = false, allowFail = false, input, env } = opts;
  const shown = fmt(cmd, args) + (cwd ? dim(`   (in ${cwd})`) : '');
  if (!read && state.dryRun) {
    console.log(`    ${yellow('DRY')} $ ${shown}`);
    return { status: 0, stdout: '', stderr: '', dry: true };
  }
  if (!read) console.log(`    ${dim('$')} ${dim(shown)}`);
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) {
    if (allowFail) return { status: 127, stdout: '', stderr: String(r.error) };
    die(`could not run ${shown}: ${r.error.message}`);
  }
  const res = { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (res.status !== 0 && !allowFail) {
    die(`command failed (${res.status}): ${shown}\n${res.stderr || res.stdout}`);
  }
  return res;
}
export const read = (cmd, args, opts = {}) => run(cmd, args, { ...opts, read: true });
export const tryRead = (cmd, args, opts = {}) => run(cmd, args, { ...opts, read: true, allowFail: true });

export function gh(args, opts = {}) {
  return run('gh', args, opts);
}
export function ghJson(args) {
  const r = tryRead('gh', args);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export function plist(appPath, key) {
  const r = tryRead('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(appPath, 'Contents/Info.plist')]);
  return r.status === 0 ? r.stdout : null;
}

export function appInfo(appPath) {
  const exe = plist(appPath, 'CFBundleExecutable');
  const archs = exe ? tryRead('lipo', ['-archs', join(appPath, 'Contents/MacOS', exe)]).stdout.split(/\s+/).filter(Boolean) : [];
  return {
    path: appPath,
    bundleId: plist(appPath, 'CFBundleIdentifier'),
    version: plist(appPath, 'CFBundleShortVersionString'),
    build: plist(appPath, 'CFBundleVersion'),
    minOS: plist(appPath, 'LSMinimumSystemVersion'),
    feedUrl: plist(appPath, 'SUFeedURL'),
    archs,
  };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Content hash of a bundle: every file, symlink target and relative path, sorted.
// Stable across re-zips, so "same bundle" can be detected without trusting zip bytes.
export function bundleHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) h.update(`L ${rel} -> ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) walk(p);
      else h.update(`F ${rel} ${st.mode & 0o111 ? 'x' : '-'} ${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`);
    }
  };
  walk(dir);
  return h.digest('hex');
}

const sleepArr = new Int32Array(new SharedArrayBuffer(4));
export const sleep = (ms) => Atomics.wait(sleepArr, 0, 0, ms);

// Process lock (mkdir is atomic). Stale locks (dead pid) are taken over.
export function withLock(dir, fn) {
  mkdirSync(join(dir, '..'), { recursive: true });
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), String(process.pid));
      break;
    } catch {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
      } catch {}
      let alive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {}
      }
      if (!alive) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) die(`lock ${dir} held by pid ${pid} for 10 min`);
      sleep(2000);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// "1.2.10" > "1.2.9"; non-numeric parts compare as strings.
export function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
