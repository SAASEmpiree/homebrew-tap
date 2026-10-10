// ship / sync-after-install: publish what is built (and installed) to GitHub.
//
//   ship <app-repo> [--dry-run] [--allow-comete] [--app <path.app>]
//     (a) build  (b) install  (c) read the version from the .app  (d) commit, ff main, push, tag
//     (e) zip, tap release <slug>-v<version>, cask, appcast (Sparkle)  (f) commit + push the tap
//   sync-after-install <app-repo> [...]   = the same with --sync-only: steps (c)-(f) only.
//   sync-after-install --from-installed <app-repo>   publish the copy installed TODAY (no build,
//     no install, never the repo's build output): /Applications/My App/<artifact>, or wherever the
//     bundle id is installed (AppGrid: ~/Library/Application Support/SAASEmpire). Read-only on the app.
//
// Idempotent: same version + same bundle => nothing is duplicated, nothing new is pushed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { writeReadme, renderCask } from './catalogue.mjs';
import {
  APP_DIR, CACHE, INSTALL_DIRS, LEGACY_FEED_MIRROR, LEGACY_FEED_REPO, MAX_FILE_BYTES, OWN_PIPELINE, OWNER,
  REGISTRY, SPARKLE_BIN, STATE_DIR, TAP_FULL, TAP_ROOT, assetName, catalogueUrl, downloadPrefix, feedUrl,
  isComete, releaseTag,
} from './config.mjs';
import {
  Stop, appInfo, bold, bundleHash, die, gh, ghJson, info, ok, read, readJson, run, sha256File, state, step,
  tryRead, warn, withLock, writeJson,
} from './common.mjs';

const USAGE = `usage:
  ship <path-to-app-repo> [--dry-run] [--allow-comete] [--app <path/to/App.app>]
  sync-after-install <path-inside-app-repo> [--dry-run] [--allow-comete] [--app <path/to/App.app>]
  sync-after-install --from-installed <path-to-app-repo> [--dry-run] [--allow-comete]

  --from-installed publish the installed copy as it is (no build, no install, no fallback to the
                   build artifact; stops if the app is not installed). Same as ship --from-installed.
  --dry-run        print every step and command, change nothing (no build, no push, no upload)
  --allow-comete   allow Comète; even then the install step is skipped (never quit/relaunch Comète)
  --app <path>     publish this .app instead of the one ship would pick (installed copy, else artifact)`;

function parseArgs(argv) {
  const o = { dryRun: false, allowComete: false, syncOnly: false, fromInstalled: false, app: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--allow-comete') o.allowComete = true;
    else if (a === '--sync-only') o.syncOnly = true;
    else if (a === '--from-installed') o.fromInstalled = o.syncOnly = true;
    else if (a === '--app') o.app = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('-')) {
      console.error(`unknown option ${a}\n${USAGE}`);
      process.exit(64);
    } else if (!o.path) o.path = a;
    else {
      console.error(`unexpected argument ${a}\n${USAGE}`);
      process.exit(64);
    }
  }
  if (!o.path) {
    console.error(USAGE);
    process.exit(64);
  }
  if (o.fromInstalled && o.app) {
    console.error(`--from-installed and --app are exclusive (--app already names the bundle to publish)\n${USAGE}`);
    process.exit(64);
  }
  return o;
}

// Walks up from <p> (a folder or a file such as the calling script's "$0") to the folder holding
// app.json. If <p> does not exist (a relative "$0" after the script cd'ed), walks up from the cwd.
function findRepoRoot(p) {
  const up = (start) => {
    let d = start;
    if (existsSync(d) && !statSync(d).isDirectory()) d = dirname(d);
    for (;;) {
      if (existsSync(join(d, 'app.json'))) return d;
      const parent = dirname(d);
      if (parent === d) return null;
      d = parent;
    }
  };
  const abs = resolve(p);
  const root = (existsSync(abs) && up(abs)) || up(process.cwd());
  if (!root) die(`no app.json found in ${abs}, ${process.cwd()} or any parent folder`);
  return root;
}

