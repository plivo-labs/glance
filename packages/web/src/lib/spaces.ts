import type { SpaceSummary } from './types'

/** The default upload/record destination: the user's personal space, falling back to their first
 *  space, then '' when they have none. Shared by the deploy card and the record dialog. */
export function defaultSpaceSlug(spaces: SpaceSummary[]): string {
  return spaces.find((s) => s.type === 'personal')?.slug ?? spaces[0]?.slug ?? ''
}
