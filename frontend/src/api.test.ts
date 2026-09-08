import { describe, expect, it } from 'vitest'
import {
  ApiError,
  arcsecPerPixel,
  errorMessage,
  formatBytes,
  isBusy,
  isSessionLoss,
  isSessionLossError,
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
    expect(errorMessage(422, { detail: [{ msg: 'bad', loc: ['body'] }] })).toBe('bad')
    expect(errorMessage(500, null)).toBe('Request failed (HTTP 500)')
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

  it('treats a 401 as session loss everywhere except the login call', () => {
    expect(isSessionLoss('/api/images', 401)).toBe(true)
    expect(isSessionLoss('/api/config', 401)).toBe(true)
    expect(isSessionLoss('/api/login', 401)).toBe(false)
    expect(isSessionLoss('/api/images', 403)).toBe(false)
    expect(isSessionLoss('/api/images', 200)).toBe(false)
  })

  it('identifies the ApiError a page should not show because the shell is redirecting', () => {
    expect(isSessionLossError(new ApiError(401, 'Sign in to continue.'))).toBe(true)
    expect(isSessionLossError(new ApiError(403, 'Forbidden.'))).toBe(false)
    expect(isSessionLossError(new Error('network down'))).toBe(false)
  })
})
