// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { createStarlightTypeDocPlugin } from 'starlight-typedoc';

// One plugin instance per published entry point. A single instance covering
// both would emit a TypeDoc "modules" index page whose links point at
// per-module readme pages that are never generated — broken links in the one
// part of the site nobody hand-checks. Separate instances also let the sidebar
// use the specifiers people actually type in an import.
const [starlightCoreTypeDoc, coreSidebar] = createStarlightTypeDocPlugin();
const [starlightOtelTypeDoc, otelSidebar] = createStarlightTypeDocPlugin();

/** TypeDoc settings shared by both entry points. */
const typeDoc = {
  // The project README is the package's front door, not reference material;
  // inlining it here would duplicate the home page.
  readme: 'none',
  // Names each entry point's contents page 'index', so it is reachable at
  // /reference/penstock/ rather than the default /reference/penstock/readme/.
  entryFileName: 'index',
  excludeInternal: true,
  excludePrivate: true,
  githubPages: false,
};

// The site is served from a project page, so every path is prefixed with
// `base`. Internal links must go through Astro's helpers or Starlight's own
// link handling — never a hardcoded absolute path, which would 404 in
// production while working in `astro dev`.
export default defineConfig({
  site: 'https://zaier84.github.io',
  base: '/penstock',
  integrations: [
    starlight({
      title: 'penstock',
      description:
        'Composable, testable backend workflows for Node.js — pipelines, steps, and engines, with first-class reverse-order rollback.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/zaier84/penstock',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/zaier84/penstock/edit/main/docs/',
      },
      // Generated from source so it cannot drift from the implementation.
      // Reference pages are never hand-written.
      plugins: [
        starlightCoreTypeDoc({
          entryPoints: ['../src/index.ts'],
          tsconfig: '../tsconfig.json',
          output: 'reference/penstock',
          sidebar: { label: 'penstock', collapsed: true },
          typeDoc,
        }),
        starlightOtelTypeDoc({
          entryPoints: ['../src/otel/index.ts'],
          tsconfig: '../tsconfig.json',
          output: 'reference/otel',
          sidebar: { label: 'penstock/otel', collapsed: true },
          typeDoc,
        }),
      ],
      // Pages appear here only once they are written. A sidebar entry that
      // leads to an empty page is worse than no entry at all.
      sidebar: [
        { label: 'Home', link: '/' },
        {
          label: 'API reference',
          items: [coreSidebar, otelSidebar],
        },
      ],
    }),
  ],
});
