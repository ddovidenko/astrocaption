/** True on a touch-first device, where hover does not exist and a tap has to do its job. */
export function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}
