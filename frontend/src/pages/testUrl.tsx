import { useLocation } from 'react-router'

/** Echoes the current URL search into the DOM, so a page test can see what the page wrote. */
export default function Url() {
  return <output data-testid="url">{useLocation().search}</output>
}
