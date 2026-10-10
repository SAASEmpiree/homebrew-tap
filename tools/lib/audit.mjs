// audit: is GitHub equal to what is installed on this Mac? And is every code repo private?
//
//   audit [--fix-visibility] [--remote-only] [--strict] [--json]
//
//   --fix-visibility  make every PUBLIC repo outside the allow-list private
//   --remote-only     never read ~/Documents (what the launchd guard uses: launchd jobs have no
//                     access to Documents under TCC); local dirty/unpushed columns become "n/a"
//   --strict          exit 1 on any drift too (default: only on a public repo left outside the allow-list)
//   --json            machine-readable output
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { caskVersion } from './catalogue.mjs';
import { INSTALL_DIRS, OWNER, PUBLIC_ALLOWLIST, REGISTRY, SCAN_ROOTS, TAP_FULL } from './config.mjs';
import { Stop, appInfo, bold, cmpVersion, die, ghJson, green, readJson, red, run, tryRead, yellow } from './common.mjs';

const opt = { fix: false, remoteOnly: false, strict: false, json: false };
for (const a of process.argv.slice(2)) {
  if (a === '--fix-visibility') opt.fix = true;
  else if (a === '--remote-only') opt.remoteOnly = true;
  else if (a === '--strict') opt.strict = true;
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    console.log('usage: audit [--fix-visibility] [--remote-only] [--strict] [--json]');
    process.exit(0);
  } else {
    console.error(`unknown option ${a}`);
    process.exit(64);
  }
}

