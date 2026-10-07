import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Two pages: the dashboard at / and the fraud-detection test at /test/.
// Both call the same relative /api paths as in production; in development Vite
// forwards them (WebSockets included) to uvicorn on :8000.
export default defineConfig({
  plugins: [react()],
  build: {
    // Recharts is most of the dashboard bundle; the page needs all of it at once.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        test: resolve(import.meta.dirname, 'test/index.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', ws: true },
    },
  },
})
