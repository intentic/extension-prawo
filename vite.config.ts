import { defineConfig } from "vite";

/* The `prawo` CLI: dist/main.js, which bin/prawo imports. Bundled whole, so the installed tree needs no node_modules. */
export default defineConfig({
    build: {
        ssr: "src/main.ts",
        outDir: "dist",
        emptyOutDir: true,
        target: "node22",
        rollupOptions: { output: { entryFileNames: "main.js" } },
    },
    ssr: { noExternal: true },
});
