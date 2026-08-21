# Untitled UI React 8.0 PRO kit (vendored)

Source: Untitled UI PRO license (Max's account), pulled via the `untitledui` CLI
on 21 Aug 2026 from the `untitledui-vite-starter-kit` (full selection: all
application components + base + selected foundations). 293 .tsx / 16 .ts / 4 css
files, TypeScript, Tailwind v4, react-aria-components.

This directory is a faithful copy of the kit's `src/` (minus `main.tsx`) and is
NOT yet wired into the client build. Files are kept as-is on purpose — restyle
work happens on top, not by editing kit internals.

Contents:

- `components/` — application (31 groups), base (21 groups), foundations,
  marketing, shared-assets
- `hooks/`, `providers/`, `utils/`, `types/` — kit support code the components
  import
- `styles/` — Tailwind v4 `@theme` css (globals/theme/typography); the copper
  dark remap replaces `theme.css` values during restyle step 1
- `pages/` — kit demo pages, reference only
- `kit-package.json` — the kit's original manifest (renamed so tooling ignores
  it); authoritative for dependency versions to add to the ROOT package.json
- `KIT-CLAUDE.md` — the kit's component usage guide (renamed so it is not
  auto-loaded as repo instructions)

Integration requirements (restyle step 1, see monday Platform group):

1. Root manifest gains: react-aria-components, react-aria, @react-aria/utils,
   @internationalized/date, motion, tailwind-merge, @untitledui/icons,
   tailwindcss v4 + @tailwindcss/vite (remove v3 + postcss config).
   recharts/tiptap only if those component groups get used.
2. Client vite.config.js gains alias `"@" -> apps/web/client/src/uui` — kit
   files import each other via `@/...` and stay unmodified.
3. Tailwind v3 -> v4 migration of the client (official upgrade path); brand
   ramp lands as v4 `@theme` variables.

Vite compiles .tsx alongside the client's .jsx without extra config. Unimported
files cost nothing in the bundle; nothing here affects the current build until
the alias + deps land.
