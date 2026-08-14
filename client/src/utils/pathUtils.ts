/**
 * Extract a human-readable ID from a file path by taking the basename
 * and stripping known extensions.
 *
 * @param path - Full or relative file path
 * @param extensions - Regex-safe extension pattern (default: any single extension)
 */
export function pathToId(path: string, extensions = /\.[^./\\]+$/i): string {
  const name = path.split(/[/\\]/).pop() || path
  return name.replace(extensions, '') || 'unknown'
}
