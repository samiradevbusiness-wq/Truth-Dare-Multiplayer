import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createFriendIdAllocator } = require('../functions/friend-id')

function createMemoryDatabase(initialDocuments = {}) {
  const documents = new Map(Object.entries(initialDocuments))
  let transactionQueue = Promise.resolve()

  const database = {
    doc(path) {
      return { path }
    },
    collection(path) {
      return {
        path,
        isCollection: true,
        where(field, operator, value) {
          return { path, isCollection: true, isQuery: true, field, operator, value }
        },
      }
    },
    async runTransaction(operation) {
      let release
      const previous = transactionQueue
      transactionQueue = new Promise((resolve) => { release = resolve })
      await previous

      const writes = []
      const transaction = {
        async get(reference) {
          if (reference.isCollection) {
            const prefix = `${reference.path}/`
            const docs = [...documents.entries()]
              .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
              .filter(([, data]) => !reference.isQuery || (
                reference.operator === '==' && data[reference.field] === reference.value
              ))
              .map(([path, data]) => createSnapshot(path, data))
            return { docs, empty: docs.length === 0 }
          }
          return createSnapshot(reference.path, documents.get(reference.path))
        },
        set(reference, data, options = {}) {
          writes.push({ path: reference.path, data, merge: options.merge })
        },
      }

      try {
        const result = await operation(transaction)
        for (const write of writes) {
          const current = documents.get(write.path)
          documents.set(write.path, write.merge && current ? { ...current, ...write.data } : write.data)
        }
        return result
      } finally {
        release()
      }
    },
  }

  return { database, documents }
}

function createSnapshot(path, data) {
  return {
    exists: data !== undefined,
    get(field) {
      return data?.[field]
    },
    id: path.split('/').at(-1),
  }
}

function allocatorFor(memory) {
  return createFriendIdAllocator(
    memory.database,
    { serverTimestamp: () => 'server-timestamp' },
    class HttpsError extends Error {
      constructor(code, message) {
        super(message)
        this.code = code
      }
    },
  )
}

test('allocates unique sequential Friend IDs for concurrent users', async () => {
  const memory = createMemoryDatabase()
  const allocate = allocatorFor(memory)
  const ids = await Promise.all(['uid-a', 'uid-b', 'uid-c'].map((uid) => allocate(uid)))

  assert.deepEqual(ids, ['SC-000001', 'SC-000002', 'SC-000003'])
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(memory.documents.get('systemCounters/friendIds').lastIssued, 3)
})

test('preserves an existing Friend ID and advances the counter', async () => {
  const memory = createMemoryDatabase({
    'users/legacy-user': { uid: 'legacy-user', friendId: 'SC-000007' },
  })
  const allocate = allocatorFor(memory)

  assert.equal(await allocate('legacy-user'), 'SC-000007')
  assert.equal(await allocate('new-user'), 'SC-000008')
  assert.equal(memory.documents.get('users/legacy-user').friendId, 'SC-000007')
})

test('does not reset an existing counter and uses existing profiles to initialize a missing one', async () => {
  const memory = createMemoryDatabase({
    'systemCounters/friendIds': { lastIssued: 14 },
    'users/old-user': { friendId: 'SC-000006' },
  })
  const allocate = allocatorFor(memory)
  assert.equal(await allocate('next-user'), 'SC-000015')

  const legacyMemory = createMemoryDatabase({
    'users/old-user': { friendId: 'SC-000009' },
  })
  assert.equal(await allocatorFor(legacyMemory)('next-user'), 'SC-000010')
})

test('does not collide with an existing Friend ID when the counter is behind', async () => {
  const memory = createMemoryDatabase({
    'systemCounters/friendIds': { lastIssued: 5 },
    'users/legacy-user': { friendId: 'SC-000006' },
  })
  assert.equal(await allocatorFor(memory)('next-user'), 'SC-000007')
})

test('refuses allocation after the six-digit ID range is exhausted', async () => {
  const memory = createMemoryDatabase({
    'systemCounters/friendIds': { lastIssued: 999999 },
  })
  await assert.rejects(allocatorFor(memory)('last-user'), { code: 'resource-exhausted' })
})