function loadManifest(root) {
  let m;
  try {
    m = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
  } catch (e) {
    die(`app.json in ${root} is not valid JSON: ${e.message}`);
  }
  for (const k of ['name', 'slug', 'bundleId', 'artifact', 'update']) if (!m[k]) die(`app.json: missing "${k}"`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(m.slug)) die(`app.json: slug "${m.slug}" must be lowercase ASCII`);
  if (!['sparkle', 'brew', 'own'].includes(m.update)) die(`app.json: update must be sparkle | brew | own (got ${m.update})`);
  m.platforms ||= ['macos'];
  return m;
}

// ---------- (c) which .app, which version ----------
function findInstalled(m) {
  const base = basename(m.artifact);
  for (const d of INSTALL_DIRS) {
    for (const name of new Set([base, base.normalize('NFC'), base.normalize('NFD')])) {
      const p = join(d, name);
      if (existsSync(p) && appInfo(p).bundleId === m.bundleId) return p;
    }
  }
  const r = tryRead('mdfind', [`kMDItemCFBundleIdentifier == '${m.bundleId}'`]);
  const hits = r.stdout.split('\n').filter((p) => p.endsWith('.app') && INSTALL_DIRS.some((d) => p.startsWith(d + '/')));
  return hits[0] || null;
}

function pickApp(root, m, opt, installRan) {
  if (opt.app) return resolve(opt.app);
  if (opt.fromInstalled) {
    const inst = findInstalled(m);
    if (!inst) die(`--from-installed: no installed copy of ${m.bundleId} in ${INSTALL_DIRS.join(', ')} (nor found by Spotlight there). Nothing published.`);
    return inst;
  }
  const artifact = resolve(root, m.artifact);
  if (installRan || (opt.syncOnly && m.install)) {
    const inst = findInstalled(m);
    if (inst) return inst;
    warn(`install step declared but no installed copy of ${m.bundleId} found in ${INSTALL_DIRS.join(', ')}; using the build artifact`);
  }
  return artifact;
}

// ---------- (d) app repo: commit, fast-forward main, push, tag ----------
const NAME_RX = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/, '.env file'],
  [/private_key/i, 'private key file'],
  [/\.(p12|pem|pfx|mobileprovision)$/i, 'certificate/key file'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)$/, 'SSH key'],
];
const CONTENT_RX = [
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'GitHub token'],
  [/\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/, 'JWT (Supabase key?)'],
  [/\bsb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase secret key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
];

// Scans what is staged. Paths listed in <repo>/.secretscan-allow (one per line) are exempt.
function secretScan(top) {
  const allowFile = join(top, '.secretscan-allow');
  const allow = new Set(existsSync(allowFile) ? readFileSync(allowFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : []);
  const names = read('git', ['diff', '--cached', '--name-only', '--diff-filter=AM', '-z'], { cwd: top }).stdout.split('\0').filter(Boolean);
  const hits = [];
  for (const f of names) {
    if (allow.has(f)) continue;
    for (const [rx, what] of NAME_RX) if (rx.test(f)) hits.push(`${f}: ${what}`);
    const p = join(top, f);
    if (existsSync(p) && statSync(p).size > MAX_FILE_BYTES) hits.push(`${f}: larger than 50 MB`);
  }
  const diff = read('git', ['diff', '--cached', '-U0', '--no-color', '--diff-filter=AM'], { cwd: top }).stdout;
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+') && !allow.has(file)) {
      for (const [rx, what] of CONTENT_RX) if (rx.test(line)) hits.push(`${file}: ${what}`);
    }
  }
  return [...new Set(hits)];
}

function isAncestor(top, a, b) {
  return tryRead('git', ['merge-base', '--is-ancestor', a, b], { cwd: top }).status === 0;
}
const revParse = (top, ref) => {
  const r = tryRead('git', ['rev-parse', '-q', '--verify', ref], { cwd: top });
  return r.status === 0 ? r.stdout : null;
};

