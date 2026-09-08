import { describe, expect, it } from 'vitest'
import {
  ApiError,
  arcsecPerPixel,
  errorMessage,
  formatBytes,
  isBusy,
  
  isSessionLossError,
  pageError,
  parseBody,
  statusLabel,
} from './api'

describe('api helpers', () => {
  it('labels every solve status', () => {
    expect(statusLabel('pending')).toBe('Queued')
    expect(statusLabel('solving')).toBe('Solving…')
    expect(statusLabel('solved')).toBe('Solved')
    expect(statusLabel('failed')).toBe('Failed')
  })

  it('treats queued and solving as busy', () => {
    expect(isBusy('pending')).toBe(true)
    expect(isBusy('solving')).toBe(true)
    expect(isBusy('solved')).toBe(false)
    expect(isBusy('failed')).toBe(false)
  })

  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(20480)).toBe('20 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })

  it('extracts FastAPI error details', () => {
    expect(errorMessage(409, { detail: 'Image is not solved yet.' })).toBe('Image is not solved yet.')
    expect(errorMessage(500, null)).toBe('Request failed (HTTP 500)')
    // The backend's 422 handler always answers with a plain string; a list is not a shape
    // the API produces any more, so it falls through to the generic message.
    expect(errorMessage(422, { detail: [{ msg: 'bad', loc: ['body'] }] })).toBe('Request failed (HTTP 422)')
  })

  it('computes the plate scale hint', () => {
    expect(arcsecPerPixel(400, 3.76)).toBeCloseTo(1.939, 3)
    expect(arcsecPerPixel(0, 3.76)).toBeNull()
  })

  it('rejects a non-JSON success body instead of returning null', () => {
    expect(parseBody(200, true, '[{"id": "a"}]')).toEqual([{ id: 'a' }])
    expect(parseBody(200, true, '')).toBeNull()
    expect(() => parseBody(200, true, '<!doctype html><html></html>')).toThrow(ApiError)
    expect(() => parseBody(409, false, '{"detail": "busy"}')).toThrow('busy')
    expect(() => parseBody(502, false, '<html>bad gateway</html>')).toThrow('HTTP 502')
  })

  it('hides the page-level message only for a lost session', () => {
    expect(pageError(new ApiError(401, 'Sign in to continue.', true))).toBeNull()
    expect(pageError(new ApiError(401, 'Wrong password.'))).toBe('Wrong password.')
    expect(pageError(new Error('network down'))).toBe('network down')
    expect(pageError('?')).toBe('Something went wrong.')
  })

  it('identifies the ApiError a page should not show because the shell is redirecting', () => {
    // The flag is set once, by request(); the status alone cannot tell a lost session from
    // the 401 that a wrong password on /api/login earns (that call opts out).
    expect(isSessionLossError(new ApiError(401, 'Sign in to continue.', true))).toBe(true)
    expect(isSessionLossError(new ApiError(401, 'Wrong password.'))).toBe(false)
    expect(isSessionLossError(new ApiError(403, 'Forbidden.'))).toBe(false)
    expect(isSessionLossError(new Error('network down'))).toBe(false)
  })

  it('carries the session-loss decision from parseBody into the thrown error', () => {
    expect(() => parseBody(401, false, '{"detail": "Sign in to continue."}', true)).toThrow(
      'Sign in to continue.',
    )
    try {
      parseBody(401, false, '{"detail": "Sign in to continue."}', true)
    } catch (err) {
      expect(isSessionLossError(err)).toBe(true)
    }
    try {
      parseBody(401, false, '{"detail": "Wrong password."}')
    } catch (err) {
      expect(isSessionLossError(err)).toBe(false)
    }
  })
})
