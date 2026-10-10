// watch: keeps GitHub equal to what is installed, whoever installed it (deploy.sh, an agent copying
// a bundle by hand, brew upgrade). Run by launchd (com.saasempiree.app-sync, through the
// "SAASEmpire Sync.app" launcher that holds the ~/Documents grant) on every change of
// /Applications/My App or ~/Library/Application Support/SAASEmpire, and every 10 minutes.
//
//   watch-installed [--dry-run] [--verbose] [--app <slug>]
//
// For every app.json under SCAN_ROOTS whose bundle is installed (Kairo excepted: its main is production):
//   fingerprint (code-signature CDHash) == the one recorded at the last sync  -> nothing to do
//   version or build differs from the last sync (or never synced)            -> sync-after-install --from-installed
//   same version and build, different bundle                                 -> sync-after-install --source-only
// A bundle is only published once it has not changed for STABLE_MS and `codesign --verify` passes, so
// a half-copied or not-yet-signed bundle is never synced. Every failure: notification + log + audit.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTALL_DIRS, LOG_DIR, OWN_PIPELINE, REGISTRY, SCAN_ROOTS, STATE_DIR, SYNC_LOCK, TAP_FULL, WATCH_LOG, WATCH_STATE,
  isComete, releaseTag,
} from './config.mjs';
import { appInfo, bundleHash, fingerprint, notify, readJson, sleep, tryLock, tryRead, writeJson } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STABLE_MS = 30 * 1000; // the bundle must not have changed for this long
const POLL_MS = 5 * 1000;
const MAX_WAIT_MS = 10 * 60 * 1000; // a bundle still changing after this is left to the next run
const RETRY_AFTER_FAIL_MS = 30 * 60 * 1000; // same bundle, same failure: retry at most every 30 min
const RENOTIFY_MS = 6 * 60 * 60 * 1000; // ...and notify again at most every 6 h

const opt = { dryRun: false, verbose: false, only: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run' || a === '-n') opt.dryRun = true;
  else if (a === '--verbose' || a === '-v') opt.verbose = true;
  else if (a === '--app') opt.only = argv[++i];
  else if (a === '-h' || a === '--help') {
    console.log('usage: watch-installed [--dry-run] [--verbose] [--app <slug>]');
    process.exit(0);
  } else {
    console.error(`unknown option ${a}`);
    process.exit(64);
  }
}

