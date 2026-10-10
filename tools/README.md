# tools/

The scripts that keep GitHub equal to what is installed on the maintainer's Mac. Node ≥ 18, no npm
dependencies, `gh` logged in. Every tool prints what it does; `--dry-run` changes nothing.

| Tool | What it does |
|---|---|
| `ship <app-repo>` | Full release: (a) `build` (b) `install` (c) read the version from the built/installed `.app` (d) commit everything in the app repo as `release: v<version>`, fast-forward `main`, push, tag `v<version>` (e) zip the `.app` with `ditto`, create/update the tap release `<slug>-v<version>`, regenerate `Casks/<slug>.rb`, and for Sparkle apps `appcasts/<slug>.xml` (f) commit and push the tap. |
| `sync-after-install <path>` | Steps (c) to (f) only. The last line of an app's deploy/install script. |
| `sync-after-install --from-installed <app-repo>` | Steps (c) to (f) on the copy **installed today**, as it is: no build, no install, never the repo's build output, and it stops if the app is not installed. For catching GitHub up with an app that was installed before it was wired. `ship --from-installed` is the same command. |
| `watch-installed` | The watcher: publishes every installed app whose bundle changed since its last sync, whoever installed it (deploy.sh, an agent copying a bundle by hand, `brew upgrade`). Run by launchd; `--dry-run --verbose` shows what it would do. See [The watcher](#the-watcher). |
| `install-watcher` | Builds and installs the watcher's launcher `SAASEmpire Sync.app` and its LaunchAgent `com.saasempiree.app-sync` (`install-guard` runs it too). `--probe` re-asks the ~/Documents grant, `--uninstall` removes the job. |
| `sync-after-install --source-only <app-repo>` | Commit the source and push `main` only (no tag, release or cask): what the watcher does when an installed bundle changed without a version bump. |
| `audit` | One row per app: installed version, latest repo tag, cask, appcast, repo visibility, uncommitted/unpushed work. Then every PUBLIC repo outside the allow-list. `--fix-visibility` makes them private. |
| `install-guard` | Installs the daily launchd guard (`audit --fix-visibility`), the `gh new` alias, and the watcher (`install-watcher`). |
| `lib/catalogue.mjs` | Regenerates `README.md` from `apps/*.json` and `Casks/*.rb` (`node tools/lib/catalogue.mjs`). |

## The app manifest

Each app repo has an `app.json` at its root; the version is never stored there, it is read from the
built `.app` (`CFBundleShortVersionString`, and `CFBundleVersion` for Sparkle).

```json
{
  "name": "Units", "slug": "units", "bundleId": "com.saasempiree.convertunit",
  "tagline": "One line, what it does for the user.",
  "platforms": ["macos"], "stack": "swift",
  "build": "./build.sh", "artifact": "Units.app", "install": "./deploy.sh",
  "update": "sparkle"
}
```

`update`: `sparkle` (the app updates itself from `appcasts/<slug>.xml`; the cask gets `auto_updates true`),
`brew` (`brew upgrade`), `own` (own pipeline: Kairo; `ship` refuses it).

## Wiring an app: the one line

Append this as the **last line** of the app's deploy/install script (the one that copies the `.app`
into `/Applications/My App`):

```bash
"$HOME/Documents/SAASEmpiree/homebrew-tap/tools/sync-after-install" "$0" || echo "⚠ sync-after-install failed: run ~/Documents/SAASEmpiree/homebrew-tap/tools/audit" >&2
```

It walks up from the script (`$0`) to the `app.json`, so it works from `scripts/deploy.sh` as well as
from `./deploy.sh`; if `$0` is relative and the script has `cd`'ed, it walks up from the current folder. If the sync fails (no network, secret found, branch diverged) the install still
counts and the error is loud; the daily guard and `audit` show the drift until the next sync.
When `ship` runs the install script itself, the hook notices (`SAASEMPIRE_SHIP=1`) and lets `ship` sync.