const ghRaw = (path) => {
  const r = tryRead('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${TAP_FULL}/contents/${path}?ref=main`]);
  return r.status === 0 ? r.stdout : null;
};
const ghList = (dir) => (ghJson(['api', `repos/${TAP_FULL}/contents/${dir}?ref=main`]) || []).map((e) => e.name);

function scanLocal() {
  const found = {};
  if (opt.remoteOnly) return found;
  const consider = (dir) => {
    const p = join(dir, 'app.json');
    if (!existsSync(p)) return;
    const m = readJson(p);
    if (m?.slug) found[m.slug] = { ...m, repo: dir };
  };
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue;
    consider(root);
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const d = join(root, e);
      try {
        if (!statSync(d).isDirectory() || e.startsWith('.') || e.includes('.bak')) continue;
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

function findInstalled(a) {
  const names = [a.appName, a.artifact && basename(a.artifact), `${a.name}.app`].filter(Boolean);
  if (a.installedPath && existsSync(a.installedPath)) return a.installedPath;
  for (const d of INSTALL_DIRS) for (const n of names) if (existsSync(join(d, n)) && (!a.bundleId || appInfo(join(d, n)).bundleId === a.bundleId)) return join(d, n);
  if (a.bundleId) {
    const hits = tryRead('mdfind', [`kMDItemCFBundleIdentifier == '${a.bundleId}'`]).stdout.split('\n');
    return hits.find((p) => INSTALL_DIRS.some((d) => p.startsWith(d + '/'))) || null;
  }
  return null;
}

function latestTag(slug) {
  const tags = ghJson(['api', '--paginate', `repos/${OWNER}/${slug}/tags?per_page=100`]);
  if (!Array.isArray(tags)) return null;
  const v = tags.map((t) => t.name).filter((n) => /^v\d/.test(n)).sort(cmpVersion);
  return v.length ? v[v.length - 1].slice(1) : null;
}

function appcastVersion(xml) {
  if (!xml) return null;
  const v = [...xml.matchAll(/<sparkle:shortVersionString>([^<]+)</g)].map((m) => m[1]).sort(cmpVersion);
  return v.length ? v[v.length - 1] : 'empty';
}

function localState(repo) {
  if (opt.remoteOnly || !repo) return { dirty: 'n/a', unpushed: 'n/a' };
  if (tryRead('git', ['rev-parse', '--show-toplevel'], { cwd: repo }).stdout !== repo) return { dirty: 'no repo', unpushed: 'no repo' };
  tryRead('git', ['fetch', '--quiet', 'origin'], { cwd: repo });
  const dirty = tryRead('git', ['status', '--porcelain'], { cwd: repo }).stdout.split('\n').filter(Boolean).length;
  const ahead = (range) => {
    const r = tryRead('git', ['rev-list', '--count', range], { cwd: repo });
    return r.status === 0 ? Number(r.stdout) : 0;
  };
  const branch = tryRead('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: repo }).stdout;
  let unpushed = ahead('origin/main..main');
  if (branch && branch !== 'main') unpushed = Math.max(unpushed, ahead(`origin/main..${branch}`));
  return { dirty, unpushed, branch };
}

function main() {
  const repos = ghJson(['repo', 'list', OWNER, '--limit', '500', '--json', 'name,visibility,isFork']) || die('gh repo list failed (is gh logged in?)');
  const vis = Object.fromEntries(repos.map((r) => [r.name.toLowerCase(), r.visibility]));

  // Apps = tap catalogue (GitHub) ∪ local app.json files ∪ the registry ship keeps.
  const apps = {};
  for (const f of ghList('apps').filter((n) => n.endsWith('.json'))) {
    try {
      const a = JSON.parse(ghRaw(`apps/${f}`));
      apps[a.slug] = { ...a };
    } catch {}
  }
  for (const [slug, m] of Object.entries(scanLocal())) apps[slug] = { ...apps[slug], ...m };
  for (const [slug, r] of Object.entries(readJson(REGISTRY, {}))) apps[slug] = { ...r, ...apps[slug], repo: apps[slug]?.repo || r.repo, installedPath: r.installedPath };

  const casks = new Set(ghList('Casks'));
  const feeds = new Set(ghList('appcasts'));
  const rows = [];
  for (const a of Object.values(apps).sort((x, y) => (x.order ?? 999) - (y.order ?? 999) || x.slug.localeCompare(y.slug))) {
    const inst = findInstalled(a);
    const installed = inst ? appInfo(inst).version : null;
    const tag = latestTag(a.slug);
    const cask = casks.has(`${a.slug}.rb`) ? caskVersion(ghRaw(`Casks/${a.slug}.rb`)) : null;
    const appcast = a.update === 'sparkle' ? (feeds.has(`${a.slug}.xml`) ? appcastVersion(ghRaw(`appcasts/${a.slug}.xml`)) : null) : '—';
    const visibility = vis[a.slug] || 'missing';
    const loc = localState(a.repo);
    const issues = [];
    if (a.update === 'own') {
      if (installed && tag && installed !== tag) issues.push(`installed ${installed} ≠ tag ${tag}`);
    } else {
      if (!installed) issues.push('not installed');
      if (installed && tag !== installed) issues.push(tag ? `tag ${tag} ≠ installed` : 'no tag');
      if (installed && cask !== installed) issues.push(cask ? `cask ${cask} ≠ installed` : 'no cask');
      if (a.update === 'sparkle' && installed && appcast !== installed) issues.push(appcast ? `appcast ${appcast} ≠ installed` : 'no appcast');
    }
    if (visibility === 'missing') issues.push('no repo');
    else if (visibility !== 'PRIVATE') issues.push(`repo is ${visibility}`);
    if (typeof loc.dirty === 'number' && loc.dirty) issues.push(`${loc.dirty} uncommitted`);
    if (typeof loc.unpushed === 'number' && loc.unpushed) issues.push(`${loc.unpushed} unpushed`);
    rows.push({ app: a.name || a.slug, slug: a.slug, update: a.update || '?', installed: installed || '—', tag: tag || '—', cask: cask || '—', appcast: appcast || '—', visibility, dirty: loc.dirty, unpushed: loc.unpushed, ok: issues.length === 0, issues });
  }

  // Visibility guard.
  const exposed = repos.filter((r) => r.visibility === 'PUBLIC' && !PUBLIC_ALLOWLIST.some((n) => n.toLowerCase() === r.name.toLowerCase()));
  const notPublic = PUBLIC_ALLOWLIST.filter((n) => vis[n.toLowerCase()] && vis[n.toLowerCase()] !== 'PUBLIC');
  const fixed = [];
  const failed = [];
  if (opt.fix) {
    for (const r of exposed) {
      const res = run('gh', ['repo', 'edit', `${OWNER}/${r.name}`, '--visibility', 'private', '--accept-visibility-change-consequences'], { allowFail: true });
      (res.status === 0 ? fixed : failed).push(r.name + (res.status === 0 ? '' : ` (${res.stderr.split('\n')[0]}${r.isFork ? '; forks cannot be private' : ''})`));
    }
  }
  const stillExposed = opt.fix ? failed : exposed.map((r) => r.name);

  if (opt.json) {
    console.log(JSON.stringify({ date: new Date().toISOString(), apps: rows, publicOutsideAllowList: exposed.map((r) => r.name), madePrivate: fixed, failed, allowListedNotPublic: notPublic }, null, 2));
  } else {
    console.log(bold(`SAASEmpiree audit · ${new Date().toISOString().replace('T', ' ').slice(0, 19)}${opt.remoteOnly ? ' · remote-only' : ''}\n`));
    const head = ['App', 'Update', 'Installed', 'Repo tag', 'Cask', 'Appcast', 'Repo', 'Dirty', 'Unpushed', 'Status'];
    const body = rows.map((r) => [r.app, r.update, r.installed, r.tag, r.cask, r.appcast, r.visibility.toLowerCase(), String(r.dirty), String(r.unpushed), r.ok ? 'OK' : r.issues.join('; ')]);
    const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (cells) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(' | ')} |`;
    console.log(line(head));
    console.log(`|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`);
    for (const [i, b] of body.entries()) {
      const s = line(b);
      console.log(rows[i].ok ? s : process.stdout.isTTY ? yellow(s) : s);
    }
    const drift = rows.filter((r) => !r.ok).length;
    console.log(`\n${drift ? yellow(`${drift} app(s) drift from GitHub`) : green('Every app matches GitHub.')}`);

    console.log(bold(`\nPublic repos outside the allow-list (${PUBLIC_ALLOWLIST.join(', ')})`));
    if (!exposed.length) console.log(green('  none'));
    for (const r of exposed) console.log(`  ${red('PUBLIC')} ${OWNER}/${r.name}${fixed.includes(r.name) ? green('  → made private') : ''}`);
    for (const f of failed) console.log(red(`  could not make private: ${f}`));
    if (exposed.length && !opt.fix) console.log('  run `audit --fix-visibility` to make them private');
    for (const n of notPublic) console.log(yellow(`  note: allow-listed ${OWNER}/${n} is ${vis[n.toLowerCase()]}, expected PUBLIC`));
  }
  const drift = rows.some((r) => !r.ok);
  process.exit(stillExposed.length || (opt.strict && drift) ? 1 : 0);
}

try {
  main();
} catch (e) {
  if (e instanceof Stop) process.exit(1);
  throw e;
}
