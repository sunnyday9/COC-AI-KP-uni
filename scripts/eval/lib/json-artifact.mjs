import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve a server JSON artifact by the external id stored in its payload.
 * Evaluation tooling must follow the same UUID-filename rule as production.
 */
export function findJsonArtifact(rootDir, externalId, { suffix = '.json', excludeSuffixes = [] } = {}) {
  if (!fs.existsSync(rootDir)) return null
  for (const fileName of fs.readdirSync(rootDir)) {
    if (!fileName.endsWith(suffix) || excludeSuffixes.some((item) => fileName.endsWith(item))) continue
    try {
      const filePath = path.join(rootDir, fileName)
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.scriptId === externalId) return filePath
    } catch {
      // Ignore corrupt or unrelated cache entries.
    }
  }
  return null
}
