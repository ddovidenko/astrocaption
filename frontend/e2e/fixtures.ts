import { test as base, expect } from '@playwright/test'
import { FakeNova } from './helpers'

// The fixtures every spec runs with. Both are `auto`, so a spec gets them by importing `test`
// from here instead of from '@playwright/test' — there is nothing to remember and nothing to
// repeat.
//
//   pageErrors  every uncaught error the page threw; asserted empty when the test ends, which
//               is how the blank-page regression (#11) is caught wherever it happens.
//   fakeNova    the fake nova's control surface, reset to 'success' after EVERY test, so a spec
//               that leaves the fake misbehaving cannot change what another spec sees.
export const test = base.extend<{ pageErrors: string[]; fakeNova: FakeNova }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await use(errors)
      expect(errors, 'uncaught page errors').toEqual([])
    },
    { auto: true },
  ],
  fakeNova: [
    async ({ request }, use) => {
      const fake = new FakeNova(request)
      await use(fake)
      await fake.setMode('success')
    },
    { auto: true },
  ],
})

export { expect }
