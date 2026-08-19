import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

const EMPTY_VIEWPORT = Object.freeze({ scale: 1, offset: Object.freeze({ x: 0, y: 0 }) })

export const name = 'xindong-canvas'

export class CanvasRevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`canvas revision conflict: expected ${expected}, current revision is ${actual}`)
    this.name = 'CanvasRevisionConflictError'
    this.code = 'CANVAS_REVISION_CONFLICT'
    this.expected = expected
    this.actual = actual
  }
}

export class CanvasService extends Service {
  static inject = ['tools']

  constructor(ctx, config = {}) {
    super(ctx, 'canvas')
    this.root = config.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'canvas')
    this.documents = new Map()
    this.loading = new Map()
    this.queues = new Map()
    this.listeners = new Map()
    this.registerTools()
  }

  async [Service.init]() {
    await mkdir(this.root, { recursive: true })
  }

  async snapshot(boardId) {
    return clone(await this.load(normalizeBoardId(boardId)))
  }

  async read(boardId, request = {}) {
    const id = normalizeBoardId(boardId)
    const document = await this.load(id)
    const nodeIds = request.nodeIds ? new Set(request.nodeIds.map(String)) : undefined
    const types = request.types ? new Set(request.types.map(String)) : undefined
    const bounds = request.bounds === undefined ? undefined : normalizeBounds(request.bounds)
    const limit = normalizeLimit(request.limit)
    const matches = document.nodes.filter((node) => {
      if (nodeIds && !nodeIds.has(node.id)) return false
      if (types && !types.has(node.type)) return false
      if (bounds && !intersects(node, bounds)) return false
      return true
    })
    return {
      boardId: id,
      revision: document.revision,
      nodes: clone(matches.slice(0, limit)),
      assets: clone(document.assets),
      viewport: clone(document.viewport || EMPTY_VIEWPORT),
      total: matches.length,
      truncated: matches.length > limit,
    }
  }

  async write(boardId, request) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, async () => {
      const current = await this.load(id)
      assertExpectedRevision(request?.expectedRevision, current.revision)
      if (!Array.isArray(request?.operations) || request.operations.length === 0) {
        throw new TypeError('operations must be a non-empty array')
      }
      const next = clone(current)
      const addedNodeIds = []
      const updatedNodeIds = []
      const removedNodeIds = []
      for (const operation of request.operations) {
        applyOperation(next, operation, { addedNodeIds, updatedNodeIds, removedNodeIds })
      }
      next.revision = current.revision + 1
      validateDocument(next)
      await this.persist(id, next)
      const result = {
        boardId: id,
        revision: next.revision,
        addedNodeIds: unique(addedNodeIds),
        updatedNodeIds: unique(updatedNodeIds),
        removedNodeIds: unique(removedNodeIds),
        document: clone(next),
      }
      this.emit(id, { type: 'write', ...result })
      return result
    })
  }

  async replace(boardId, request) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, async () => {
      const current = await this.load(id)
      assertExpectedRevision(request?.expectedRevision, current.revision)
      const next = normalizeDocument(request?.document)
      next.revision = current.revision + 1
      await this.persist(id, next)
      const result = { boardId: id, revision: next.revision, document: clone(next) }
      this.emit(id, { type: 'replace', ...result })
      return result
    })
  }

  subscribe(boardId, listener) {
    const id = normalizeBoardId(boardId)
    const listeners = this.listeners.get(id) || new Set()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(id)
    }
  }

  async load(boardId) {
    const cached = this.documents.get(boardId)
    if (cached) return cached
    const pending = this.loading.get(boardId)
    if (pending) return await pending
    const loading = this.loadFile(boardId).finally(() => this.loading.delete(boardId))
    this.loading.set(boardId, loading)
    return await loading
  }

  async loadFile(boardId) {
    let document
    try {
      document = normalizeDocument(JSON.parse(await readFile(this.pathFor(boardId), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      document = emptyDocument()
    }
    this.documents.set(boardId, document)
    return document
  }

  async persist(boardId, document) {
    await mkdir(this.root, { recursive: true })
    const target = this.pathFor(boardId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    this.documents.set(boardId, document)
  }

  pathFor(boardId) {
    return join(this.root, `${Buffer.from(boardId, 'utf8').toString('base64url')}.json`)
  }

  enqueue(boardId, operation) {
    const previous = this.queues.get(boardId) || Promise.resolve()
    const result = previous.then(operation, operation)
    this.queues.set(boardId, result.then(() => undefined, () => undefined))
    return result.finally(() => {
      if (this.queues.get(boardId) === result) this.queues.delete(boardId)
    })
  }

  emit(boardId, change) {
    for (const listener of this.listeners.get(boardId) || []) {
      try { listener(clone(change)) } catch (error) { this.ctx.logger.warn(error) }
    }
  }

  registerTools() {
    const textOutput = {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }
    this.ctx.tools.register(defineTool({
      name: 'canvas_read',
      description: 'Read nodes from the current session canvas by id, type, or world-space bounds.',
      parameters: {
        board_id: { type: 'string', description: 'Board id. Defaults to the current Agent session id.' },
        node_ids: { type: 'array', items: { type: 'string' }, description: 'Only return these node ids.' },
        types: { type: 'array', items: { type: 'string' }, description: 'Only return these node types.' },
        bounds: {
          type: 'object',
          additionalProperties: false,
          description: 'World-space rectangle intersecting the requested nodes.',
          properties: {
            minX: { type: 'number', required: true },
            minY: { type: 'number', required: true },
            maxX: { type: 'number', required: true },
            maxY: { type: 'number', required: true },
          },
        },
        limit: { type: 'integer', description: `Maximum nodes to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => await this.read(resolveBoardId(args.board_id, exec), {
        nodeIds: args.node_ids,
        types: args.types,
        bounds: args.bounds,
        limit: args.limit,
      }),
      presentCall: () => ({ card: 'generic', title: 'Read canvas', kind: 'read' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'canvas_write',
      description: 'Atomically create, update, or delete nodes on the current session canvas. The revision advances once per call.',
      parameters: {
        board_id: { type: 'string', description: 'Board id. Defaults to the current Agent session id.' },
        expected_revision: { type: 'integer', description: 'Optional current revision for optimistic concurrency control.' },
        operations: {
          type: 'array',
          required: true,
          description: 'Ordered create/update/delete operations committed as one transaction.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', required: true, enum: ['create', 'update', 'delete'] },
              nodes: { type: 'array', items: { type: 'json' } },
              node_ids: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      output: textOutput,
      execute: async (args, exec) => await this.write(resolveBoardId(args.board_id, exec), {
        expectedRevision: args.expected_revision,
        operations: args.operations.map(operation => ({
          type: operation.type,
          nodes: operation.nodes,
          nodeIds: operation.node_ids,
        })),
      }),
      presentCall: () => ({ card: 'generic', title: 'Update canvas', kind: 'other' }),
    }))
  }
}

function resolveBoardId(explicit, exec) {
  const sessionId = exec.agent?.session?.header?.id || exec.agent?.id
  if (explicit !== undefined) return normalizeBoardId(explicit)
  if (sessionId === undefined) throw new Error('canvas tool requires board_id when no Agent session owns the call')
  return normalizeBoardId(String(sessionId))
}

function normalizeBoardId(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('boardId must be a non-empty string')
  if (value.length > 256) throw new TypeError('boardId must be at most 256 characters')
  return value.trim()
}

function emptyDocument() {
  return { schemaVersion: 1, revision: 0, nodes: [], assets: [], viewport: clone(EMPTY_VIEWPORT) }
}

function normalizeDocument(value) {
  if (value === undefined || value === null) return emptyDocument()
  const document = {
    schemaVersion: value.schemaVersion ?? 1,
    revision: value.revision ?? 0,
    nodes: value.nodes ?? [],
    assets: value.assets ?? [],
    viewport: value.viewport ?? clone(EMPTY_VIEWPORT),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  }
  validateDocument(document)
  return clone(document)
}

function validateDocument(document) {
  if (!Number.isSafeInteger(document.schemaVersion) || document.schemaVersion < 1) throw new TypeError('schemaVersion must be a positive integer')
  if (!Number.isSafeInteger(document.revision) || document.revision < 0) throw new TypeError('revision must be a non-negative integer')
  if (!Array.isArray(document.nodes)) throw new TypeError('nodes must be an array')
  if (!Array.isArray(document.assets)) throw new TypeError('assets must be an array')
  const ids = new Set()
  for (const node of document.nodes) {
    validateNode(node)
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`)
    ids.add(node.id)
  }
  const viewport = document.viewport || EMPTY_VIEWPORT
  finite(viewport.scale, 'viewport.scale')
  if (viewport.scale <= 0) throw new TypeError('viewport.scale must be greater than zero')
  finite(viewport.offset?.x, 'viewport.offset.x')
  finite(viewport.offset?.y, 'viewport.offset.y')
  assertJson(document)
}

function validateNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError('node must be an object')
  if (typeof node.id !== 'string' || node.id.trim().length === 0) throw new TypeError('node.id must be a non-empty string')
  if (typeof node.type !== 'string' || node.type.trim().length === 0) throw new TypeError(`node ${node.id}: type must be a non-empty string`)
  if (!Number.isSafeInteger(node.typeVersion) || node.typeVersion < 1) throw new TypeError(`node ${node.id}: typeVersion must be a positive integer`)
  for (const key of ['x', 'y', 'width', 'height', 'rotation', 'zIndex']) finite(node[key], `node ${node.id}.${key}`)
  if (node.width <= 0 || node.height <= 0) throw new TypeError(`node ${node.id}: width and height must be greater than zero`)
  if (node.props === undefined) throw new TypeError(`node ${node.id}: props is required`)
  assertJson(node)
}

function applyOperation(document, operation, changed) {
  if (!operation || typeof operation !== 'object') throw new TypeError('operation must be an object')
  if (operation.type === 'create') {
    if (!Array.isArray(operation.nodes) || operation.nodes.length === 0) throw new TypeError('create operation requires nodes')
    const known = new Set(document.nodes.map(node => node.id))
    for (const raw of operation.nodes) {
      const node = normalizeCreatedNode(raw)
      if (known.has(node.id)) throw new TypeError(`node id already exists: ${node.id}`)
      known.add(node.id)
      document.nodes.push(node)
      changed.addedNodeIds.push(node.id)
    }
    return
  }
  if (operation.type === 'update') {
    if (!Array.isArray(operation.nodes) || operation.nodes.length === 0) throw new TypeError('update operation requires nodes')
    for (const raw of operation.nodes) {
      if (!raw || typeof raw.id !== 'string') throw new TypeError('updated node requires id')
      const index = document.nodes.findIndex(node => node.id === raw.id)
      if (index < 0) throw new TypeError(`cannot update missing node: ${raw.id}`)
      const patch = raw.patch ?? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'id'))
      for (const immutable of ['id', 'type', 'typeVersion']) {
        if (immutable in patch) throw new TypeError(`cannot update immutable node field: ${immutable}`)
      }
      const node = { ...document.nodes[index], ...clone(patch) }
      validateNode(node)
      document.nodes[index] = node
      changed.updatedNodeIds.push(node.id)
    }
    return
  }
  if (operation.type === 'delete') {
    if (!Array.isArray(operation.nodeIds) || operation.nodeIds.length === 0) throw new TypeError('delete operation requires node_ids')
    const ids = new Set(operation.nodeIds.map(String))
    const existing = new Set(document.nodes.map(node => node.id))
    for (const id of ids) if (!existing.has(id)) throw new TypeError(`cannot delete missing node: ${id}`)
    document.nodes = document.nodes.filter(node => !ids.has(node.id))
    changed.removedNodeIds.push(...ids)
    return
  }
  throw new TypeError(`unsupported canvas operation: ${String(operation.type)}`)
}

function normalizeCreatedNode(raw) {
  const node = {
    id: raw?.id || randomUUID(),
    type: raw?.type,
    typeVersion: raw?.typeVersion ?? 1,
    ...(raw?.name === undefined ? {} : { name: raw.name }),
    x: raw?.x ?? 0,
    y: raw?.y ?? 0,
    width: raw?.width ?? 240,
    height: raw?.height ?? 160,
    rotation: raw?.rotation ?? 0,
    zIndex: raw?.zIndex ?? 0,
    ...(raw?.locked === undefined ? {} : { locked: raw.locked }),
    ...(raw?.visible === undefined ? {} : { visible: raw.visible }),
    ...(raw?.assetRefs === undefined ? {} : { assetRefs: raw.assetRefs }),
    props: raw?.props ?? {},
  }
  validateNode(node)
  return clone(node)
}

function normalizeBounds(bounds) {
  for (const key of ['minX', 'minY', 'maxX', 'maxY']) finite(bounds?.[key], `bounds.${key}`)
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) throw new TypeError('bounds max values must not be smaller than min values')
  return bounds
}

function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TypeError(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  return limit
}

function assertExpectedRevision(expected, actual) {
  if (expected === undefined) return
  if (!Number.isSafeInteger(expected) || expected < 0) throw new TypeError('expectedRevision must be a non-negative integer')
  if (expected !== actual) throw new CanvasRevisionConflictError(expected, actual)
}

function intersects(node, bounds) {
  return node.x + node.width >= bounds.minX && node.x <= bounds.maxX && node.y + node.height >= bounds.minY && node.y <= bounds.maxY
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`)
}

function assertJson(value) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError('canvas data must be JSON serializable')
  JSON.parse(encoded)
}

function clone(value) {
  return structuredClone(value)
}

function unique(values) {
  return [...new Set(values)]
}

export default CanvasService
