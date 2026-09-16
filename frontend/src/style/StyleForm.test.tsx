// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FontOut, StyleDefaults } from '../api'
import { makeDoc } from '../editor/testDoc'
import StyleForm from './StyleForm'
import { styleFormFromConfig, styleFormFromOverrides } from './styleForm'

afterEach(cleanup)

const defaults: StyleDefaults = {
  font_file: 'Inter-Regular.ttf', text_color: '#FFFFFF', marker_color: '#FFD54A', leader_color: '#FFD54A',
  halo: true, halo_color: '#000000', show_aliases: true, name_preference: 'popular', max_aliases: 2,
}
const fonts: FontOut[] = makeDoc().fonts

describe('StyleForm overrides mode (config page)', () => {
  it('offers Default entries, placeholders and the one other preference', () => {
    render(<StyleForm mode="overrides" values={styleFormFromOverrides({})} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Default (Inter-Regular.ttf)' })).toBeTruthy()
    const haloSelect = screen.getByLabelText('Halo') as HTMLSelectElement
    expect(within(haloSelect).getByRole('option', { name: 'Default (on)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /^Default \(Messier/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'NGC and IC first' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Messier, Caldwell, Sharpless, Barnard first$/ })).toBeNull()
    expect((screen.getByLabelText('Font size (px)') as HTMLInputElement).placeholder).toBe('auto')
    expect((screen.getByLabelText('Aliases shown (max)') as HTMLInputElement).placeholder).toBe('Default (2)')
  })
})

describe('StyleForm values mode (Style tab)', () => {
  const values = styleFormFromConfig(makeDoc().annotations.style)
  it('offers no Default entries, both preferences by name, required numbers', () => {
    render(<StyleForm mode="values" values={values} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.queryByRole('option', { name: /^Default/ })).toBeNull()
    expect(screen.getByRole('option', { name: 'Messier, Caldwell, Sharpless, Barnard first' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'NGC and IC first' })).toBeTruthy()
    const size = screen.getByLabelText('Font size (px)') as HTMLInputElement
    expect(size.required).toBe(true)
    expect(size.placeholder).toBe('')
  })
  it('flags an out-of-range number with a note and aria-invalid', () => {
    render(<StyleForm mode="values" values={{ ...values, halo_width: '99' }} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    const halo = screen.getByLabelText('Halo width (px)') as HTMLInputElement
    expect(halo.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Whole number between 0 and 40.')).toBeTruthy()
  })
  it('keeps the current font selectable when it is not in the list', () => {
    render(<StyleForm mode="values" values={{ ...values, font_file: 'Gone.ttf' }} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Gone.ttf (not installed)' })).toBeTruthy()
  })
  it('forwards a number flush on blur and Enter', () => {
    const onNumberFlush = vi.fn()
    render(<StyleForm mode="values" values={values} defaults={defaults} fonts={fonts} onChange={vi.fn()} onNumberFlush={onNumberFlush} />)
    const size = screen.getByLabelText('Font size (px)')
    fireEvent.blur(size)
    fireEvent.keyDown(size, { key: 'Enter' })
    expect(onNumberFlush).toHaveBeenCalledTimes(2)
    expect(onNumberFlush).toHaveBeenCalledWith('font_size')
  })
})
