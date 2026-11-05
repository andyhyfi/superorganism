// Biological icons for signals, drawn to match the specimens: soft membranes, small specks.
// One stroke width (1.6) on a 20 px grid, like the lucide icons used elsewhere.
//   Feed      the membrane folds inward around a speck (a cell taking in food)
//   Draw      a bud pinches off the membrane, carrying a speck away (a cell releasing)
//   Division  a cell pinched at the waist into two, one nucleus in each half
//   Mass lent two cells joined by a strand, a speck nearly across with a fading trail

type P = { size?: number }

const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

/** Feed: the membrane folds in at the top, cupping a speck as it enters. */
export function FeedGlyph({ size = 16 }: P) {
  return svg(size, <>
    <path d="M7 4.7A7 7 0 1 0 13 4.7C12.5 8.5 7.5 8.5 7 4.7Z" />
    <circle cx="10" cy="5.1" r="1.7" fill="currentColor" stroke="none" />
  </>)
}

/** Draw: a small bud pinches off the membrane at the top right, a speck inside it. */
export function DrawGlyph({ size = 16 }: P) {
  return svg(size, <>
    <path d="M14.9 8.75A6.5 6.5 0 1 1 11.75 5.6Q12.4 5.4 12.8 4.9A2.6 2.6 0 1 1 15.3 7.2Q15 7.9 14.9 8.75Z" />
    <circle cx="15.5" cy="4.5" r="1.1" fill="currentColor" stroke="none" />
  </>)
}

/** Division: one cell pinched at the waist into two halves, a nucleus in each. */
export function DivisionGlyph({ size = 16 }: P) {
  return svg(size, <>
    <path d="M10 7.7A4.8 4.8 0 1 0 10 12.3A4.8 4.8 0 1 0 10 7.7Z" />
    <circle cx="5.5" cy="10.7" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="9.3" r="1.25" fill="currentColor" stroke="none" />
  </>)
}

/** Mass lent: two cells joined by a strand; a speck nearly across, a fading trail behind it. */
export function LendGlyph({ size = 16 }: P) {
  return svg(size, <>
    <circle cx="5" cy="14.5" r="3.6" />
    <circle cx="15" cy="5.5" r="3.6" />
    <path d="M7.7 12.1L12.3 7.9" opacity="0.55" />
    <circle cx="11.3" cy="8.8" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="9" cy="10.9" r="0.8" fill="currentColor" stroke="none" opacity="0.5" />
  </>)
}
