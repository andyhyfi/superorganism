// Cell looks: Osmos-style species. Each species is a palette and a texture style; the painter
// bakes one body texture per species on first use. PLACEHOLDER assignment: species follow the
// lineage today; later, mutations will decide a cell's species.
//
//  interior  dark and light tones of the mottled body
//  core      the bright knot at the center
//  rim       the glowing membrane color (also the halo)
//  speck     color of other players' deposit specks inside the cell
//  fil       0..1, how much the body shows radial filaments versus soft mottling

export type Species = {
  name: string
  dark: string
  light: string
  core: string
  rim: string
  speck: string
  fil: number
  coreSize: number
}

export const SPECIES: Species[] = [
  { name: 'abyss', dark: '#170d4a', light: '#4c3cc4', core: '#d8b8ff', rim: '#6ad8f4', speck: '#f0f4ff', fil: 0.75, coreSize: 0.1 },
  { name: 'ember', dark: '#3e1216', light: '#cc4a1e', core: '#f0b84a', rim: '#b048d0', speck: '#ffe8a8', fil: 0.35, coreSize: 0.14 },
  { name: 'verdant', dark: '#0d3a1a', light: '#38ac46', core: '#e8f080', rim: '#96ec5a', speck: '#f4ffd0', fil: 0.9, coreSize: 0.09 },
  { name: 'tide', dark: '#06303a', light: '#20a0aa', core: '#b8f4e0', rim: '#70ecd8', speck: '#e0fff8', fil: 0.55, coreSize: 0.1 },
  { name: 'coral', dark: '#3a0c26', light: '#c83a6c', core: '#f8c890', rim: '#f0a058', speck: '#ffe8d8', fil: 0.4, coreSize: 0.12 },
  { name: 'amber', dark: '#3a1e04', light: '#d4821c', core: '#f8e090', rim: '#f0d058', speck: '#fff4d0', fil: 0.6, coreSize: 0.12 },
  { name: 'orchid', dark: '#260a40', light: '#8434c0', core: '#f0b8e8', rim: '#ec64c8', speck: '#ffe0f4', fil: 0.5, coreSize: 0.11 },
  { name: 'frost', dark: '#1a2a4a', light: '#84b0f0', core: '#e8f4ff', rim: '#c8e4ff', speck: '#ffffff', fil: 0.65, coreSize: 0.12 },
]

export const hex = (c: string) => parseInt(c.slice(1), 16)

/** Species for a cell from its lineage: half the children keep the parent's look, half shift. */
export function speciesOf(_path: number[]): number {
  // A split keeps the parent's color: every child inherits its species. Color changes will come
  // from mutations later. Placeholder: every lineage starts from the root's species.
  return 0
}
