/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
      '/api': 'http://localhost:8000',
      '/fonts': 'http://localhost:8000',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
