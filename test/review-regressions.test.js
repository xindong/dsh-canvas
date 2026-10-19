import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasService } from '../lib/index.js'

function fixture() {
  const service = Object.create(CanvasService.prototype)
  let document = { schemaVersion: 1, revision: 0, nodes: [], assets: [] }
  const tools = new Map()
  service.queues = new Map()
  service.load = async () => document
  service.persist = async (_id, next) => { document = structuredClone(next) }
  service.emit = () => {}
  service.ctx = { tools: { register: tool => tools.set(tool.name, tool) } }
  service.focusRequests = new Map()
  service.registerTools()
  const write = args => tools.get('canvas_write').execute(
    { board_id: 'board', ...args },
    { signal: new AbortController().signal },
  )
  return { service, write, tools, getDocument: () => document }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('a canvas write cancelled while queued does not mutate the board', async () => {
  const { service, tools, getDocument } = fixture()
  const blocker = deferred()
  const started = deferred()
  const held = service.enqueue('board', async () => {
    started.resolve()
    await blocker.promise
  })
  await started.promise

  const controller = new AbortController()
  const tool = tools.get('canvas_write')
  const cancelledWrite = tool.execute({
    board_id: 'board',
    operations: [{ type: 'create', nodes: [{ id: 'cancelled', type: 'text' }] }],
  }, { signal: controller.signal })
  controller.abort()
  blocker.resolve()
  await held
  await assert.rejects(cancelledWrite, { name: 'AbortError' })
  assert.deepEqual(getDocument().nodes, [])
  assert.equal(getDocument().revision, 0)
})

test('a queued viewport request uses the document after preceding writes', async () => {
  const { service, write, tools } = fixture()
  await write({ operations: [{ type: 'create', nodes: [{ id: 'target', type: 'text', x: 0, y: 0 }] }] })
  const blocker = deferred()
  const started = deferred()
  const held = service.enqueue('board', async () => {
    started.resolve()
    await blocker.promise
  })
  await started.promise
  const moved = service.write('board', { operations: [{ type: 'update', nodes: [{ id: 'target', x: 500 }] }] })
  const focused = tools.get('canvas_write').execute({
    board_id: 'board', viewport: { action: 'center', node_ids: ['target'] },
  }, { signal: new AbortController().signal })
  blocker.resolve()
  await held
  await moved
  const result = await focused
  assert.equal(result.viewport.bounds.minX, 500)
})

test('connection endpoints are derived on read and never saved on nodes', async () => {
  const { service, write, getDocument } = fixture()
  await write({ operations: [
    { type: 'create', nodes: [{ id: 'source', type: 'text' }, { id: 'target', type: 'text' }] },
    { type: 'create_connections', connections: [{ id: 'edge', source: 'source', target: 'target' }] },
  ] })

  assert.equal(Object.hasOwn(getDocument().nodes[0], 'to'), false)
  assert.equal(Object.hasOwn(getDocument().nodes[1], 'from'), false)
  const read = await service.read('board')
  assert.deepEqual(read.nodes.find(node => node.id === 'source').to, ['target'])
  assert.deepEqual(read.nodes.find(node => node.id === 'target').from, ['source'])
  await write({ operations: [{ type: 'update', nodes: [{ ...read.nodes.find(node => node.id === 'source'), x: 10 }] }] })
  assert.equal(Object.hasOwn(getDocument().nodes[0], 'to'), false)
})

test('legacy binary path fallback does not cross colliding asset IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-binary-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = Object.create(CanvasService.prototype)
  service.root = root
  service.assetsRoot = join(root, 'assets')
  service.binaryVersions = new Map()
  const legacyFile = join(service.assetsRoot, 'board', 'a_b.original')
  await mkdir(join(service.assetsRoot, 'board'), { recursive: true })
  await writeFile(legacyFile, 'belongs-to-a_b')

  assert.equal(await service.getBinary('board', 'a/b', 'original'), null)
})

test('metadata save failure does not leave the board document partially committed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-metadata-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = Object.create(CanvasService.prototype)
  service.root = root
  service.metaRoot = join(root, 'meta')
  const original = { schemaVersion: 1, revision: 0, nodes: [], assets: [] }
  service.documents = new Map([['board', original]])
  service.getBoardMeta = async () => ({ name: 'Board' })
  service.persistBoardMeta = async () => { throw new Error('metadata save failed') }

  await assert.rejects(service.persist('board', { ...original, revision: 1 }), /metadata save failed/)
  await assert.rejects(readFile(service.pathFor('board'), 'utf8'), { code: 'ENOENT' })
  assert.deepEqual(service.documents.get('board'), original)
})
