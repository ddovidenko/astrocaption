import { rmSync } from 'node:fs'

/** Remove the scratch data dir the config created (never one the caller supplied). */
export default function globalTeardown(): void {
  const created = process.env.E2E_DATA_DIR_CREATED
  if (created) rmSync(created, { recursive: true, force: true })
}
