import type { NavigationTab } from '../../shared/validation/ipc-schemas'

export interface ViewDefinition {
  readonly id: NavigationTab
  readonly label: string
}

export const VIEWS: readonly ViewDefinition[] = [
  { id: 'all', label: 'All Items' },
  { id: 'photos', label: 'Photos' },
  { id: 'documents', label: 'Documents' },
  { id: 'review', label: 'Review' },
  { id: 'duplicates', label: 'Duplicates' }
]

export function viewLabel(id: NavigationTab): string {
  return VIEWS.find((view) => view.id === id)?.label ?? id
}
