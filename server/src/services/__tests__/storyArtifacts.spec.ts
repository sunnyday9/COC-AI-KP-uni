import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { findStoryArtifacts, storyArtifactDirectory } from '../storyArtifacts.js'

it('discovers a legacy UUID file once and scopes indexed lookups to its owner', () => {
  const owner = 8141
  const otherOwner = 8142
  const dir = storyArtifactDirectory('index', owner)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify({ scriptId: 'shared-name.txt' }))
  expect(findStoryArtifacts('index', owner, 'shared-name.txt')).toEqual([file])

  const scan = vi.spyOn(fs, 'readdirSync')
  try {
    expect(findStoryArtifacts('index', owner, 'shared-name.txt')).toEqual([file])
    expect(findStoryArtifacts('index', otherOwner, 'shared-name.txt')).toEqual([])
    expect(scan).not.toHaveBeenCalled()
  } finally {
    scan.mockRestore()
  }
})
