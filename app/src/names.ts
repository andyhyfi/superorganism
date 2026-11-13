// A cell's name, in one place. Every cell starts unnamed: <unnamed_001>, <unnamed_002>, ...
// The number is the cell's id in the contract, so a name never changes or repeats. A later
// mutation will let a cell be named; its name will come from here and override the default.
const named = new Map<number, string>()

export function nameOf(id: number): string {
  return named.get(id) ?? `<unnamed_${String(id).padStart(3, '0')}>`
}

/** Replace every name at once (demo server: names come with the colony). */
export function setNames(m: Map<number, string>) {
  named.clear()
  for (const [k, v] of m) named.set(k, v)
}

/** For the naming mutation, later. */
export function setName(id: number, name: string) {
  named.set(id, name)
}
