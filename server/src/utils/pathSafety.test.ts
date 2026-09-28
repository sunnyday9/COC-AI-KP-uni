import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPathInDir } from './pathSafety.js'

describe('assertPathInDir', () => {
  let rootDir: string
  let outsideDir: string

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-root-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-outside-'))
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('allows a non-existent descendant inside the root', () => {
    const candidate = path.join(rootDir, 'new', 'artifact.json')
    expect(assertPathInDir(rootDir, candidate)).toBe(candidate)
  })

  it('rejects a directory symlink that escapes the root', () => {
    fs.symlinkSync(outsideDir, path.join(rootDir, 'escape'), 'dir')

    expect(() => assertPathInDir(rootDir, path.join(rootDir, 'escape', 'secret.txt'))).toThrow(
      'path is outside the allowed directory',
    )
  })

  it('rejects a file symlink that escapes the root', () => {
    const outsideFile = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(outsideFile, 'secret')
    const link = path.join(rootDir, 'artifact.json')
    fs.symlinkSync(outsideFile, link)

    expect(() => assertPathInDir(rootDir, link)).toThrow('path is outside the allowed directory')
  })
})
