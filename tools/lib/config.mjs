// Shared configuration for the tap tooling (ship, sync-after-install, audit).
// Everything that is specific to this Mac or this GitHub account lives here, nowhere else.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();

export const OWNER = 'SAASEmpiree';
export const TAP_REPO = 'homebrew-tap';
export const TAP_FULL = `${OWNER}/${TAP_REPO}`;
// The tap clone these tools live in (tools/lib/ -> repo root).
export const TAP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const TAP_URL = `https://github.com/${TAP_FULL}`;
export const RAW_TAP = `https://raw.githubusercontent.com/${TAP_FULL}/main`;
export const releaseTag = (slug, version) => `${slug}-v${version}`;
export const assetName = (slug, version) => `${slug}-${version}.zip`;
export const downloadPrefix = (slug, version) => `${TAP_URL}/releases/download/${releaseTag(slug, version)}/`;
export const feedUrl = (slug) => `${RAW_TAP}/appcasts/${slug}.xml`;
export const catalogueUrl = (slug) => `${TAP_URL}#${slug}`;

// Exactly these repos may be public. Everything else holds code and must stay private.
export const PUBLIC_ALLOWLIST = ['SAASEmpiree', 'homebrew-tap', 'kairo-site'];

// Builds already in the wild read their Sparkle feed from the profile repo
// (SUFeedURL = raw.githubusercontent.com/SAASEmpiree/SAASEmpiree/main/appcasts/<slug>.xml).
// Until every installed copy has moved to a build whose SUFeedURL is the tap, every new
// appcast of these slugs is mirrored there too. Remove a slug once no old build remains.
export const LEGACY_FEED_MIRROR = { flow: 'appcasts/flow.xml', units: 'appcasts/units.xml' };
export const LEGACY_FEED_REPO = `${OWNER}/${OWNER}`;

// Comète hosts the agent sessions; it is never built, installed, quit or relaunched by these tools.
export const isComete = (m) => /^com[eè]te/i.test(m.name || '') || /^comete/.test(m.slug || '');
// Apps with their own release pipeline (pushing their main = production).
export const OWN_PIPELINE = ['kairo'];
// Apps removed from the suite (2026-10-10): ship refuses them and audit never lists them, even if a
// local folder with an app.json is still on disk.
export const RETIRED = ['codelearn', 'jarvis', 'memora', 'pecule', 'zap'];

export const APP_DIR = '/Applications/My App';
export const SUPPORT = join(HOME, 'Library/Application Support/SAASEmpire');
export const INSTALL_DIRS = [APP_DIR, SUPPORT]; // AppGrid lives in SUPPORT
export const STATE_DIR = join(SUPPORT, 'ship');
export const REGISTRY = join(STATE_DIR, 'registry.json');
export const CACHE = join(HOME, 'Library/Caches/SAASEmpire/ship');
export const SAAS_ROOT = join(HOME, 'Documents/SAASEmpiree');
export const SPARKLE_BIN = join(SAAS_ROOT, 'vendor/Sparkle/bin');
// Where audit looks for app repos (app.json at depth 1 or 2), on top of the registry.
export const SCAN_ROOTS = [SAAS_ROOT, join(HOME, 'Documents/APP organisation')];

export const SIGN_ID = 'SAASEmpire Local Signing';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
