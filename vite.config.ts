import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // src/b3/b3-runtime is a vendored sub-package that carries its own
    // node_modules (react / @react-three/fiber / three / zustand, installed by
    // its standalone `bun install`). When Vite's dep optimizer resolves a
    // b3-runtime source file to those nested copies, its R3F Canvas ends up
    // importing a *second* React whose dispatcher the root renderer never sets
    // → "Invalid hook call / Cannot read properties of null (reading
    // 'useMemo')". Force every consumer to the single root copy of these
    // renderer-critical packages (dev + build).
    dedupe: [
      "react",
      "react-dom",
      "@react-three/fiber",
      "zustand",
      "three",
    ],
  },
  server: {
    allowedHosts: true,
    watch: {
      // The Dev page's "Select Export Folder" feature writes scene.zip into
      // public/deploy on every snapshot. Vite full-reloads when files in its
      // watched dirs change, so without this the app reloads after every
      // snapshot. public/deploy is an output target — serve it, don't watch it.
      ignored: ["**/public/deploy/**"],
    },
  },
})