## Which `.app` is published

`--from-installed`: the installed copy, always (`/Applications/My App/<artifact>`, AppGrid's
`~/Library/Application Support/SAASEmpire/AppGrid.app`, else found by bundle id in those folders);
the tool stops if there is none. The zip is made with `ditto -c -k --keepParent`, which only reads
the bundle, so this is safe on a running app (Comète included, with `--allow-comete`).

```bash
~/Documents/SAASEmpiree/homebrew-tap/tools/sync-after-install --from-installed ~/Documents/SAASEmpiree/FrameLine --dry-run
~/Documents/SAASEmpiree/homebrew-tap/tools/sync-after-install --from-installed ~/Documents/SAASEmpiree/FrameLine
```

Otherwise `--app <path>` if given; otherwise the installed copy (`/Applications/My App/<artifact>`, or
`~/Library/Application Support/SAASEmpire/<artifact>` for AppGrid, else found by bundle id) when the
app has an `install` step; otherwise the build artifact. The bundle id must match `app.json`.

## Per-app cask extras

`apps/<slug>.json` may carry two optional fields that `ship` puts into the generated cask:
`caveats` (lines shown before the standard “self-signed” note, e.g. Omnia's optional ffmpeg) and
`caskExtra` (raw Ruby stanzas, e.g. AppGrid's `postflight` that writes and loads its launch agent and
its `uninstall launchctl:`). A release that `ship` did not create (Omnia 1.0.0: DMG + Windows
installer) keeps its notes and assets; `ship` only adds its zip and its marker line.

## Guarantees

- **Idempotent.** Same version and same bundle: nothing is committed, tagged, uploaded or pushed twice.
  Same version but a different bundle (rebuilt without a bump): the asset, the cask sha256 and the appcast
  signature are replaced and the tag `v<version>` is moved, with a warning, because the rule is that
  GitHub equals what is installed. Bump the version so users actually see an update.
- **Branches.** On a branch other than `main`, `main` is fast-forwarded to it. If that is not a
  fast-forward (or `origin/main` has commits the branch lacks) the tool stops before pushing anything.
- **Secrets.** Before committing, staged files are scanned for `.env*`, `*private_key*`, `*.p12`, `*.pem`,
  `sk-`, `ghp_`/`gho_`, `github_pat_`, JWTs (`eyJ…`), Supabase `sb_secret_`, PEM private keys, and files over
  50 MB. A hit unstages everything and stops. A known false positive can be listed (exact path) in the
  repo's `.secretscan-allow`.
- **Sparkle.** Appcasts are generated by Sparkle's `generate_appcast --maximum-deltas 0
  --maximum-versions 0` (all older items kept), signed with the EdDSA key from the login keychain.
  The key is never exported, printed or committed.
- **Removing an app:** delete its `app.json`, its cask, `apps/<slug>.json`, its icon and its `<slug>-v*` releases; `audit` and `ship` only see apps that have an `app.json`.
- **Comète** is refused unless `--allow-comete`, and even then the install step is skipped: no tool
  here ever quits or relaunches Comète. **Kairo** (`update: own`) is refused: its `main` is production.

## Legacy Sparkle feeds (Flow, Units)

Builds of Flow ≤ 0.2.0 and Units ≤ 0.1.0 read their feed from the profile repo
(`raw.githubusercontent.com/SAASEmpiree/SAASEmpiree/main/appcasts/<slug>.xml`). Their sources now point
`SUFeedURL` at this tap, and `ship` mirrors each new `flow`/`units` appcast to the profile repo through
the GitHub API (`LEGACY_FEED_MIRROR` in `lib/config.mjs`), so an old build finds the update that moves
it to the tap feed. Drop a slug from that list once no old build is left.

`vendor/Sparkle/release.sh` in the profile folder is the previous, never-published pipeline
(`flow-releases`/`units-releases` on the profile repo); do not use it.

## The watcher

The install hook only runs when an install goes through a script that calls it. The watcher closes the
gap: **any app that has an `app.json` and a repo is published as soon as its installed bundle changes**,
with nobody asking. A new app is picked up automatically the moment it has both.

**Trigger.** LaunchAgent `com.saasempiree.app-sync` (`~/Library/LaunchAgents/com.saasempiree.app-sync.plist`):
`WatchPaths` on `/Applications/My App` and `~/Library/Application Support/SAASEmpire` (AppGrid), plus
`StartInterval` 600 s (overwriting files inside an existing bundle does not always touch its parent
folder) and `RunAtLoad`; `ThrottleInterval` 30 s.

**Decision**, per installed app (bundle id → the `app.json` found under `SCAN_ROOTS`), against what the
last sync recorded in `~/Library/Application Support/SAASEmpire/ship/registry.json`:

| Installed bundle vs last sync | Action |
|---|---|
| same code-signature CDHash (deploy.sh already ran the hook) | nothing |
| new `CFBundleShortVersionString` or `CFBundleVersion`, or never synced | `sync-after-install --from-installed` (commit, `main`, tag, release, cask, appcast) |
| same version and build, different bundle | `sync-after-install --source-only` (commit + push `main`; the tag already exists) |

Kairo (`update: own`) is skipped. Comète is only ever handled this way, read-only (`--allow-comete`
with `--from-installed`/`--source-only`: nothing is built, quit or relaunched).

**Debounce.** A changed bundle is published only once nothing in it has changed for 30 s (mtime and
ctime: `ditto` keeps the source mtimes but not the ctimes) and `codesign --verify --deep --strict`
passes, so a half-copied or not-yet-signed bundle is never published. One that stays unverifiable for
2 min is reported as broken.

**One lock.** `ship`, `sync-after-install` and the watcher share `ship/sync.lock` (whole run, build
included). The watcher never waits on it: if a sync is running it leaves the work to its next run, which
usually finds that the install hook already did it. The `ship` it spawns inherits its lock
(`SAASEMPIRE_LOCK_OWNER`).

**Never silent.** Every failure (branch not fast-forwardable, secret found, push refused, no access)
posts a macOS notification (again at most every 6 h for the same failure; a failed bundle is retried
every 30 min), goes to `~/Library/Logs/SAASEmpire/app-sync.log`, and shows in `audit`'s **Watcher**
column (last result per app) and Status.

**~/Documents access (TCC).** launchd jobs cannot read `~/Documents` on their own. The job's program is
`~/Library/Application Support/SAASEmpire/SAASEmpire Sync.app` (`com.saasempiree.sync`, built from
`tools/sync-app/` and signed with `SAASEmpire Local Signing`, so the grant survives rebuilds). It checks
the access, then spawns node/git/gh as children, which inherit its grant. The grant is given once: allow
the "SAASEmpire Sync would like to access files in your Documents folder" prompt
(`install-watcher --probe` shows it again), or add the app in System Settings › Privacy & Security ›
Full Disk Access. Without it the launcher notifies (every 6 h) and syncs nothing. git pushes with the
`osxkeychain` helper and `generate_appcast` signs with the login-keychain key; both work from launchd
while the session is logged in.

## The guard

`install-guard` copies `lib/` to `~/Library/Application Support/SAASEmpire/github-guard/` (launchd jobs
cannot read `~/Documents`) and loads `~/Library/LaunchAgents/com.saasempiree.github-guard.plist`: every
day at 10:00 it runs `audit --fix-visibility --remote-only` and appends to
`~/Library/Logs/SAASEmpire/github-guard.log`. GitHub has no "private by default" setting for personal
accounts; this is the guard. Allow-list: `SAASEmpiree`, `homebrew-tap`, `kairo-site`
(`PUBLIC_ALLOWLIST` in `lib/config.mjs`). Re-run `install-guard` after editing `lib/`.

New repos: `gh new <name>` = `gh repo create SAASEmpiree/<name> --private --clone`.
