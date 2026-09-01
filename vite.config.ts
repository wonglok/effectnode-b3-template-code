import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
