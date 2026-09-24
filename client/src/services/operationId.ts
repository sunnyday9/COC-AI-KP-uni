export function createStoryOperationId(operation: 'index' | 'dossier'): string {
  const randomPart = Math.random().toString(36).slice(2, 12)
  return `${operation}_${Date.now().toString(36)}_${randomPart}`
}
