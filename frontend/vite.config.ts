/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import process from 'node:process'

// The dev proxy's target. The e2e dev-proxy project points it at the app under test; a
// developer's `make dev` keeps the default (the uvicorn the Makefile starts on :8000). Not a
// VITE_ name on purpose: those are inlined into the client bundle.
const override = process.env.ASTROCAPTION_DEV_PROXY_TARGET?.trim()
const target = override || 'http://localhost:8000'
// Say so in the dev server's own output: a run pointed somewhere unexpected is otherwise
// indistinguishable from one that lost the proxy.
if (override) console.log(`[astrocaption] dev proxy → ${target}`)

// The production build lands in backend/static so one container serves API and UI.
export default defineConfig({
  plugins: [react()],
  // An overridden target means the e2e suite is driving this server, and it must never rewrite
  // the dep cache of the owner's own `make dev` instance (that is the 504 "Outdated Optimize
  // Dep" pitfall in CLAUDE.md). node_modules is git-ignored, so the scratch cache needs no rule.
  cacheDir: override ? 'node_modules/.vite-e2e' : undefined,
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/fonts': target,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
