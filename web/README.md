# SafePath Web — React + shadcn component workspace

This folder is a **separate React application** that hosts shadcn/ui components.
It is deliberately kept apart from the existing vanilla JS SafePath app so that
the shipped prototype is untouched.

| | Stack | Location | Served by |
|---|---|---|---|
| Existing prototype | Vanilla JS + Leaflet, no build step | `/public` | Express, port 12000 |
| **This folder** | React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui | `/web` | Vite, port 5173 |

The two are independent. Nothing in `/web` changes how `/public` behaves, and
`npm test` at the repository root is unaffected.

---

## Was the required stack already present?

No. Before this work the repository had **no React, no TypeScript, no Tailwind
CSS and no bundler** — `package.json` listed a single runtime dependency
(`express`), the frontend was hand-written JS in `/public`, and
`express.static` served it directly. The task's requirements (shadcn structure,
Tailwind, TypeScript) all had to be set up from scratch.

That is why this lives in a new `/web` folder rather than being grafted onto the
prototype: adding a React toolchain to the existing app would have meant
rewriting the working frontend or maintaining two module systems in one tree.

---

## Setup from scratch (what was run)

Only needed if you are recreating this folder. From `/web`:

```bash
# 1. Framework
npm create vite@latest . -- --template react-ts

# 2. Tailwind v4 (the Vite plugin, not the old PostCSS pipeline)
npm install tailwindcss @tailwindcss/vite
```

Tailwind v4 needs no `tailwind.config.js` and no `postcss.config.js`. It is
wired in two places: the plugin in `vite.config.ts`, and a single
`@import "tailwindcss";` line at the top of `src/index.css`.

The `@/*` import alias must exist in **both** `vite.config.ts` (for the bundler)
and `tsconfig.json` (for the editor and `tsc`). shadcn's CLI validates the alias
before it will run and refuses to initialise if it is missing.

```bash
# 3. shadcn CLI
npx shadcn@latest init -t vite -b radix -p nova -y --no-monorepo
```

Notes on flags, because the CLI's options changed in v4:

- `-b` is the **component library** (`radix` | `base` | `aria`) — *not* the base
  colour, despite what earlier docs suggest. This component uses
  `@radix-ui/react-slot`, so `radix` is correct.
- `-p` is the **preset** (`nova`, `vega`, `maia`, …). Omit it and the CLI opens
  an interactive picker that hangs in a non-interactive shell.
- `src/index.css` must exist and contain `@import "tailwindcss";` **before**
  `init` runs, or it fails validation with "No Tailwind CSS configuration found".

Finally, the two component dependencies:

```bash
npm install @radix-ui/react-slot class-variance-authority
```

`cn` (from `clsx` + `tailwind-merge`) and `lucide-react` are installed by the
shadcn init step; they are listed in `package.json` for completeness.

---

## Default paths for components and styles

shadcn's CLI records these in `components.json`:

```json
{
  "tailwind": { "css": "src/index.css", "baseColor": "neutral" },
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "utils": "@/lib/utils",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

| Kind | Default path | This project |
|---|---|---|
| UI components | `@/components/ui` | `src/components/ui` |
| Utility helpers | `@/lib/utils` | `src/lib/utils.ts` |
| Global styles + theme tokens | `src/index.css` | same |
| Non-UI components | `@/components` | `src/components` |

**The default UI path here is already `/components/ui`**, so no change was
needed — the component was placed at `src/components/ui/liquid-glass-button.tsx`,
which is what `@/components/ui/liquid-glass-button` resolves to.

### Why `/components/ui` specifically matters

It is not a style preference; the CLI depends on it.

1. **`npx shadcn add <name>` writes there.** The `ui` alias is the CLI's install
   target. If you keep UI components elsewhere, the CLI either creates a second
   copy in `components/ui` or fails to resolve internal imports, and you end up
   with duplicates that drift apart.
2. **shadcn components import each other by that path.** A generated component
   may contain `import { Button } from "@/components/ui/button"`. Put `button.tsx`
   somewhere else and the import breaks at build time.
3. **It separates primitives from application code.** `components/ui` holds
   generic, reusable, mostly-unmodified primitives. `components/` holds your own
   composed screens. Mixing them makes "can I regenerate this file?" impossible
   to answer — regenerating would overwrite your customisations.
4. **The `cn` helper is expected at `@/lib/utils`.** Every generated component
   imports it from there. Moving it means editing every vendored file.

If you *do* want a different location, change the `ui` alias in `components.json`
rather than moving files, so the CLI keeps writing to the right place.

---

## Running it

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with HMR, proxies `/api` to the Express backend |
| `npm run build` | Typecheck (`tsc -b`) then production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | Types only, no emit |

`vite.config.ts` proxies `/api` to `http://localhost:12000` (override with
`SAFEPATH_API_URL`), so the SPA can call the existing SafePath API without
changing CORS on the Express server.

