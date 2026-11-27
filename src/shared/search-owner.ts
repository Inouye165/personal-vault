/**
 * Monotonic search owner generation allocator shared across search surfaces
 * ('unified', 'photos-tab', 'documents-tab').
 *
 * Kept at module scope so component unmount/remount never resets owner generations
 * back to previously retired values.
 */

let nextSearchOwnerGen = 1

export function allocateSearchOwnerGen(): number {
  const gen = nextSearchOwnerGen
  nextSearchOwnerGen += 1
  return gen
}
