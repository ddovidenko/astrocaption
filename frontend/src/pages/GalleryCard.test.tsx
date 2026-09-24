// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GalleryCard from './GalleryCard'

const item = {
  id: 'img-1',
  title: 'Orion',
  width: 3000,
  height: 2000,
  exported_at: '2026-09-22T10:05:00Z',
  thumb_url: '/api/gallery/img-1/files/thumb',
  preview_url: '/api/gallery/img-1/files/preview',
  annotated_preview_url: '/api/gallery/img-1/files/annotated-preview?v=x',
  export_url: '/api/gallery/img-1/files/export?v=x',
}

function coarse(is: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: is && q === '(pointer: coarse)',
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

afterEach(cleanup)

const overlay = () => screen.getByAltText('Orion, annotated') as HTMLImageElement
const revealed = () => overlay().classList.contains('revealed')

describe('GalleryCard', () => {
  it('reveals the annotated preview while hovered with a mouse', () => {
    coarse(false)
    render(
      <MemoryRouter>
        <GalleryCard item={item} plain={item.thumb_url} annotated={item.annotated_preview_url} to="/gallery/img-1" />
      </MemoryRouter>,
    )
    expect(revealed()).toBe(false)
    fireEvent.pointerEnter(screen.getByRole('link'), { pointerType: 'mouse' })
    expect(revealed()).toBe(true)
    fireEvent.pointerLeave(screen.getByRole('link'), { pointerType: 'mouse' })
    expect(revealed()).toBe(false)
  })

  it('on a touch screen the first tap reveals and the second follows the link', () => {
    // react-router's Link always calls preventDefault() itself to do client-side navigation
    // (confirmed against a bare <Link> with no custom onClick), so fireEvent.click's return
    // value can't distinguish "we blocked it" from "Link handled it internally" — whether the
    // second tap actually navigated is asserted via the rendered route instead.
    coarse(true)
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <GalleryCard item={item} plain={item.thumb_url} annotated={item.annotated_preview_url} to="/gallery/img-1" />
            }
          />
          <Route path="/gallery/img-1" element={<div>Landed</div>} />
        </Routes>
      </MemoryRouter>,
    )
    const link = screen.getByRole('link')
    const first = fireEvent.click(link)
    expect(first).toBe(false) // default prevented: no navigation yet
    expect(revealed()).toBe(true)
    expect(screen.queryByText('Landed')).toBeNull()
    fireEvent.click(link)
    expect(screen.getByText('Landed')).toBeTruthy()
  })

  it('without a link, a tap toggles the overlay', () => {
    coarse(true)
    render(<GalleryCard item={item} plain={item.preview_url} annotated={item.annotated_preview_url} />)
    const figure = screen.getByRole('figure')
    fireEvent.click(figure)
    expect(revealed()).toBe(true)
    fireEvent.click(figure)
    expect(revealed()).toBe(false)
  })
})