---

## The component

`src/components/ui/liquid-glass-button.tsx` exports four things:

| Export | What it is |
|---|---|
| `LiquidButton` | Frosted-glass button using an SVG turbulence filter |
| `liquidbuttonVariants` | Its `cva` variants (sizes `sm`…`xxl`, `icon`) |
| `MetalButton` | Metallic multi-layer button, 6 colour variants |
| `Button`, `buttonVariants` | A conventional shadcn button included upstream |

### Two defects fixed on vendoring

The design, class names, variants and DOM structure are unchanged. Two real
problems were fixed:

1. **Duplicate SVG filter ids.** `GlassFilter` hard-coded `id="container-glass"`
   and rendered one copy *per button*, so three buttons produced three elements
   with the same id — invalid HTML — and `url("#container-glass")` always
   resolved to the first. The glass effect was therefore undefined for every
   button after the first. Verified in the browser: the original renders
   `["container-glass","container-glass","container-glass"]`; the fix renders
   three unique ids, each referenced by its own button.
2. **Missing Safari prefix.** `backdrop-filter` was set without
   `-webkit-backdrop-filter`, so the glass layer rendered as a plain box on
   Safari and iOS.

One upstream oddity was **checked and left alone**: the file's
`export { Button, buttonVariants, liquidbuttonVariants, LiquidButton }` sits
above the `const` declarations it exports. This looks like a temporal-dead-zone
crash, but export bindings are hoisted and read lazily, so it is legal. It was
verified not to throw in both a plain ESM reproduction and the built bundle, so
changing it would have been churn.

### Props

`LiquidButton` and `Button` extend `React.ComponentProps<"button">`, so any
native button attribute works. Additional props:

- `variant`: `default | destructive | outline | secondary | ghost | link`
- `size`: `sm | default | lg | xl | xxl | icon` (defaults to `xxl`)
- `asChild`: render as the child element instead of a `<button>` (uses
  `@radix-ui/react-slot`) — use this to wrap a `<Link>`

`MetalButton` takes `variant`: `default | primary | success | error | gold | bronze`.

### No context providers required

The component needs no provider, no theme context and no data fetching. It is
self-contained: `useId` for the filter, `useState`/`useEffect` for press and
hover state. There is nothing to install or wrap.

### Assets

None. The glass distortion is generated at runtime by an inline SVG
`feTurbulence` filter, and icons come from `lucide-react`. No image files and no
Unsplash stock images are needed — adding any would be decoration the component
does not use.

### Accessibility and responsiveness

- It renders a real `<button>`, so it is keyboard-focusable and Enter/Space work.
- Pass `aria-label` when the label is only an icon; the demo does this via
  `aria-hidden="true"` on decorative icons.
- The demo container is responsive (the upstream snippet was a fixed
  `w-[800px]`, which overflowed small screens). Verified no horizontal overflow
  at 320 px.

### Where to use it in SafePath

It suits high-emphasis, low-frequency actions: the panic/SOS button, "Start
navigation", or the primary submit on the Report page. It is a poor fit for
dense lists or repeated row actions — the filter and layered shadows are
expensive to paint many times over.

---

## Demo

`src/components/demo.tsx` renders one `LiquidButton` in a centred container, two
sized variants with `lucide-react` icons, and all six `MetalButton` colours.
`src/main.tsx` mounts it inside `<div className="dark">` because the glass effect
only reads correctly against a dark surface.
