import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => state.db,
  getStoragePath: () => ':memory:',
}))

describe('historical zero-line workspace diff cleanup', () => {
  beforeEach(() => {
    vi.resetModules()
    state.db = new DatabaseSync(':memory:')
  })

  afterEach(() => {
    state.db?.close()
    state.db = null
  })

  it('removes historical zero-line rows and recalculates their parent cards', async () => {
    const db = state.db!
    const {
      initAllHermesTables,
      WORKSPACE_RUN_CHANGES_TABLE,
      WORKSPACE_RUN_CHANGE_FILES_TABLE,
    } = await import('../../packages/server/src/db/hermes/schemas')

    initAllHermesTables()
    const insertChange = db.prepare(`INSERT INTO "${WORKSPACE_RUN_CHANGES_TABLE}" (
      change_id, session_id, files_changed, additions, deletions, truncated, total_patch_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertFile = db.prepare(`INSERT INTO "${WORKSPACE_RUN_CHANGE_FILES_TABLE}" (
      change_id, session_id, path, additions, deletions, patch_bytes, truncated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)

    insertChange.run('zero-line-only', 'session-1', 2, 0, 0, 1, 0, 1)
    insertFile.run("zero-line-only", "session-1", ".global-cache", 0, 0, 0, 0, 1)
    insertFile.run("zero-line-only", "session-1", "binary.snapshot", 0, 0, 0, 1, 1)

    insertChange.run('mixed', 'session-1', 3, 8, 5, 1, 900, 2)
    insertFile.run("mixed", "session-1", "generated-cache.bin", 0, 0, 0, 1, 2)
    insertFile.run("mixed", "session-1", ".global-cache", 0, 0, 0, 0, 2)
    insertFile.run("mixed", "session-1", "notes.md", 2, 1, 123, 0, 2)

    initAllHermesTables()

    expect(db.prepare(`SELECT COUNT(*) AS count FROM "${WORKSPACE_RUN_CHANGE_FILES_TABLE}"
      WHERE additions = 0 AND deletions = 0`).get()).toEqual({ count: 0 })
    expect(db.prepare(`SELECT * FROM "${WORKSPACE_RUN_CHANGES_TABLE}" WHERE change_id = ?`).get('zero-line-only')).toBeUndefined()
    expect(db.prepare(`SELECT files_changed, additions, deletions, truncated, total_patch_bytes
      FROM "${WORKSPACE_RUN_CHANGES_TABLE}" WHERE change_id = ?`).get('mixed')).toEqual({
      files_changed: 1,
      additions: 2,
      deletions: 1,
      truncated: 0,
      total_patch_bytes: 123,
    })
    expect(db.prepare(`SELECT path FROM "${WORKSPACE_RUN_CHANGE_FILES_TABLE}" WHERE change_id = ?`).all('mixed')).toEqual([
      { path: 'notes.md' },
    ])

    expect(() => initAllHermesTables()).not.toThrow()
  })
})
