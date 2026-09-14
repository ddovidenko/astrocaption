/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// The dev proxy's target. The e2e dev-proxy project points it at the app under test; a
// developer's `make dev` keeps the default (the uvicorn the Makefile starts on :8000).
const apiTarget = process.env.ASTROCAPTION_API_URL ?? 'http://localhost:8000'

// The production build lands in backend/static so one container serves API and UI.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/fonts': apiTarget,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
