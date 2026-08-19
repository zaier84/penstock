// Verifies every internal link in the built site resolves to a real page.
//
// The site is served from a project page under a `/penstock` base path, which
// makes broken internal links easy to introduce and invisible in `astro dev`:
// a hardcoded `/reference/...` works locally and 404s in production. This walks
// the built HTML instead of the sources, so it checks the paths readers
// actually get. Zero dependencies, like the library it documents.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const BASE = '/penstock';

/** Every file in the build, as site-absolute paths (`/penstock/...`). */
async function collect(dir, into = new Set(), root = dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, into, root);
    } else {
      into.add(BASE + '/' + path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return into;
}

/** A link resolves if it names a file, or a directory holding an index.html. */
function resolves(href, files) {
  const clean = href.split('#')[0].split('?')[0];
  if (clean === '') return true;
  const withoutSlash = clean.endsWith('/') ? clean.slice(0, -1) : clean;
  return (
    files.has(clean) ||
    files.has(withoutSlash) ||
    files.has(`${withoutSlash}/index.html`)
  );
}

const files = await collect(distDir);
const pages = [...files].filter((f) => f.endsWith('.html'));
const broken = [];
let checked = 0;

for (const page of pages) {
  const diskPath = path.join(distDir, page.slice(BASE.length + 1));
  const html = await readFile(diskPath, 'utf8');
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    // External, protocol-relative, and in-page links are out of scope.
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
    const absolute = href.startsWith('/')
      ? href
      : path.posix.join(path.posix.dirname(page), href);
    checked++;
    if (!resolves(absolute, files)) {
      broken.push(`${page} -> ${href}`);
    }
    // A link that forgot the base path is the failure mode this exists for.
    if (!absolute.startsWith(`${BASE}/`) && absolute !== BASE) {
      broken.push(`${page} -> ${href} (missing "${BASE}" base prefix)`);
    }
  }
}

if (broken.length > 0) {
  console.error(`${broken.length} broken link(s):`);
  for (const entry of broken) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`${checked} internal links across ${pages.length} pages all resolve.`);