// ---------- log ----------
const RUN = Math.random().toString(36).slice(2, 6);
function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} [${RUN}] ${msg}`;
  if (!opt.dryRun) {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(WATCH_LOG, line + '\n');
    } catch {}
  }
  if (process.stdout.isTTY || opt.dryRun || opt.verbose) console.log(line);
}
const debug = (msg) => opt.verbose && log(msg);

// ---------- apps ----------
function scanManifests() {
  const found = {};
  const consider = (dir) => {
    const p = join(dir, 'app.json');
    if (!existsSync(p)) return;
    const m = readJson(p);
    if (m?.slug && m.bundleId && m.artifact) found[m.slug] = { ...m, repo: dir };
  };
  for (const root of SCAN_ROOTS) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') throw Object.assign(new Error(`no access to ${root} (${e.code})`), { access: true });
      continue;
    }
    consider(root);
    for (const e of entries) {
      const d = join(root, e);
      try {
        if (e.startsWith('.') || e.includes('.bak') || !statSync(d).isDirectory()) continue;
      } catch {
        continue;
      }
      consider(d);
      try {
        for (const e2 of readdirSync(d)) if (!e2.startsWith('.')) consider(join(d, e2));
      } catch {}
    }
  }
  return found;
}

function findInstalled(m) {
  const base = basename(m.artifact);
  for (const d of INSTALL_DIRS)
    for (const name of new Set([base, base.normalize('NFC'), base.normalize('NFD')])) {
      const p = join(d, name);
      if (existsSync(p) && appInfo(p).bundleId === m.bundleId) return p;
    }
  const hits = tryRead('mdfind', [`kMDItemCFBundleIdentifier == '${m.bundleId}'`]).stdout.split('\n');
  return hits.find((p) => p.endsWith('.app') && INSTALL_DIRS.some((d) => p.startsWith(d + '/'))) || null;
}

// Latest change (mtime or ctime: ditto keeps the source mtimes but every copied file gets a new ctime).
function lastChange(dir) {
  let t = 0;
  const walk = (d) => {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      return;
    }
    t = Math.max(t, st.mtimeMs, st.ctimeMs);
    if (st.isDirectory()) for (const n of readdirSync(d)) walk(join(d, n));
  };
  walk(dir);
  return t;
}

const BROKEN_MS = 2 * 60 * 1000; // quiet this long and still not verifying = broken, not "being signed"

// Waits until the bundle has been quiet for STABLE_MS and verifies.
// Returns {ok} or {ok: false, broken: <codesign error>} or {ok: false} (still changing: next run).
function waitStable(slug, app) {
  const start = Date.now();
  let said = false;
  for (;;) {
    if (!existsSync(app)) return { ok: false };
    const quiet = Date.now() - lastChange(app);
    if (quiet >= STABLE_MS) {
      const v = tryRead('codesign', ['--verify', '--deep', '--strict', app]);
      if (v.status === 0) return { ok: true };
      if (quiet >= BROKEN_MS) return { ok: false, broken: (v.stderr || v.stdout).split('\n').pop() };
      if (!said) log(`${slug}: ${app} does not pass codesign --verify yet, waiting`);
      said = true;
    } else debug(`${slug}: changed ${Math.round(quiet / 1000)} s ago, waiting for ${STABLE_MS / 1000} s of quiet`);
    if (Date.now() - start > MAX_WAIT_MS) {
      log(`${slug}: still changing after ${MAX_WAIT_MS / 60000} min; left for the next run`);
      return { ok: false };
    }
    sleep(POLL_MS);
  }
}

// The tap release notes carry the bundle hash ship published (<!-- ship: bundle-sha256=... -->).
function publishedBundleHash(slug, version) {
  const r = tryRead('gh', ['release', 'view', releaseTag(slug, version), '-R', TAP_FULL, '--json', 'body', '--jq', '.body']);
  return /bundle-sha256=([0-9a-f]{64})/.exec(r.stdout || '')?.[1] || null;
}

function decide(m, app, reg) {
  const r = reg[m.slug];
  if (r?.fingerprint && r.fingerprint === app.fp) return { action: 'noop' };
  if (!r || r.lastVersion !== app.version || r.lastBuild !== app.build)
    return { action: 'release', why: r ? `${r.lastVersion} (build ${r.lastBuild}) → ${app.version} (build ${app.build})` : `never synced, installed ${app.version} (build ${app.build})` };
  if (!r.fingerprint) {
    // Synced before fingerprints existed: adopt it if it is exactly the published bundle.
    const pub = publishedBundleHash(m.slug, app.version);
    if (pub && pub === bundleHash(app.path)) return { action: 'baseline' };
  }
  return { action: 'source-only', why: `${app.version} (build ${app.build}) changed without a version bump` };
}

function runShip(m, mode) {
  const args = [join(HERE, 'ship.mjs'), mode === 'release' ? '--from-installed' : '--source-only', m.repo];
  if (isComete(m)) args.push('--allow-comete'); // read-only: --from-installed never builds, quits or relaunches
  if (opt.dryRun) args.push('--dry-run');
  log(`${m.slug}: $ ship ${args.slice(1).join(' ')}`);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SAASEMPIRE_LOCK_OWNER: String(process.pid), FORCE_COLOR: '0' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  for (const l of out.split('\n')) if (l.trim()) log(`${m.slug}:   ${l}`);
  const stopped = /STOPPED: ([^\n]+(?:\n(?!█)[^\n]+)*)/.exec(out)?.[1]?.trim();
  return { ok: r.status === 0, detail: r.status === 0 ? null : stopped || r.error?.message || `exit ${r.status}` };
}

function record(state, slug, entry) {
  state[slug] = { ...state[slug], ...entry, time: new Date().toISOString() };
}

function fail(state, m, app, action, detail) {
  const prev = state[m.slug] || {};
  const again = prev.ok === false && prev.fp === app.fp && prev.detail === detail;
  const notifiedAt = again && Date.now() - Date.parse(prev.notifiedAt || 0) < RENOTIFY_MS ? prev.notifiedAt : new Date().toISOString();
  if (notifiedAt !== prev.notifiedAt && !opt.dryRun)
    notify(`GitHub sync failed: ${m.name} ${app.version}`, `${detail.split('\n')[0]} — log: ~/Library/Logs/SAASEmpire/app-sync.log`);
  log(`${m.slug}: FAILED (${action}): ${detail.replace(/\n/g, ' | ')}`);
  record(state, m.slug, { ok: false, action, version: app.version, build: app.build, fp: app.fp, detail, notifiedAt });
}

// ---------- main ----------
function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const state = readJson(WATCH_STATE, {});
  let manifests;
  try {
    manifests = scanManifests();
  } catch (e) {
    const msg = e.access
      ? `${e.message}. Grant "SAASEmpire Sync" access: System Settings > Privacy & Security > Full Disk Access, then add ~/Library/Application Support/SAASEmpire/SAASEmpire Sync.app`
      : e.message;
    const prev = state._access || {};
    if (!opt.dryRun && Date.now() - Date.parse(prev.notifiedAt || 0) > RENOTIFY_MS) {
      notify('SAASEmpire Sync cannot read ~/Documents', msg);
      state._access = { notifiedAt: new Date().toISOString(), detail: msg };
      writeJson(WATCH_STATE, state);
    }
    log(`FAILED: ${msg}`);
    process.exit(1);
  }
  if (state._access) delete state._access;

  // 1) Plan without the lock: which installed bundles differ from their last sync.
  const reg = readJson(REGISTRY, {});
  const todo = [];
  for (const m of Object.values(manifests)) {
    if (opt.only && m.slug !== opt.only) continue;
    if (OWN_PIPELINE.includes(m.slug) || m.update === 'own') continue; // Kairo: pushing main = production
    const path = findInstalled(m);
    if (!path) continue;
    if (!existsSync(join(m.repo, '.git'))) {
      debug(`${m.slug}: ${m.repo} has no git repo, skipped`);
      continue;
    }
    const info = appInfo(path);
    if (info.bundleId !== m.bundleId) continue;
    const app = { ...info, path, fp: fingerprint(path) };
    const d = decide(m, app, reg);
    if (d.action === 'noop') {
      debug(`${m.slug}: ${app.version} (build ${app.build}) already synced`);
      continue;
    }
    const prev = state[m.slug];
    if (prev?.ok === false && prev.fp === app.fp && Date.now() - Date.parse(prev.time) < RETRY_AFTER_FAIL_MS) {
      debug(`${m.slug}: failed ${Math.round((Date.now() - Date.parse(prev.time)) / 60000)} min ago on this bundle, retry later`);
      continue;
    }
    todo.push({ m, app, d });
  }
  state._lastRun = { time: new Date().toISOString(), pending: todo.map((t) => t.m.slug) };
  if (!todo.length) {
    if (!opt.dryRun) writeJson(WATCH_STATE, state);
    debug('nothing to sync');
    return;
  }

  // 2) Wait for each changed bundle to settle (still without the lock: a deploy.sh may be mid-copy).
  //    Adopting a baseline publishes nothing, so it does not wait.
  const ready = [];
  for (const t of todo) {
    log(`${t.m.slug}: ${t.d.action}${t.d.why ? ` (${t.d.why})` : ''}, ${t.app.path}`);
    if (opt.dryRun || t.d.action === 'baseline') {
      ready.push(t);
      continue;
    }
    const w = waitStable(t.m.slug, t.app.path);
    if (w.ok) ready.push(t);
    else if (w.broken) fail(state, t.m, t.app, t.d.action, `the installed bundle does not pass codesign --verify (${w.broken}); nothing published. Reinstall it with its deploy script.`);
  }

  // 3) Act under the shared lock; re-read everything first (deploy.sh's own hook may have synced meanwhile).
  const res = tryLock(SYNC_LOCK, () => {
    const reg2 = readJson(REGISTRY, {});
    for (const { m } of ready) {
      const path = findInstalled(m);
      if (!path) continue;
      const app = { ...appInfo(path), path, fp: fingerprint(path) };
      const d = decide(m, app, reg2);
      if (d.action === 'noop') {
        log(`${m.slug}: already synced by its install hook, nothing to do`);
        continue;
      }
      if (d.action === 'baseline') {
        log(`${m.slug}: ${app.version} (build ${app.build}) is the published bundle; fingerprint recorded`);
        if (!opt.dryRun) {
          const r = readJson(REGISTRY, {});
          r[m.slug] = { ...r[m.slug], fingerprint: app.fp };
          writeJson(REGISTRY, r);
        }
        record(state, m.slug, { ok: true, action: 'baseline', version: app.version, build: app.build, fp: app.fp, detail: null });
        continue;
      }
      let r;
      try {
        r = runShip(m, d.action);
      } catch (e) {
        r = { ok: false, detail: e.message };
      }
      if (r.ok) {
        log(`${m.slug}: OK ${d.action} ${app.version} (build ${app.build})`);
        record(state, m.slug, { ok: true, action: d.action, version: app.version, build: app.build, fp: app.fp, detail: null, notifiedAt: null });
      } else fail(state, m, app, d.action, r.detail);
    }
  });
  if (res.busy) log(`another sync is running (pid ${res.busy}); the next trigger re-checks ${ready.map((t) => t.m.slug).join(', ')}`);
  // What is still not synced after this run (still changing, lock busy, failed): audit shows it.
  const started = Date.parse(state._lastRun.time);
  state._lastRun.pending = todo.map((t) => t.m.slug).filter((slug) => !(state[slug]?.ok && Date.parse(state[slug].time) >= started));
  if (!opt.dryRun) writeJson(WATCH_STATE, state);
}

try {
  main();
} catch (e) {
  log(`CRASH: ${e.stack || e}`);
  if (!opt.dryRun) notify('SAASEmpire Sync crashed', String(e.message || e).slice(0, 200));
  process.exit(1);
}