function syncRepo(root, m, version) {
  const top = tryRead('git', ['rev-parse', '--show-toplevel'], { cwd: root }).stdout;
  if (!top) die(`${root} is not a git repository. Create its repo first: gh new ${m.slug}`);
  if (resolve(top) !== resolve(root)) die(`app.json must sit at the repo root (${top}), not in ${root}`);
  const origin = tryRead('git', ['remote', 'get-url', 'origin'], { cwd: top }).stdout;
  if (!origin) die(`no "origin" remote in ${top}. Create it: gh repo create ${OWNER}/${m.slug} --private --source . --remote origin`);
  if (new RegExp(`[/:]${OWNER}/${OWNER}(\\.git)?$`, 'i').test(origin)) die(`${top} pushes to the profile repo ${OWNER}/${OWNER}; an app needs its own repo (gh new ${m.slug})`);
  if (!new RegExp(`[/:]${OWNER}/${m.slug}(\\.git)?$`, 'i').test(origin)) warn(`origin is ${origin}, expected ${OWNER}/${m.slug}`);
  info(`repo ${top}  →  ${origin}`);
  const branch = tryRead('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: top }).stdout;
  if (!branch) die('HEAD is detached; check out a branch first. Nothing pushed.');

  run('git', ['fetch', '--quiet', '--tags', '--force', 'origin'], { cwd: top, read: true });

  // Commit everything (secrets scanned first).
  if (state.dryRun) {
    const st = read('git', ['status', '--porcelain'], { cwd: top }).stdout;
    info(st ? `would commit ${st.split('\n').length} changed path(s) as "release: v${version}"` : 'working tree clean, nothing to commit');
    run('git', ['add', '-A'], { cwd: top });
    run('git', ['commit', '-m', `release: v${version}`], { cwd: top });
  } else {
    run('git', ['add', '-A'], { cwd: top });
    const hits = secretScan(top);
    if (hits.length) {
      run('git', ['reset', '-q'], { cwd: top });
      die(`possible secrets or oversized files staged in ${top}:\n  - ${hits.join('\n  - ')}\nAdd them to .gitignore (or list a false positive in .secretscan-allow). Nothing committed or pushed.`);
    }
    if (tryRead('git', ['diff', '--cached', '--quiet'], { cwd: top }).status !== 0) {
      run('git', ['commit', '--quiet', '-m', `release: v${version}`], { cwd: top });
      ok(`committed "release: v${version}" on ${branch}`);
    } else info('working tree clean, nothing to commit');
  }

  const head = revParse(top, 'HEAD');
  const originMain = revParse(top, 'refs/remotes/origin/main');
  if (originMain && head && !isAncestor(top, originMain, head))
    die(`origin/main has commits that ${branch} does not contain. Merge or rebase them into ${branch} first. Nothing pushed.`);
  if (branch !== 'main') {
    const localMain = revParse(top, 'refs/heads/main');
    if (localMain && head && !isAncestor(top, localMain, head))
      die(`local main cannot fast-forward to ${branch} (main has commits ${branch} lacks). Merge them first. Nothing pushed.`);
    info(`fast-forwarding main to ${branch}`);
    run('git', ['update-ref', 'refs/heads/main', head || 'HEAD', ...(localMain ? [localMain] : [])], { cwd: top });
  }
  run('git', ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main'], { cwd: top });
  if (branch !== 'main' && tryRead('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: top }).status === 0)
    run('git', ['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { cwd: top, allowFail: true });

  const tag = `v${version}`;
  const localTag = revParse(top, `refs/tags/${tag}^{commit}`);
  const remoteLines = tryRead('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: top }).stdout.split('\n').filter(Boolean);
  const peeled = remoteLines.find((l) => l.endsWith('^{}')) || remoteLines[0];
  const remoteTag = peeled ? peeled.split(/\s+/)[0] : null;
  if (localTag === head && remoteTag === head) {
    ok(`tag ${tag} already on ${head?.slice(0, 7)}, pushed`);
    return { top, head };
  }
  const moving = (localTag && localTag !== head) || (remoteTag && remoteTag !== head);
  if (moving)
    warn(`version ${version} was already tagged on another commit: moving ${tag} to HEAD. Bump the version so Sparkle/brew users see an update.`);
  run('git', ['tag', '-f', '-a', tag, '-m', `${m.name} ${version}`, head || 'HEAD'], { cwd: top });
  run('git', ['push', '--quiet', ...(moving ? ['--force'] : []), 'origin', `refs/tags/${tag}`], { cwd: top });
  ok(`main and ${tag} pushed`);
  return { top, head };
}

// ---------- (e) tap release, cask, appcast ----------
function publishRelease(m, app, workDir) {
  const tag = releaseTag(m.slug, app.version);
  const asset = assetName(m.slug, app.version);
  const zip = join(workDir, asset);
  mkdirSync(workDir, { recursive: true });
  rmSync(zip, { force: true });
  // ditto keeps the code signature, symlinks (Sparkle.framework) and extended attributes intact.
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app.path, zip], { read: !state.dryRun });
  const bhash = bundleHash(app.path);
  let zipSha = state.dryRun ? '<sha256>' : sha256File(zip);
  const rel = ghJson(['release', 'view', tag, '-R', TAP_FULL, '--json', 'tagName,body,assets']);
  const marker = (sha) => `<!-- ship: bundle-sha256=${bhash} zip-sha256=${sha} -->`;
  // A release that ship did not create (Omnia 1.0.0: DMG + Windows installer) keeps its own notes;
  // only the ship marker line is added or replaced.
  const foreign = rel && rel.body && !rel.body.includes('<!-- ship:') ? rel.body.trim() : null;
  const notes = (sha) =>
    foreign
      ? `${foreign}\n\nmacOS zip (\`${asset}\`, used by the cask): the copy installed on the maintainer's Mac, build ${app.build}.\n\n${marker(sha)}`
      : rel?.body?.includes('<!-- ship:') && !rel.body.startsWith(`${m.name} ${app.version} (build`)
        ? rel.body.replace(/<!-- ship:[^>]*-->/, marker(sha))
        : `${m.name} ${app.version} (build ${app.build}) for macOS.\n\n\`\`\`sh\nbrew install --cask saasempiree/tap/${m.slug}\n\`\`\`\n\nCatalogue: ${catalogueUrl(m.slug)}\n\n${marker(sha)}`;
  const hasAsset = rel?.assets?.some((a) => a.name === asset);
  const same = rel && hasAsset && rel.body?.includes(`bundle-sha256=${bhash}`);
  if (same) {
    const prev = /zip-sha256=([0-9a-f]{64})/.exec(rel.body)?.[1];
    // Re-zipping is not byte-stable, so sign and hash exactly the asset that is online.
    run('gh', ['release', 'download', tag, '-R', TAP_FULL, '-p', asset, '-D', workDir, '--clobber'], { read: true });
    zipSha = sha256File(zip);
    if (prev && prev !== zipSha) die(`release ${tag}: online asset sha256 ${zipSha} does not match its notes (${prev})`);
    ok(`release ${tag} already holds this exact bundle, not re-uploaded`);
  } else if (rel) {
    if (hasAsset) warn(`release ${tag} holds a different build of ${app.version}: replacing it (bump the version next time)`);
    gh(['release', 'upload', tag, zip, '-R', TAP_FULL, '--clobber']);
    gh(['release', 'edit', tag, '-R', TAP_FULL, '--notes', notes(zipSha)]);
    ok(`release ${tag} updated`);
  } else {
    gh(['release', 'create', tag, zip, '-R', TAP_FULL, '--target', 'main', '--title', `${m.name} ${app.version}`, '--notes', notes(zipSha), '--latest=false']);
    ok(`release ${tag} created`);
  }
  return { tag, asset, zip, zipSha };
}

function writeCask(m, app, zipSha) {
  if (!m.platforms.includes('macos')) return null;
  const p = join(TAP_ROOT, 'Casks', `${m.slug}.rb`);
  const entry = readJson(join(TAP_ROOT, 'apps', `${m.slug}.json`), {});
  const body = renderCask({
    slug: m.slug, name: m.name, tagline: m.tagline, version: app.version, sha256: zipSha,
    appName: basename(m.artifact).normalize('NFC'), bundleId: m.bundleId, archs: app.archs, minOS: app.minOS,
    autoUpdates: m.update === 'sparkle', caskExtra: entry.caskExtra, caveats: entry.caveats,
  });
  if (state.dryRun) info(`would write Casks/${m.slug}.rb (version ${app.version})`);
  else writeFileSync(p, body);
  return relative(TAP_ROOT, p);
}

function removeItem(xml, sparkleVersion) {
  return xml.replace(/\n?[ \t]*<item>[\s\S]*?<\/item>/g, (item) =>
    item.includes(`<sparkle:version>${sparkleVersion}</sparkle:version>`) ? '' : item);
}

function writeAppcast(m, app, zip, workDir) {
  const p = join(TAP_ROOT, 'appcasts', `${m.slug}.xml`);
  const gen = join(SPARKLE_BIN, 'generate_appcast');
  if (!existsSync(gen)) die(`Sparkle's generate_appcast not found at ${gen}`);
  if (app.feedUrl && app.feedUrl !== feedUrl(m.slug) && !LEGACY_FEED_MIRROR[m.slug])
    warn(`${m.name}'s SUFeedURL is ${app.feedUrl}, not the tap feed ${feedUrl(m.slug)}: it will never see this update`);
  const archives = join(workDir, 'archives');
  const feed = join(workDir, `${m.slug}.xml`);
  const args = ['--maximum-deltas', '0', '--maximum-versions', '0', '--download-url-prefix', downloadPrefix(m.slug, app.version),
    '--link', catalogueUrl(m.slug), '-o', feed, archives];
  if (state.dryRun) {
    run(gen, args);
    info(`would write appcasts/${m.slug}.xml`);
    return relative(TAP_ROOT, p);
  }
  // Idempotence: an item for this build that already points at this exact zip (URL, length and a
  // valid EdDSA signature) is left untouched, so a re-run changes nothing (not even pubDate).
  if (existsSync(p)) {
    const cur = readFileSync(p, 'utf8');
    const item = (cur.match(/<item>[\s\S]*?<\/item>/g) || []).find((i) => i.includes(`<sparkle:version>${app.build}</sparkle:version>`));
    const url = `${downloadPrefix(m.slug, app.version)}${basename(zip)}`;
    const sig = item && /sparkle:edSignature="([^"]+)"/.exec(item)?.[1];
    const len = item && /length="(\d+)"/.exec(item)?.[1];
    if (item && item.includes(`url="${url}"`) && sig && Number(len) === statSync(zip).size &&
        tryRead(join(SPARKLE_BIN, 'sign_update'), ['--verify', zip, sig]).status === 0) {
      ok(`appcasts/${m.slug}.xml already has ${m.name} ${app.version} (build ${app.build}), signature verified`);
      return relative(TAP_ROOT, p);
    }
  }
  rmSync(archives, { recursive: true, force: true });
  mkdirSync(archives, { recursive: true });
  copyFileSync(zip, join(archives, basename(zip)));
  // Keep every older item; drop only a previous item of this exact build so it is re-signed.
  if (existsSync(p)) writeFileSync(feed, removeItem(readFileSync(p, 'utf8'), app.build));
  else rmSync(feed, { force: true });
  run(gen, args); // signs with the EdDSA key from the login keychain; the key never leaves it
  const xml = readFileSync(feed, 'utf8');
  if (!xml.includes(`<sparkle:version>${app.build}</sparkle:version>`) || !xml.includes(`${downloadPrefix(m.slug, app.version)}${basename(zip)}`))
    die(`generate_appcast did not add ${m.name} ${app.version} (build ${app.build}) to the feed. Did CFBundleVersion increase?`);
  if (!/sparkle:edSignature="[^"]+"/.test(xml.split('<item>')[1] || '')) die('the new appcast item is not EdDSA-signed');
  writeFileSync(p, xml);
  ok(`appcasts/${m.slug}.xml → ${m.name} ${app.version} (build ${app.build})`);
  return relative(TAP_ROOT, p);
}

// Old builds read the profile repo's feed. Mirror through the API: never touches the local profile checkout.
function mirrorLegacyFeed(m) {
  const path = LEGACY_FEED_MIRROR[m.slug];
  if (!path) return;
  const local = join(TAP_ROOT, 'appcasts', `${m.slug}.xml`);
  if (state.dryRun) return info(`would mirror appcasts/${m.slug}.xml to ${LEGACY_FEED_REPO}:${path}`);
  const content = readFileSync(local, 'utf8');
  const cur = ghJson(['api', `repos/${LEGACY_FEED_REPO}/contents/${path}?ref=main`]);
  if (cur && Buffer.from(cur.content || '', 'base64').toString('utf8') === content) return ok(`legacy feed ${LEGACY_FEED_REPO}/${path} already identical`);
  const body = JSON.stringify({
    message: `appcasts: mirror ${m.slug} feed from ${TAP_FULL}`,
    content: Buffer.from(content).toString('base64'),
    branch: 'main',
    ...(cur?.sha ? { sha: cur.sha } : {}),
  });
  run('gh', ['api', '-X', 'PUT', `repos/${LEGACY_FEED_REPO}/contents/${path}`, '--input', '-', '--silent'], { input: body });
  ok(`legacy feed mirrored to ${LEGACY_FEED_REPO}/${path}`);
}

function writeCatalogueEntry(root, m, app) {
  const p = join(TAP_ROOT, 'apps', `${m.slug}.json`);
  const prev = readJson(p, {});
  const next = {
    ...prev,
    name: m.name, slug: m.slug, tagline: m.tagline || prev.tagline, platforms: m.platforms, stack: m.stack || prev.stack,
    update: m.update, bundleId: m.bundleId, appName: basename(m.artifact),
    release: {
      version: app.version, build: app.build, minOS: app.minOS, archs: app.archs,
      date: prev.release?.version === app.version && prev.release?.build === app.build ? prev.release.date : new Date().toISOString().slice(0, 10),
    },
  };
  const files = [relative(TAP_ROOT, p)];
  if (state.dryRun) {
    info(`would refresh apps/${m.slug}.json and README.md`);
    return files;
  }
  writeJson(p, next);
  const icon = join(root, 'docs', 'icon.png');
  const tapIcon = join(TAP_ROOT, 'icons', `${m.slug}.png`);
  if (existsSync(icon) && (!existsSync(tapIcon) || sha256File(icon) !== sha256File(tapIcon))) {
    copyFileSync(icon, tapIcon);
    files.push(relative(TAP_ROOT, tapIcon));
  }
  writeReadme(TAP_ROOT);
  files.push('README.md');
  return files;
}

// ---------- (f) tap commit + push ----------
function pushTap(files, message) {
  const g = (args, o = {}) => run('git', args, { cwd: TAP_ROOT, ...o });
  g(['add', '--', ...files]);
  if (!state.dryRun && tryRead('git', ['diff', '--cached', '--quiet'], { cwd: TAP_ROOT }).status === 0) {
    ok('tap already up to date, nothing to commit');
  } else {
    g(['commit', '--quiet', '-m', message, '--', ...files]);
  }
  for (let i = 0; i < 3; i++) {
    const r = g(['push', '--quiet', 'origin', 'HEAD:main'], { allowFail: true });
    if (r.status === 0) return ok(`tap pushed (${TAP_FULL})`);
    warn('tap push rejected, rebasing on origin/main');
    g(['pull', '--quiet', '--rebase', '--autostash', 'origin', 'main']);
  }
  die('could not push the tap after 3 attempts');
}

function remember(root, m, app) {
  if (state.dryRun) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const reg = readJson(REGISTRY, {});
  reg[m.slug] = { name: m.name, repo: root, bundleId: m.bundleId, artifact: m.artifact, update: m.update, installedPath: app.path.startsWith(root) ? null : app.path, lastVersion: app.version, lastBuild: app.build, lastShip: new Date().toISOString() };
  writeJson(REGISTRY, reg);
}

// ---------- main ----------
function main() {
  const opt = parseArgs(process.argv.slice(2));
  state.dryRun = opt.dryRun;
  const tool = opt.fromInstalled ? 'sync-after-install --from-installed' : opt.syncOnly ? 'sync-after-install' : 'ship';
  if (opt.syncOnly && !opt.fromInstalled && process.env.SAASEMPIRE_SHIP === '1') {
    console.log('sync-after-install: called from inside `ship`, which syncs right after the install. Skipping.');
    return;
  }
  const root = findRepoRoot(opt.path);
  const m = loadManifest(root);
  console.log(bold(`${tool}: ${m.name} (${m.slug})  ${state.dryRun ? '[DRY RUN, nothing is changed]' : ''}`));

  const comete = isComete(m);
  if (comete && !opt.allowComete) die(`${m.name} hosts the agent sessions: refusing. Re-run with --allow-comete (the install step is skipped even then).`);
  if (OWN_PIPELINE.includes(m.slug) || m.update === 'own') die(`${m.name} has its own release pipeline (pushing its main = production). ${tool} does not handle it.`);
  if (read('gh', ['auth', 'status']).status !== 0) die('gh is not logged in');
  if (!existsSync(join(TAP_ROOT, '.git'))) die(`tap clone not found at ${TAP_ROOT}`);

  let installRan = false;
  if (!opt.syncOnly) {
    step('a', `build: ${m.build || '(none)'}`);
    if (!m.build) die('app.json has no "build" command');
    run('/bin/bash', ['-c', m.build], { cwd: root, inherit: true });
    step('b', `install: ${m.install || '(none declared)'}`);
    if (m.install && comete) warn('Comète: install skipped (never quit or relaunch Comète from a tool)');
    else if (m.install) {
      run('/bin/bash', ['-c', m.install], { cwd: root, inherit: true, env: { SAASEMPIRE_SHIP: '1' } });
      installRan = !state.dryRun;
    }
  }

  step('c', 'read the version from the .app');
  const appPath = pickApp(root, m, opt, installRan || (state.dryRun && !!m.install));
  if (!existsSync(appPath)) {
    if (state.dryRun) {
      warn(`${appPath} does not exist yet (it would after the build); stopping the dry run here`);
      return;
    }
    die(`${appPath} not found. Did the build produce "${m.artifact}"?`);
  }
  const app = appInfo(appPath);
  if (app.bundleId !== m.bundleId) die(`${appPath} has bundle id ${app.bundleId}, app.json says ${m.bundleId}`);
  if (!app.version) die(`${appPath} has no CFBundleShortVersionString`);
  info(`${appPath}`);
  ok(`${m.name} ${app.version} (build ${app.build}) · ${app.archs.join('+') || '?'} · macOS ${app.minOS || '?'}+`);
  const built = resolve(root, m.artifact);
  if (appPath !== built && existsSync(built)) {
    const b = appInfo(built);
    if (b.version !== app.version || b.build !== app.build) warn(`build artifact is ${b.version} (${b.build}) but the installed copy is ${app.version} (${app.build}); publishing the installed one`);
  }

  step('d', `app repo: commit, main, tag v${app.version}`);
  syncRepo(root, m, app.version);

  withLock(join(STATE_DIR, 'tap.lock'), () => {
    step('e', `tap release ${releaseTag(m.slug, app.version)}, cask${m.update === 'sparkle' ? ', appcast' : ''}`);
    run('git', ['pull', '--quiet', '--rebase', '--autostash', 'origin', 'main'], { cwd: TAP_ROOT });
    const workDir = join(CACHE, m.slug, app.version);
    const { zip, zipSha } = publishRelease(m, app, workDir);
    const files = [];
    const cask = writeCask(m, app, zipSha);
    if (cask) files.push(cask);
    if (m.update === 'sparkle') {
      files.push(writeAppcast(m, app, zip, workDir));
      mirrorLegacyFeed(m);
    }
    files.push(...writeCatalogueEntry(root, m, app));

    step('f', 'commit and push the tap');
    pushTap(files, `${m.slug} ${app.version}`);
  });
  remember(root, m, app);
  console.log(`\n${bold(`✓ ${m.name} ${app.version} is on GitHub.`)}  ${catalogueUrl(m.slug)}`);
}

try {
  main();
} catch (e) {
  if (e instanceof Stop) process.exit(1);
  throw e;
}
