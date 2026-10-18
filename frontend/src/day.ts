/** The UTC day of an ISO stamp as the cards show it ("22 Sep 2026"): the gallery's and the
 *  Images page's From/To filters select on UTC days (SPEC § 5.5), so the day a card names is the
 *  day that finds it. Fixed English, as all the page's copy is; not `toLocaleDateString`, whose
 *  month names vary by ICU build ("Sept"). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
