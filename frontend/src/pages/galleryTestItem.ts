import type { GalleryItem } from '../api'

/** A published gallery item for GalleryCard/GalleryPage tests. */
export const galleryItem: GalleryItem = {
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
