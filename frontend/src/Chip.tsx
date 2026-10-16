/** A filter chip: pressed state, never takes the focus (so the editor's canvas shortcuts stay
 *  alive while the Objects tab's chips are clicked; harmless on a list page). */
export default function Chip({
  pressed,
  onClick,
  title,
  children,
}: {
  pressed: boolean
  onClick: () => void
  title?: string
  children: string
}) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  )
}
