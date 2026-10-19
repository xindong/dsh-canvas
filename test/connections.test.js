import test from 'node:test'
import assert from 'node:assert/strict'
import { CanvasService } from '../lib/index.js'

function fixture() {
  const service = Object.create(CanvasService.prototype)
  let document = { schemaVersion: 1, revision: 0, nodes: [], assets: [] }
  const tools = new Map(), changes = []
  service.queues = new Map()
  service.load = async () => document
  service.persist = async (_id, next) => { document = structuredClone(next) }
  service.emit = (_id, change) => changes.push(change)
  service.ctx = { tools: { register: tool => tools.set(tool.name, tool) } }
  service.focusRequests = new Map()
  service.registerTools()
  const write = args => tools.get('canvas_write').execute({ board_id: 'board', ...args }, { signal: new AbortController().signal })
  return { service, write, changes }
}
const nodes = { type: 'create', nodes: ['a', 'b', 'c'].map(id => ({ id, type: 'text', props: { text: id } })) }
const edge = { type: 'create_connections', connections: [{ id: 'ab', source: 'a', target: 'b' }] }

test('Agent creates nodes and edges together, retargets, reads direction and deletes edges', async () => {
  const { service, write, changes } = fixture()
  const created = await write({ operations: [nodes, edge], viewport: { action: 'fit', target: 'all' } })
  assert.equal(created.revision, 1)
  assert.deepEqual(created.addedConnectionIds, ['ab'])
  assert.equal(changes.length, 1)
  const updated = await write({ expected_revision: 1, operations: [{ type: 'update_connections', connections: [{ id: 'ab', target: 'c' }] }] })
  assert.deepEqual(updated.updatedConnectionIds, ['ab'])
  const read = await service.read('board', { nodeIds: ['c'] })
  assert.deepEqual(read.nodes[0].from, ['a'])
  assert.deepEqual(read.connections, [{ id: 'ab', source: 'a', target: 'c' }])
  const deleted = await write({ operations: [{ type: 'delete_connections', connection_ids: ['ab'] }] })
  assert.deepEqual(deleted.removedConnectionIds, ['ab'])
  assert.deepEqual(deleted.document.metadata.connections, [])
})

test('invalid connections roll back nodes, metadata and revision, and stale writes fail', async () => {
  const { service, write, changes } = fixture()
  await write({ operations: [nodes, edge] })
  const baseline = await service.snapshot('board')
  for (const operation of [
    { type: 'create_connections', connections: [{ id: 'bad', source: 'a', target: 'missing' }] },
    { type: 'create_connections', connections: [{ source: 'a', target: 'a' }] },
    { type: 'create_connections', connections: [{ source: 'a', target: 'b' }] },
    { type: 'create_connections', connections: [{ id: 'ab', source: 'b', target: 'a' }] },
    { type: 'update_connections', connections: [{ id: 'missing', target: 'b' }] },
    { type: 'delete_connections', connection_ids: ['ab', 'missing'] },
  ]) {
    await assert.rejects(write({ operations: [{ type: 'create', nodes: [{ id: 'rollback', type: 'text' }] }, operation] }), TypeError)
    assert.deepEqual(await service.snapshot('board'), baseline)
  }
  await assert.rejects(write({ expected_revision: 0, operations: [{ type: 'delete_connections', connection_ids: ['ab'] }] }), { code: 'CANVAS_REVISION_CONFLICT' })
  assert.equal(changes.length, 1)
})

test('generated edge IDs, reverse edges, and node deletion cascade', async () => {
  const { write } = fixture()
  const created = await write({ operations: [nodes, edge, { type: 'create_connections', connections: [{ source: 'b', target: 'a' }] }] })
  assert.equal(created.addedConnectionIds.length, 2)
  const removed = await write({ operations: [{ type: 'delete', node_ids: ['a'] }] })
  assert.deepEqual(removed.removedConnectionIds, created.addedConnectionIds)
  assert.deepEqual(removed.document.metadata.connections, [])
})
