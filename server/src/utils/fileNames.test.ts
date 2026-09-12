import { describe, expect, it } from 'vitest'
import { assertStoredFilePath, generateFilePath, isInternalUuidFileName } from './fileNames.js'
import { NotFoundError } from './errors.js'

describe('generateFilePath', () => {
  it('uses the lowercased original extension when present', () => {
    expect(generateFilePath('雾中的灯塔.JSON', '.json')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/,
    )
  })

  it('falls back to the caller-declared default extension (script .json / story .txt)', () => {
    expect(generateFilePath('noext', '.json')).toMatch(/\.json$/)
    expect(generateFilePath('noext', '.txt')).toMatch(/\.txt$/)
  })

  it('generates a fresh uuid per call', () => {
    expect(generateFilePath('a.json', '.json')).not.toBe(generateFilePath('a.json', '.json'))
  })
})

describe('assertStoredFilePath (D-09 defensive whitelist, issue #76)', () => {
  it.each([
    'a',
    'abc.json',
    'ABC-123',
    '0e5d1c22-3f4a-4b5c-8d6e-7f8a9b0c1d2e.json',
  ])('accepts %s', (filePath) => {
    expect(assertStoredFilePath(filePath, 'script')).toBe(filePath)
  })

  it.each([
    '',
    '..',
    'a..b',
    'a/b',
    'a\\b',
    '.json',
    'abc.',
    'abc.中',
    'x.y.z',
    'abc json',
    '../secret.txt',
  ])('rejects %s', (filePath) => {
    expect(() => assertStoredFilePath(filePath, 'script')).toThrow(NotFoundError)
  })

  it('keeps the pre-consolidation error messages byte-for-byte', () => {
    expect(() => assertStoredFilePath('../evil', 'script')).toThrow('script file missing')
    expect(() => assertStoredFilePath('../evil', 'story')).toThrow('story file missing')
  })
})

describe('isInternalUuidFileName', () => {
  it.each([
    '0e5d1c22-3f4a-4b5c-8d6e-7f8a9b0c1d2e.json',
    '0E5D1C22-3F4A-4B5C-8D6E-7F8A9B0C1D2E.md', // case-insensitive
  ])('classifies %s as an internal uuid filename', (fileName) => {
    expect(isInternalUuidFileName(fileName)).toBe(true)
  })

  it.each([
    'legacy-story.txt', // not a uuid
    '0e5d1c22-3f4a-4b5c-8d6e-7f8a9b0c1d2e', // no extension dot
    'x-0e5d1c22-3f4a-4b5c-8d6e-7f8a9b0c1d2e.json', // prefixed, ^ anchored
  ])('classifies %s as a regular filename', (fileName) => {
    expect(isInternalUuidFileName(fileName)).toBe(false)
  })
})
