import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

const EMPTY_VIEWPORT = Object.freeze({ scale: 1, offset: Object.freeze({ x: 0, y: 0 }) })

export const name = 'xindong-canvas'
export const inject = ['tools']

export class CanvasRevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`canvas revision conflict: expected ${expected}, current revision is ${actual}`)
    this.name = 'CanvasRevisionConflictError'
    this.code = 'CANVAS_REVISION_CONFLICT'
    this.expected = expected
    this.actual = actual
  }
}

export class CanvasService {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.root = config.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'canvas')
    this.documents = new Map()
    this.loading = new Map()
    this.queues = new Map()
    this.listeners = new Map()
    this.initPromise = mkdir(this.root, { recursive: true }).catch((err) => {
      this.ctx?.logger?.warn?.(err)
    })
    this.registerTools()
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
    await this.initPromise
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
      try { listener(clone(change)) } catch (error) { this.ctx?.logger?.warn?.(error) }
    }
  }

  registerTools() {
    if (!this.ctx?.tools?.register) return
    const textOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }
    this.ctx.tools.register({
      name: 'canvas_read',
      description: 'Read nodes from the current session canvas by id, type, or world-space bounds.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'string', description: 'Board id. Defaults to the current Agent session id.' },
          node_ids: { type: 'array', items: { type: 'string' }, description: 'Only return these node ids.' },
          types: { type: 'array', items: { type: 'string' }, description: 'Only return these node types.' },
          bounds: {
            type: 'object',
            additionalProperties: false,
            description: 'World-space rectangle intersecting the requested nodes.',
            properties: {
              minX: { type: 'number' },
              minY: { type: 'number' },
              maxX: { type: 'number' },
              maxY: { type: 'number' },
            },
            required: ['minX', 'minY', 'maxX', 'maxY'],
          },
          limit: { type: 'integer', description: `Maximum nodes to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
      output: textOutput,
      execute: async (args, exec) => {
        const boardId = args.board_id || exec?.session?.id || 'default'
        return await this.read(boardId, {
          nodeIds: args.node_ids,
          types: args.types,
          bounds: args.bounds,
          limit: args.limit,
        })
      },
    })
    this.ctx.tools.register({
      name: 'canvas_write',
      description: 'Create, update, delete, or layout nodes on the session canvas transactionally.',
      parameters: {
        type: 'object',
        required: ['operations'],
        properties: {
          board_id: { type: 'string', description: 'Board id. Defaults to the current Agent session id.' },
          expected_revision: { type: 'integer', description: 'Expected revision for optimistic concurrency control.' },
          operations: {
            type: 'array',
            description: 'Non-empty array of canvas mutations executed as a single transaction.',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['create', 'update', 'delete', 'layout'] },
                nodes: { type: 'array', items: { type: 'object' }, description: 'Node inputs for create/update.' },
                node_ids: { type: 'array', items: { type: 'string' }, description: 'Target node ids for delete/layout.' },
                layout: {
                  type: 'object',
                  description: 'Layout specification for layout operation.',
                  properties: {
                    direction: { type: 'string', enum: ['horizontal', 'vertical', 'grid'] },
                    gap: { type: 'number' },
                    startX: { type: 'number' },
                    startY: { type: 'number' },
                    columns: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      output: textOutput,
      execute: async (args, exec) => {
        const boardId = args.board_id || exec?.session?.id || 'default'
        const operations = (args.operations || []).map((op) => ({
          type: op.type,
          nodes: op.nodes,
          nodeIds: op.node_ids,
          layout: op.layout,
        }))
        return await this.write(boardId, {
          expectedRevision: args.expected_revision,
          operations,
        })
      },
    })
  }
}

export function apply(ctx, config = {}) {
  const service = new CanvasService(ctx, config)
  if (typeof ctx.provide === 'function') {
    ctx.provide('canvas')
  }
  ctx.canvas = service
}

function emptyDocument() {
  return {
    schemaVersion: 1,
    revision: 0,
    nodes: [],
    assets: [],
    viewport: EMPTY_VIEWPORT,
  }
}

function normalizeBoardId(boardId) {
  if (typeof boardId !== 'string' || boardId.trim().length === 0) {
    throw new TypeError('boardId must be a non-empty string')
  }
  return boardId.trim()
}

function normalizeDocument(document) {
  if (!document || typeof document !== 'object') throw new TypeError('document must be an object')
  const schemaVersion = document.schemaVersion ?? 1
  if (schemaVersion !== 1) throw new TypeError(`unsupported schemaVersion: ${schemaVersion}`)
  const revision = document.revision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative integer')
  const nodes = Array.isArray(document.nodes) ? document.nodes.map(normalizeNode) : []
  const assets = Array.isArray(document.assets) ? clone(document.assets) : []
  const viewport = normalizeViewport(document.viewport)
  const normalized = { schemaVersion, revision, nodes, assets, viewport }
  validateDocument(normalized)
  return normalized
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') throw new TypeError('node must be an object')
  const id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : randomUUID()
  const type = typeof node.type === 'string' && node.type.trim() ? node.type.trim() : 'rect'
  const x = Number(node.x ?? 0)
  const y = Number(node.y ?? 0)
  const width = Number(node.width ?? 120)
  const height = Number(node.height ?? 80)
  finite(x, 'node.x')
  finite(y, 'node.y')
  finite(width, 'node.width')
  finite(height, 'node.height')
  if (width < 0 || height < 0) throw new TypeError('node width and height must be non-negative')
  const rotation = Number(node.rotation ?? 0)
  finite(rotation, 'node.rotation')
  const zIndex = Number(node.zIndex ?? 0)
  finite(zIndex, 'node.zIndex')
  const locked = Boolean(node.locked)
  const parentId = node.parentId === null || node.parentId === undefined ? null : String(node.parentId)
  const props = node.props && typeof node.props === 'object' ? clone(node.props) : {}
  assertJson(props)
  return { id, type, x, y, width, height, rotation, zIndex, locked, parentId, props }
}

function normalizeViewport(viewport) {
  if (!viewport || typeof viewport !== 'object') return EMPTY_VIEWPORT
  const scale = Number(viewport.scale ?? 1)
  finite(scale, 'viewport.scale')
  if (scale <= 0) throw new TypeError('viewport.scale must be positive')
  const offset = viewport.offset && typeof viewport.offset === 'object' ? viewport.offset : {}
  const x = Number(offset.x ?? 0)
  const y = Number(offset.y ?? 0)
  finite(x, 'viewport.offset.x')
  finite(y, 'viewport.offset.y')
  return { scale, offset: { x, y } }
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError('bounds must be an object')
  const minX = Number(bounds.minX)
  const minY = Number(bounds.minY)
  const maxX = Number(bounds.maxX)
  const maxY = Number(bounds.maxY)
  finite(minX, 'bounds.minX')
  finite(minY, 'bounds.minY')
  finite(maxX, 'bounds.maxX')
  finite(maxY, 'bounds.maxY')
  if (minX > maxX || minY > maxY) throw new TypeError('bounds min values must not exceed max values')
  return { minX, minY, maxX, maxY }
}

function applyOperation(document, operation, collector) {
  if (!operation || typeof operation !== 'object') throw new TypeError('operation must be an object')
  switch (operation.type) {
    case 'create': {
      if (!Array.isArray(operation.nodes) || operation.nodes.length === 0) {
        throw new TypeError('create operation requires a non-empty nodes array')
      }
      for (const input of operation.nodes) {
        const node = normalizeNode(input)
        if (document.nodes.some((existing) => existing.id === node.id)) {
          throw new TypeError(`node already exists: ${node.id}`)
        }
        document.nodes.push(node)
        collector.addedNodeIds.push(node.id)
      }
      break
    }
    case 'update': {
      if (!Array.isArray(operation.nodes) || operation.nodes.length === 0) {
        throw new TypeError('update operation requires a non-empty nodes array')
      }
      for (const patch of operation.nodes) {
        if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string') {
          throw new TypeError('update patch requires a string id')
        }
        const index = document.nodes.findIndex((node) => node.id === patch.id)
        if (index === -1) throw new TypeError(`node not found for update: ${patch.id}`)
        const current = document.nodes[index]
        const next = normalizeNode({
          ...current,
          ...patch,
          props: {
            ...current.props,
            ...(patch.props && typeof patch.props === 'object' ? patch.props : {}),
          },
        })
        document.nodes[index] = next
        collector.updatedNodeIds.push(next.id)
      }
      break
    }
    case 'delete': {
      if (!Array.isArray(operation.nodeIds) || operation.nodeIds.length === 0) {
        throw new TypeError('delete operation requires a non-empty nodeIds array')
      }
      const targets = new Set(operation.nodeIds.map(String))
      document.nodes = document.nodes.filter((node) => {
        if (!targets.has(node.id)) return true
        collector.removedNodeIds.push(node.id)
        return false
      })
      break
    }
    case 'layout': {
      if (!Array.isArray(operation.nodeIds) || operation.nodeIds.length === 0) {
        throw new TypeError('layout operation requires a non-empty nodeIds array')
      }
      const targetIds = new Set(operation.nodeIds.map(String))
      const matched = document.nodes.filter((node) => targetIds.has(node.id))
      if (matched.length === 0) return
      const direction = operation.layout?.direction || 'horizontal'
      const gap = Number(operation.layout?.gap ?? 24)
      finite(gap, 'layout.gap')
      let cursorX = Number(operation.layout?.startX ?? matched[0].x)
      let cursorY = Number(operation.layout?.startY ?? matched[0].y)
      finite(cursorX, 'layout.startX')
      finite(cursorY, 'layout.startY')
      const columns = Math.max(1, Math.floor(Number(operation.layout?.columns ?? 3)))
      let col = 0
      let rowHeight = 0
      for (const node of matched) {
        if (direction === 'horizontal') {
          node.x = cursorX
          node.y = cursorY
          cursorX += node.width + gap
        } else if (direction === 'vertical') {
          node.x = cursorX
          node.y = cursorY
          cursorY += node.height + gap
        } else if (direction === 'grid') {
          node.x = cursorX
          node.y = cursorY
          rowHeight = Math.max(rowHeight, node.height)
          col += 1
          if (col >= columns) {
            col = 0
            cursorX = Number(operation.layout?.startX ?? matched[0].x)
            cursorY += rowHeight + gap
            rowHeight = 0
          } else {
            cursorX += node.width + gap
          }
        }
        collector.updatedNodeIds.push(node.id)
      }
      break
    }
    default:
      throw new TypeError(`unsupported canvas operation type: ${operation.type}`)
  }
}

function validateDocument(document) {
  const ids = new Set()
  for (const node of document.nodes) {
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`)
    ids.add(node.id)
  }
}

function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer')
  if (limit > MAX_LIMIT) return MAX_LIMIT
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

export default { name, inject, apply }
