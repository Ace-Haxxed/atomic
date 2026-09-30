import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    // `.tsx` is included for the render-to-markup tests: they need a JSX
    // transform, not a DOM, so they still run in the node environment.
    //
    // Files named `*.dom.test.tsx` are the exception: they drive real clicks
    // and focus, so they opt into jsdom with a `@vitest-environment` docblock.
    // That opt-in is per file on purpose -- the alternative, a blanket jsdom
    // environment, would give every server-side render test a DOM it never
    // touches, and would hide the fact that those tests prove markup only.
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx"],
    environment: "node",
    // Replaces the global fetch so a test which forgets to inject a transport
    // fails locally instead of quietly calling production. See test-setup.ts.
    setupFiles: [here("./test-setup.ts")],
    // The workspace packages publish types only; Vite resolves them to source
    // and so must the tests, otherwise any component test dies on a missing
    // runtime export rather than on anything worth failing about.
    alias: {
      "@atomic/ui/styles.css": here("./packages/ui/src/styles.css"),
      "@atomic/ui": here("./packages/ui/src/index.ts"),
      "@atomic/core": here("./packages/core/src/index.ts"),
    },
  },
});
