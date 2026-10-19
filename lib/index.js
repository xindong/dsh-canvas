import { resolveViewport } from './viewport-request.js'
import { denseRegions } from './dense-regions.js'
import { StorageSettingsStore } from './storage-settings.js'
import { PromptSettingsStore, renderPromptTemplate } from './prompt-settings.js'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, extname, join, resolve } from 'node:path'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500
const BINARY_VERSION_MEMO_LIMIT = 256
const MAX_IMPORT_BYTES = 64 * 1024 * 1024

const EMPTY_VIEWPORT = Object.freeze({ scale: 1, offset: Object.freeze({ x: 0, y: 0 }) })
const CURRENT_FILE = 'current.json'
const DEFAULT_BOARD = 'default'

export const name = 'xindong-canvas'
export const inject = ['tools', 'systemPrompt']

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
    this.storageSettings = new StorageSettingsStore({ defaultRoot: config.root })
    this.root = this.storageSettings.root
    this.assetsRoot = join(this.root, 'assets')
    this.metaRoot = join(this.root, 'meta')
    this.selectionQueue = Promise.resolve()
    this.documents = new Map()
    this.loading = new Map()
    this.queues = new Map()
    this.listeners = new Map()
    this.focusRequests = new Map()
    this.binaryVersions = new Map()
    this.initPromise = mkdir(this.root, { recursive: true }).catch((err) => {
      this.ctx?.logger?.warn?.(err)
    })
    this.promptSettings = new PromptSettingsStore(this.root, () => this.ctx?.emit?.('system-prompt/change'))
    this.promptSettings.ready.catch(error => this.ctx?.logger?.warn?.(error))
    this.currentBoardId = undefined
    this.registerTools()
    this.registerPromptContributions()
    void this.getCurrentBoardId().then(id => this.load(id)).catch(error => this.ctx?.logger?.warn?.(error))
  }

  /**
   * The canvas is decoupled from sessions: boards are global, and a single
   * "current board" selection is shared by every conversation and agent tool.
   */
  async listBoards() {
    await this.initPromise
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    const boards = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === CURRENT_FILE) continue
      let id
      try {
        id = Buffer.from(entry.name.slice(0, -5), 'base64url').toString('utf8')
      } catch {
        continue
      }
      if (!id || Buffer.from(id, 'utf8').toString('base64url') !== entry.name.slice(0, -5)) continue
      try {
        const document = await this.snapshot(id)
        let updatedAt = null
        try {
          updatedAt = (await stat(join(this.root, entry.name))).mtimeMs
        } catch { /* ignore */ }
        const meta = await this.getBoardMeta(id)
        boards.push({
          id,
          name: meta.name,
          createdAt: meta.createdAt,
          revision: document.revision,
          nodes: document.nodes.length,
          assets: document.assets.length,
          updatedAt,
        })
      } catch (error) {
        this.ctx?.logger?.warn?.(error)
      }
    }
    boards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return boards
  }

  async getCurrentBoardId() {
    await this.initPromise
    try {
      const parsed = JSON.parse(await readFile(this.currentPath(), 'utf8'))
      if (parsed && typeof parsed.boardId === 'string' && parsed.boardId.trim()) {
        this.currentBoardId = parsed.boardId.trim()
        return this.currentBoardId
      }
    } catch { /* fall through to the default */ }
    this.currentBoardId = DEFAULT_BOARD
    return DEFAULT_BOARD
  }

  async setCurrentBoardId(boardId) {
    const id = normalizeBoardId(boardId)
    return await this.enqueueSelection(() => this.persistCurrentBoardId(id))
  }

  async persistCurrentBoardId(id) {
    await mkdir(this.root, { recursive: true })
    const target = this.currentPath()
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ boardId: id, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    this.currentBoardId = id
    await this.load(id)
    this.ctx?.emit?.('system-prompt/change')
    return id
  }

  /** Ensures a board exists; optional initial data never overwrites an existing board. */
  async createBoard(boardId, options = {}) {
    const id = normalizeBoardId(boardId)
    const name = options.name === undefined ? undefined : normalizeBoardName(options.name)
    const initial = options.document === undefined ? undefined : normalizeDocument(options.document)
    return await this.enqueue(id, async () => {
      const document = await this.load(id)
      try {
        await stat(this.pathFor(id))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await this.persist(id, initial ? { ...initial, revision: 0 } : clone(document))
      }
      const meta = await this.getBoardMeta(id)
      await this.persistBoardMeta(id, { ...meta, ...(name === undefined ? {} : { name }) })
      return id
    })
  }

  async renameBoard(boardId, name) {
    const id = normalizeBoardId(boardId)
    const normalized = normalizeBoardName(name)
    return await this.enqueue(id, async () => {
      await stat(this.pathFor(id))
      const meta = { ...await this.getBoardMeta(id), name: normalized }
      await this.persistBoardMeta(id, meta)
      return { boardId: id, ...meta }
    })
  }

  async deleteBoard(boardId) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, () => this.enqueueSelection(async () => {
      // An in-flight read must settle before the cache is cleared.
      await this.loading.get(id)?.catch(() => {})
      await rm(this.pathFor(id), { force: true })
      await rm(this.metaPathFor(id), { force: true })
      await rm(join(this.assetsRoot, sanitizeSegment(id)), { recursive: true, force: true })
      this.documents.delete(id)
      this.loading.delete(id)
      let currentBoardId = await this.getCurrentBoardId()
      if (currentBoardId === id) {
        const remaining = await this.listBoards()
        currentBoardId = remaining[0]?.id || DEFAULT_BOARD
        await this.persistCurrentBoardId(currentBoardId)
      }
      this.emit(id, { type: 'board:delete', boardId: id, currentBoardId })
      this.listeners.delete(id)
      return { boardId: id, currentBoardId }
    }))
  }

  metaPathFor(boardId) {
    return join(this.metaRoot, `${Buffer.from(boardId, 'utf8').toString('base64url')}.json`)
  }

  async getBoardMeta(boardId) {
    try {
      const meta = JSON.parse(await readFile(this.metaPathFor(boardId), 'utf8'))
      if (typeof meta.name === 'string' && Number.isFinite(meta.createdAt)) return meta
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let createdAt = Date.now()
    try {
      const info = await stat(this.pathFor(boardId))
      createdAt = info.birthtimeMs || info.mtimeMs
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return { name: boardId, createdAt }
  }

  async persistBoardMeta(boardId, meta) {
    await mkdir(this.metaRoot, { recursive: true })
    const target = this.metaPathFor(boardId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  enqueueSelection(operation) {
    const result = this.selectionQueue.then(operation, operation)
    this.selectionQueue = result.then(() => undefined, () => undefined)
    return result
  }

  currentPath() {
    return join(this.root, CURRENT_FILE)
  }

  /**
   * Registers (or replaces) an asset record inside the board document and
   * bumps the revision. Binary payloads are stored separately via putBinary.
   */
  async upsertAsset(boardId, asset) {
    const id = normalizeBoardId(boardId)
    const normalized = normalizeAsset(asset)
    return await this.enqueue(id, async () => {
      const current = await this.load(id)
      const next = clone(current)
      const index = next.assets.findIndex((existing) => existing.id === normalized.id)
      if (index === -1) next.assets.push(normalized)
      else next.assets[index] = normalized
      next.revision = current.revision + 1
      await this.persist(id, next)
      const result = { boardId: id, revision: next.revision, asset: clone(normalized), document: clone(next) }
      this.emit(id, { type: 'asset:upsert', ...result })
      return result
    })
  }

  /** Publishes a completed preview and its node patch as one document mutation. */
  async publishPreview(boardId, { assetId, requestId, nodeId, expectedRevision, asset, patch }) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, async () => {
      const current = await this.load(id)
      assertExpectedRevision(expectedRevision, current.revision)
      const node = current.nodes.find((existing) => existing.id === nodeId)
      if (!node) throw new TypeError(`node not found for update: ${nodeId}`)
      if (typeof requestId !== 'string' || !requestId || node.props?.previewRequestId !== requestId) {
        throw new TypeError(`preview request no longer matches node: ${nodeId}`)
      }
      if (!Object.entries(node.assetRefs || {}).some(([name, ref]) => (
        !name.startsWith('_documentPreview') && ref.assetId === assetId
      ))) {
        throw new TypeError(`node no longer references asset: ${assetId}`)
      }
      if (!asset || asset.id !== assetId) throw new TypeError('preview asset id must match assetId')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('preview patch must be an object')
      }
      const normalized = { ...clone(asset), ...normalizeAsset(asset) }
      assertJson(normalized)
      const next = clone(current)
      const index = next.assets.findIndex((existing) => existing.id === assetId)
      if (index === -1) next.assets.push(normalized)
      else next.assets[index] = normalized
      const nodePatch = { ...clone(patch), id: nodeId }
      if (nodePatch.assetRefs && typeof nodePatch.assetRefs === 'object' && !Array.isArray(nodePatch.assetRefs)) {
        // Preview refs form a replacement set: omitted document derivatives
        // were deliberately removed by the service. Preserve the current user
        // refs rather than replaying their possibly stale values from the job.
        const previewRef = (name) => name === 'preview' || name.startsWith('_documentPreview')
        nodePatch.assetRefs = {
          ...Object.fromEntries(Object.entries(node.assetRefs || {}).filter(([name]) => !previewRef(name))),
          ...Object.fromEntries(Object.entries(nodePatch.assetRefs).filter(([name]) => previewRef(name))),
        }
      }
      const collector = { addedNodeIds: [], updatedNodeIds: [], removedNodeIds: [] }
      applyOperation(next, { type: 'update', nodes: [nodePatch] }, collector)
      next.revision = current.revision + 1
      validateDocument(next)
      await this.persist(id, next)
      const result = {
        boardId: id,
        revision: next.revision,
        document: clone(next),
        asset: clone(normalized),
        // SSE consumers need field presence to mean that the service wrote it.
        // A full node would falsely turn unchanged geometry into a resize patch.
        nodePatch: clone({
          ...nodePatch,
          ...(nodePatch.assetRefs ? { assetRefs: next.nodes.find((existing) => existing.id === nodeId).assetRefs || {} } : {}),
        }),
      }
      this.emit(id, {
        type: 'write',
        boardId: id,
        revision: next.revision,
        addedNodeIds: unique(collector.addedNodeIds),
        updatedNodeIds: unique(collector.updatedNodeIds),
        removedNodeIds: unique(collector.removedNodeIds),
        document: result.document,
      })
      return result
    })
  }

  async removeAsset(boardId, assetId) {
    const id = normalizeBoardId(boardId)
    const target = String(assetId)
    return await this.enqueue(id, async () => {
      const current = await this.load(id)
      const next = clone(current)
      next.assets = next.assets.filter((asset) => asset.id !== target)
      next.nodes = next.nodes.map((node) => {
        if (!node.assetRefs) return node
        const refs = {}
        for (const [name, ref] of Object.entries(node.assetRefs)) {
          if (ref.assetId !== target) refs[name] = ref
        }
        return { ...node, assetRefs: Object.keys(refs).length > 0 ? refs : undefined }
      })
      next.revision = current.revision + 1
      await this.persist(id, next)
      await this.deleteBinaries(id, target)
      const result = { boardId: id, revision: next.revision, assetId: target, document: clone(next) }
      this.emit(id, { type: 'asset:remove', ...result })
      return result
    })
  }

  /** Stores a binary payload for an asset variant on disk. */
  async putBinary(boardId, assetId, variant, data, meta = {}) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, async () => {
      const base = this.assetPath(id, assetId, variant)
      await mkdir(join(this.assetsRoot, sanitizeSegment(id)), { recursive: true })
      const temporary = `${base}.${randomUUID()}.tmp`
      this.binaryVersions.delete(base)
      try {
        await writeFile(temporary, data)
        await rename(temporary, base)
        const version = await this.binaryVersionAt(base, {
          mimeType: String(meta.mimeType || 'application/octet-stream'),
          fileName: String(meta.fileName || ''),
        }, true)
        return { boardId: id, assetId: String(assetId), variant: String(variant), size: version.size }
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  /** Removes all variants and sidecars for exactly one asset, without touching its nodes. */
  async removeBinary(boardId, assetId) {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, () => this.deleteBinaries(id, assetId))
  }

  async deleteBinaries(boardId, assetId) {
    this.binaryVersions.clear()
    const directory = join(this.assetsRoot, sanitizeSegment(boardId))
    const target = sanitizeSegment(assetId)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await Promise.all(entries.filter((entry) => {
      if (!entry.isFile()) return false
      const binaryName = entry.name.endsWith('.meta.json') ? entry.name.slice(0, -10) : entry.name
      return binaryName.slice(0, binaryName.lastIndexOf('.')) === target
    }).map((entry) => rm(join(directory, entry.name), { force: true })))
  }

  /** Reads a stored binary payload; resolves null when missing. */
  async getBinary(boardId, assetId, variant) {
    const id = normalizeBoardId(boardId)
    const bases = this.binaryPaths(id, assetId, variant)
    for (const base of bases) {
      try {
        const [data, metaText] = await Promise.all([
          readFile(base), readFile(`${base}.meta.json`, 'utf8').catch(() => null),
        ])
        const meta = metaText ? safeParse(metaText) : {}
        return { data, mimeType: String(meta.mimeType || 'application/octet-stream'), fileName: String(meta.fileName || '') }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return null
  }

  /** Returns a content-derived version without changing the board revision. */
  async getBinaryVersion(boardId, assetId, variant = 'original') {
    const id = normalizeBoardId(boardId)
    return await this.enqueue(id, async () => {
      for (const base of this.binaryPaths(id, assetId, variant)) {
        try {
          return await this.binaryVersionAt(base)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          this.binaryVersions.delete(base)
        }
      }
      return null
    })
  }

  binaryPaths(id, assetId, variant) {
    const bases = [this.assetPath(id, assetId, variant)]
    // Earlier local plugins replaced punctuation with underscores. Read those
    // files too; new writes always use collision-free encoded path segments.
    const legacyBoard = legacySegment(id)
    if (legacyBoard && legacyBoard !== '.' && legacyBoard !== '..') {
      const legacy = join(this.assetsRoot, legacyBoard, `${legacySegment(assetId)}.${legacySegment(variant)}`)
      if (!bases.includes(legacy)) bases.push(legacy)
    }
    return bases
  }

  async binaryVersionAt(base, suppliedMeta, forceHash = false) {
    // The descriptor binds hashing to one inode even if another writer renames
    // the path. Check both the descriptor and the path before trusting its hash.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = binaryStatStamp(await stat(base, { bigint: true }))
      const cached = this.binaryVersions.get(base)
      if (!forceHash && cached?.stamp === before) return { ...cached.value }
      const parsed = safeParse(await readFile(`${base}.meta.json`, 'utf8').catch((error) => {
        if (error?.code !== 'ENOENT') throw error
        return '{}'
      }))
      const meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      let contentHash
      let size
      let stamp
      if (!forceHash && meta.statStamp === before && /^[a-f0-9]{64}$/.test(meta.contentHash)
        && Number.isSafeInteger(meta.size) && meta.size >= 0) {
        contentHash = meta.contentHash
        size = meta.size
        stamp = before
      } else {
        const handle = await open(base, 'r')
        try {
          const info = await handle.stat({ bigint: true })
          stamp = binaryStatStamp(info)
          size = Number(info.size)
          const hash = createHash('sha256')
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
          if (binaryStatStamp(await handle.stat({ bigint: true })) !== stamp) continue
          contentHash = hash.digest('hex')
        } finally {
          await handle.close()
        }
      }
      const after = await stat(base, { bigint: true })
      if (binaryStatStamp(after) !== stamp || Number(after.size) !== size) continue
      if (forceHash || meta.statStamp !== stamp || meta.contentHash !== contentHash || meta.size !== size) {
        const target = `${base}.meta.json`
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify({
            ...meta, ...suppliedMeta, contentHash, size, statStamp: stamp,
          }))
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      if (binaryStatStamp(await stat(base, { bigint: true })) !== stamp) continue
      const value = { contentHash, size, version: contentHash }
      this.binaryVersions.delete(base)
      this.binaryVersions.set(base, { stamp, value })
      while (this.binaryVersions.size > BINARY_VERSION_MEMO_LIMIT) {
        this.binaryVersions.delete(this.binaryVersions.keys().next().value)
      }
      return { ...value }
    }
    throw new Error(`binary changed while computing content version: ${base}`)
  }

  assetPath(boardId, assetId, variant) {
    const safeId = sanitizeSegment(boardId)
    const safeAsset = sanitizeSegment(assetId) || 'asset'
    const safeVariant = sanitizeSegment(variant) || 'original'
    return join(this.assetsRoot, safeId, `${safeAsset}.${safeVariant}`)
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
    const regions = request.focus === true ? denseRegions(matches) : undefined
    const returned = matches.slice(0, limit)
    const returnedIds = new Set(returned.map(node => node.id))
    const allConnections = Array.isArray(document.metadata?.connections) ? document.metadata.connections : []
    const incoming = new Map(), outgoing = new Map()
    for (const edge of allConnections) {
      if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
      if (!incoming.has(edge.target)) incoming.set(edge.target, new Set())
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set())
      incoming.get(edge.target).add(edge.source)
      outgoing.get(edge.source).add(edge.target)
    }
    return {
      boardId: id,
      revision: document.revision,
      nodes: clone(returned.map(node => ({ ...node, from: [...(incoming.get(node.id) || [])], to: [...(outgoing.get(node.id) || [])] }))),
      connections: clone(allConnections.filter(edge => edge && (returnedIds.has(edge.source) || returnedIds.has(edge.target)))),
      assets: clone(document.assets),
      viewport: clone(document.viewport || EMPTY_VIEWPORT),
      ...(regions ? { regions } : {}),
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
      if (request.assets !== undefined && !Array.isArray(request.assets)) {
        throw new TypeError('assets must be an array')
      }
      const next = clone(current)
      for (const asset of request.assets || []) {
        const normalized = normalizeAsset(asset)
        const index = next.assets.findIndex(existing => existing.id === normalized.id)
        if (index === -1) next.assets.push(normalized)
        else next.assets[index] = normalized
      }
      const addedNodeIds = []
      const updatedNodeIds = []
      const removedNodeIds = []
      for (const operation of request.operations) {
        applyOperation(next, operation, { addedNodeIds, updatedNodeIds, removedNodeIds })
      }
      next.revision = current.revision + 1
      validateDocument(next)
      await this.persist(id, next)
      const beforeEdges = new Map((current.metadata?.connections || []).map(edge => [edge.id, edge]))
      const afterEdges = new Map((next.metadata?.connections || []).map(edge => [edge.id, edge]))
      const result = {
        boardId: id,
        revision: next.revision,
        addedConnectionIds: [...afterEdges.keys()].filter(id => !beforeEdges.has(id)),
        updatedConnectionIds: [...afterEdges.keys()].filter(id => beforeEdges.has(id) && JSON.stringify(beforeEdges.get(id)) !== JSON.stringify(afterEdges.get(id))),
        removedConnectionIds: [...beforeEdges.keys()].filter(id => !afterEdges.has(id)),
        addedNodeIds: unique(addedNodeIds),
        updatedNodeIds: unique(updatedNodeIds),
        removedNodeIds: unique(removedNodeIds),
        document: clone(next),
      }
      this.emit(id, { type: 'write', ...result })
      return result
    })
  }

  async storeImportedAsset(boardId, { assetId = randomUUID(), data, fileName, mimeType, kind, metadata = {} }) {
    const id = normalizeBoardId(boardId)
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    if (!bytes.length) throw new TypeError('Imported asset is empty')
    if (bytes.length > MAX_IMPORT_BYTES) throw new TypeError(`Imported asset exceeds ${MAX_IMPORT_BYTES} bytes`)
    const name = normalizeFileName(fileName || `${assetId}.bin`)
    const type = normalizeMimeType(mimeType || mimeTypeForName(name))
    const assetKind = kind || inferAssetKind(type, name)
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    await this.putBinary(id, assetId, 'original', bytes, { mimeType: type, fileName: name, size: bytes.length, contentHash })
    const asset = normalizeAsset({
      id: assetId,
      kind: assetKind,
      metadata: { fileName: name, name, mimeType: type, size: bytes.length, contentHash, ...metadata },
    })
    if (!['image', 'video', 'audio'].includes(assetKind)) {
      const preview = fileCardSvg(name, bytes.length)
      await this.putBinary(id, assetId, 'preview', preview, {
        mimeType: 'image/svg+xml', fileName: `${name}.preview.svg`, size: preview.length,
      })
    }
    return { asset, assetId, fileName: name, mimeType: type, kind: assetKind, size: bytes.length }
  }

  createImportedNode(imported, options = {}) {
    const { assetId, fileName, mimeType, kind, size } = imported
    const documentNode = !['image', 'video', 'audio'].includes(kind)
    const { asset_source: _assetSource, assetRefs: _assetRefs, props: _props, ...node } = options.node || {}
    return {
      ...node,
      type: options.node?.type || kind,
      x: options.node?.x ?? options.x ?? 100,
      y: options.node?.y ?? options.y ?? 100,
      width: options.node?.width ?? options.width ?? 320,
      height: options.node?.height ?? options.height ?? (documentNode ? 220 : 240),
      assetRefs: {
        ...(options.node?.assetRefs || {}),
        [documentNode ? 'preview' : 'primary']: { assetId, variant: documentNode ? 'preview' : 'original' },
      },
      props: {
        ...(options.node?.props || {}),
        name: fileName,
        mimeType,
        size,
      },
    }
  }

  async readImportSource(source, signal) {
    signal?.throwIfAborted()
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new TypeError('node.asset_source must contain a path or url')
    }
    const hasPath = typeof source.path === 'string' && source.path.trim()
    const hasUrl = typeof source.url === 'string' && source.url.trim()
    if (Number(Boolean(hasPath)) + Number(Boolean(hasUrl)) !== 1) throw new TypeError('node.asset_source must specify exactly one of path or url')
    if (hasPath) {
      const path = resolve(source.path)
      const info = await stat(path)
      if (!info.isFile()) throw new TypeError('asset_source.path must point to a regular file')
      if (info.size > MAX_IMPORT_BYTES) throw new TypeError(`Imported asset exceeds ${MAX_IMPORT_BYTES} bytes`)
      const data = await readFile(path, { signal })
      return { data, fileName: source.file_name || basename(path), mimeType: source.mime_type, sourceType: 'path' }
    }
    const url = new URL(source.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new TypeError('asset_source.url must be an unauthenticated http(s) URL')
    }
    const { data, mimeType } = await readPublicUrl(url, signal)
    return {
      data,
      fileName: source.file_name || decodeURIComponent(basename(url.pathname)) || 'download.bin',
      mimeType: source.mime_type || mimeType,
      sourceType: 'url',
    }
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
    const meta = await this.getBoardMeta(boardId)
    await mkdir(this.root, { recursive: true })
    const target = this.pathFor(boardId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    await this.persistBoardMeta(boardId, meta)
    this.documents.set(boardId, document)
  }

  pathFor(boardId) {
    return join(this.root, `${Buffer.from(boardId, 'utf8').toString('base64url')}.json`)
  }

  enqueue(boardId, operation) {
    const previous = this.queues.get(boardId) || Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(boardId, tail)
    return result.finally(() => {
      if (this.queues.get(boardId) === tail) this.queues.delete(boardId)
    })
  }

  emit(boardId, change) {
    for (const listener of this.listeners.get(boardId) || []) {
      try { listener(clone(change)) } catch (error) { this.ctx?.logger?.warn?.(error) }
    }
  }

  getStorageSettings() { return this.storageSettings.get() }

  saveStorageSettings(request) { return this.storageSettings.save(request) }

  getPromptSettings() { return this.promptSettings.get() }

  savePromptSettings(request) { return this.promptSettings.save(request) }

  registerPromptContributions() {
    const prompt = this.ctx?.systemPrompt
    const visible = scope => !!this.ctx.tools.get('canvas_read', scope)
    prompt.section({
      name: 'xindong:canvas:guidance', order: 6500, interpolate: false,
      text: ({ scope }) => {
        const config = this.promptSettings.state?.settings
        return config?.systemEnabled && visible(scope) ? config.systemText : ''
      },
    })
    prompt.context({
      name: 'xindong:canvas:summary', order: 6500,
      text: ({ scope }) => {
        const config = this.promptSettings.state?.settings
        const document = this.documents.get(this.currentBoardId)
        if (!config?.contextEnabled || !visible(scope) || !document) return ''
        return renderPromptTemplate(config.contextTemplate, {
          // DSH interpolates dynamic context once more; keep board IDs as
          // JSON data even when an ID contains literal template braces.
          board_id: JSON.stringify(this.currentBoardId).replace(/\{/g, '\\u007b').replace(/\}/g, '\\u007d'), revision: document.revision,
          node_count: document.nodes.length,
          connection_count: Array.isArray(document.metadata?.connections) ? document.metadata.connections.length : 0,
        })
      },
    })
  }

  registerTools() {
    const textOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }
    this.ctx.tools.register({
      name: 'canvas_read',
      isConcurrencySafe: () => true,
      presentCall: args => ({ card: 'generic', title: '读取画布', kind: 'read', rawInput: args }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '读取画布失败' : '已读取画布' }),
      description: 'Read-only canvas query. Set focus=true to return dense region suggestions without moving the camera. Camera movement requires explicit canvas_write.viewport.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'string', description: 'Board id. Defaults to the globally selected canvas.' },
          focus: { type: 'boolean', description: 'Optional: return dense region suggestions among all matching nodes (before limit). Analysis only; NEVER moves the camera. Defaults to false.' },
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
        exec.signal.throwIfAborted()
        const boardId = args.board_id || await this.getCurrentBoardId()
        return await this.read(boardId, {
          focus: args.focus,
          nodeIds: args.node_ids,
          types: args.types,
          bounds: args.bounds,
          limit: args.limit,
        })
      },
    })
    this.ctx.tools.register({
      name: 'canvas_write',
      presentCall: args => ({ card: 'generic', title: args.operations?.length ? '更新画布' : '调整画布视口', kind: 'edit', rawInput: args }),
      presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '更新画布失败' : '画布操作完成' }),
      description: 'Create, update, convert, delete, or layout canvas nodes and create/update/delete directed connections transactionally (create_connections, update_connections, delete_connections); optionally move the browser camera with viewport (can be used alone). Camera requests do not change document revision. A processing node is an optional placeholder (props: title, label (custom display type), message, status running|failed). Convert replaces its content/type in place, preserving its ID, geometry and connections. Create/convert can import files with asset_source.',
      parameters: {
        type: 'object',
        properties: {
          board_id: { type: 'string', description: 'Board id. Defaults to the globally selected canvas.' },
          expected_revision: { type: 'integer', description: 'Expected revision for optimistic concurrency control.' },
          viewport: {
            type: 'object', description: 'Optional camera request applied after mutations. Does not switch boards. Only open views of this board apply it when idle; result is requested, not acknowledged.',
            required: ['action'], properties: {
              action: { type: 'string', enum: ['fit', 'center', 'zoom', 'pan', 'reset'] },
              target: { type: 'string', enum: ['all', 'dense'], description: 'For fit/center, defaults to all nodes. dense ignores distant outliers.' },
              node_ids: { type: 'array', items: { type: 'string' }, description: 'For fit/center: target nodes, including explicitly assigned IDs created in this call.' },
              bounds: { type: 'object', properties: { minX: {type:'number'}, minY: {type:'number'}, maxX: {type:'number'}, maxY: {type:'number'} }, required: ['minX','minY','maxX','maxY'] },
              center: { type: 'object', properties: { x: {type:'number'}, y: {type:'number'} }, required: ['x','y'], description: 'World point for action=center.' },
              scale: { type: 'number', description: 'Absolute zoom, 1=100%. For zoom, center, or fit (fit uses it as maximum zoom).' },
              factor: { type: 'number', description: 'For zoom: multiplier, e.g. 1.25 zooms in. Mutually exclusive with scale.' },
              dx: { type: 'number', description: 'pan: screen pixels, positive moves contents right.' },
              dy: { type: 'number', description: 'pan: screen pixels, positive moves contents down.' },
              padding: { type: 'number', description: 'fit: screen-space padding, default 72, range 0–500.' },
            },
          },
          operations: {
            type: 'array',
            description: 'Non-empty array of canvas mutations executed as a single transaction.',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'string', enum: ['create', 'update', 'convert', 'delete', 'layout', 'create_connections', 'update_connections', 'delete_connections'] },
                nodes: {
                  type: 'array',
                  description: 'Node inputs for create/update/convert. Convert requires id and target type; it resets old props/assets and retains unspecified geometry. Create/convert accept asset_source for file imports.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Node ID. Required for update/convert; can be assigned on create to reference a placeholder later.' },
                      type: { type: 'string', description: 'Node type, e.g. processing, image, video, text, file. Required target type for convert.' },
                      props: {
                        type: 'object',
                        description: 'Type-specific content. Processing uses title (task), label (custom display type, e.g. 生图/修图/视频), message (current status/reason) and status (running or failed). Convert replaces all old props.',
                      },
                      asset_source: {
                        type: 'object',
                        description: 'Optional import source for create/convert. Specify exactly one of path or url.',
                        properties: {
                          path: { type: 'string', description: 'Absolute or working-directory-relative local file path.' },
                          url: { type: 'string', description: 'Public HTTP(S) file URL. Private/local addresses and redirects are rejected.' },
                          file_name: { type: 'string', description: 'Optional display name; defaults to the source filename.' },
                          mime_type: { type: 'string', description: 'Optional MIME type override.' },
                          kind: { type: 'string', description: 'Optional canvas media kind override.' },
                        },
                      },
                    },
                  },
                },
                connections: {
                  type: 'array', minItems: 1,
                  description: 'For create_connections: source and target are required, id is optional. For update_connections: id is required; source/target patch the existing edge. Direction is source → target. Endpoints must exist when this operation runs; create nodes first. Self-links and duplicate directed pairs are rejected; cycles are allowed.',
                  items: { type: 'object', additionalProperties: false, properties: {
                    id: { type: 'string', minLength: 1 },
                    source: { type: 'string', minLength: 1 },
                    target: { type: 'string', minLength: 1 },
                  } },
                },
                connection_ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'For delete_connections: existing connection IDs from canvas_read.connections.' },
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
        exec.signal.throwIfAborted()
        const boardId = args.board_id || await this.getCurrentBoardId()
        if (args.expected_revision !== undefined) {
          const current = await this.snapshot(boardId)
          assertExpectedRevision(args.expected_revision, current.revision)
        }
        if (args.operations !== undefined && !Array.isArray(args.operations)) throw new TypeError('operations must be an array')
        if (!args.operations?.length && !args.viewport) throw new TypeError('Provide operations or viewport')
        const assets = []
        const operations = []
        for (const op of args.operations || []) {
          const nodes = []
          if (op.type === 'create' || op.type === 'convert') {
            for (const node of op.nodes || []) {
              if (!node?.asset_source) {
                nodes.push(node)
                continue
              }
              const source = await this.readImportSource(node.asset_source, exec.signal)
              const imported = await this.storeImportedAsset(boardId, {
                data: source.data,
                fileName: source.fileName,
                mimeType: source.mimeType,
                kind: node.asset_source.kind,
                metadata: { sourceType: source.sourceType },
              })
              assets.push(imported.asset)
              const resultNode = this.createImportedNode(imported, { node })
              if (op.type === 'convert') {
                // The converter must retain the user's latest geometry rather
                // than the importer's default placement and size.
                for (const key of ['x', 'y', 'width', 'height']) {
                  if (!Object.hasOwn(node, key)) delete resultNode[key]
                }
              }
              nodes.push(resultNode)
            }
          } else if (op.nodes?.some(node => node?.asset_source)) {
            throw new TypeError('asset_source is supported by create and convert; use convert to replace node content')
          }
          operations.push({ type: op.type, nodes: ['create', 'convert'].includes(op.type) ? nodes : op.nodes, nodeIds: op.node_ids, layout: op.layout, connections: op.connections, connectionIds: op.connection_ids })
        }
        exec.signal.throwIfAborted()
        // Validate camera targets against the post-write draft before committing.
        let camera
        if (args.viewport) {
          const draft = await this.snapshot(boardId)
          for (const operation of operations) applyOperation(draft, operation, { addedNodeIds: [], updatedNodeIds: [], removedNodeIds: [] })
          camera = resolveViewport(args.viewport, draft)
        }
        const result = operations.length ? await this.write(boardId, {
          expectedRevision: args.expected_revision, assets, operations,
        }) : { boardId, revision: (await this.snapshot(boardId)).revision }
        if (camera) {
          const request = { ...camera, id: randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + 30_000 }
          this.focusRequests.delete(boardId)
          this.focusRequests.set(boardId, request)
          while (this.focusRequests.size > 64) this.focusRequests.delete(this.focusRequests.keys().next().value)
          result.viewport = { ...request, status: 'requested' }
        }
        return result
      },
    })
  }
}

export function apply(ctx, config = {}) {
  const service = new CanvasService(ctx, config)
  ctx.provide('canvas')
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

function normalizeBoardName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name must be a non-empty string')
  return name.trim()
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
  if (document.metadata !== undefined) {
    if (!document.metadata || typeof document.metadata !== 'object' || Array.isArray(document.metadata)) throw new TypeError('document.metadata must be an object')
    assertJson(document.metadata)
    normalized.metadata = clone(document.metadata)
  }
  validateDocument(normalized)
  return normalized
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') throw new TypeError('node must be an object')
  if (Object.hasOwn(node, 'asset_source')) throw new TypeError('asset_source must be resolved by canvas_write create/convert before storing a node')
  const id = typeof node.id === 'string' && node.id.trim() ? node.id.trim() : randomUUID()
  const type = typeof node.type === 'string' && node.type.trim() ? node.type.trim() : 'rect'
  // PixiBoard document schema (pixiboardSDK) requires every node to declare
  // the version of its type definition; schema v1 defines everything as v1.
  const typeVersion = Number(node.typeVersion ?? 1)
  if (!Number.isSafeInteger(typeVersion) || typeVersion < 1) {
    throw new TypeError('node.typeVersion must be a positive integer')
  }
  const x = Number(node.x ?? 0)
  const y = Number(node.y ?? 0)
  const width = Number(node.width ?? (type === 'processing' ? 320 : 120))
  const height = Number(node.height ?? (type === 'processing' ? 220 : 80))
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
  if (type === 'processing') {
    props.title = typeof props.title === 'string' ? props.title : '处理任务'
    props.label = typeof props.label === 'string' ? props.label.slice(0, 24) : '处理'
    props.message = typeof props.message === 'string' ? props.message : ''
    props.status = props.status ?? 'running'
    if (!['running', 'failed'].includes(props.status)) throw new TypeError('processing status must be running or failed')
  }
  assertJson(props)
  const assetRefs = normalizeAssetRefs(node.assetRefs)
  // Preserve upstream fields (style, intrinsic sizes, playbackTime, etc.) and
  // accept custom types such as model/html/markdown/text-file/file unchanged.
  assertJson(node)
  const normalized = { ...clone(node), id, type, typeVersion, x, y, width, height, rotation, zIndex, locked, parentId, props }
  if (assetRefs) normalized.assetRefs = assetRefs
  else delete normalized.assetRefs
  return normalized
}

function normalizeAssetRefs(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('node.assetRefs must be an object')
  }
  const refs = {}
  for (const [name, ref] of Object.entries(value)) {
    if (!ref || typeof ref !== 'object') throw new TypeError(`node.assetRefs.${name} must be an object`)
    const assetId = typeof ref.assetId === 'string' && ref.assetId.trim() ? ref.assetId.trim() : null
    if (!assetId) throw new TypeError(`node.assetRefs.${name}.assetId must be a non-empty string`)
    const variant = ref.variant === undefined ? 'original' : String(ref.variant)
    if (variant !== 'original' && variant !== 'preview' && variant !== 'waveform'
      && !/^preview-[a-f0-9]{64}$/.test(variant)) {
      throw new TypeError(`node.assetRefs.${name}.variant is invalid: ${variant}`)
    }
    refs[name] = { assetId, variant }
  }
  return Object.keys(refs).length > 0 ? refs : undefined
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') throw new TypeError('asset must be an object')
  const id = typeof asset.id === 'string' && asset.id.trim() ? asset.id.trim() : randomUUID()
  const kind = typeof asset.kind === 'string' && asset.kind.trim() ? asset.kind.trim() : 'file'
  const metadata = asset.metadata && typeof asset.metadata === 'object' ? clone(asset.metadata) : {}
  assertJson(metadata)
  return { id, kind, metadata }
}

function normalizeFileName(value) {
  const name = String(value).replace(/[\\/\0]/g, '_').trim()
  if (!name || name === '.' || name === '..') throw new TypeError('asset file name is invalid')
  return name.slice(0, 255)
}

function normalizeMimeType(value) {
  const type = String(value).trim().toLowerCase()
  const base = type.split(';', 1)[0].trim()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? type : 'application/octet-stream'
}

function mimeTypeForName(name) {
  const extension = extname(name).slice(1).toLowerCase()
  return ({
    avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
    aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4', mp3: 'audio/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', ogv: 'video/ogg', webm: 'video/webm',
    html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf',
    glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', fbx: 'application/octet-stream', stl: 'model/stl',
  })[extension] || 'application/octet-stream'
}

function inferAssetKind(mimeType, fileName) {
  const type = normalizeMimeType(mimeType)
  if (/^image\//.test(type)) return 'image'
  if (/^video\//.test(type)) return 'video'
  if (/^audio\//.test(type)) return 'audio'
  const extension = extname(fileName).slice(1).toLowerCase()
  if (['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', '3ds', 'vrml', 'wrl', 'step', 'stp'].includes(extension)) return 'model'
  if (['html', 'htm'].includes(extension)) return 'html'
  if (['md', 'markdown'].includes(extension)) return 'markdown'
  if (['txt', 'log', 'csv', 'json', 'xml', 'yaml', 'yml'].includes(extension)) return 'text-file'
  return 'file'
}

function fileCardSvg(name, bytes) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="440" viewBox="0 0 640 440"><defs><linearGradient id="base" x2="1" y2="1"><stop stop-color="#e0e8f5"/><stop offset="1" stop-color="#f4e9d7"/></linearGradient><radialGradient id="rose" cx="1" cy="0" r="1"><stop stop-color="#efe1ee"/><stop offset="1" stop-color="#efe1ee" stop-opacity="0"/></radialGradient><radialGradient id="sage" cx="0" cy="1" r="1"><stop stop-color="#e1efe9"/><stop offset="1" stop-color="#e1efe9" stop-opacity="0"/></radialGradient></defs><rect width="640" height="440" fill="url(#base)"/><rect width="640" height="440" fill="url(#rose)"/><rect width="640" height="440" fill="url(#sage)"/></svg>`)
}

async function readPublicUrl(url, signal) {
  signal?.throwIfAborted()
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new TypeError('asset_source.url cannot target a local host')
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new TypeError('asset_source.url must resolve only to public IP addresses')
  }
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise((resolvePromise, reject) => {
    const req = request(url, {
      method: 'GET',
      signal,
      headers: { accept: '*/*', 'user-agent': 'dsh-canvas/1' },
      lookup: (_host, options, callback) => {
        const address = addresses.find(item => !options.family || item.family === options.family)
        if (!address) return callback(new Error('No public address for URL host'))
        if (options.all) callback(null, addresses)
        else callback(null, address.address, address.family)
      },
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        reject(new Error(`asset_source.url returned HTTP ${response.statusCode}`))
        return
      }
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
        response.resume()
        reject(new TypeError(`Imported asset exceeds ${MAX_IMPORT_BYTES} bytes`))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_IMPORT_BYTES) {
          response.destroy(new TypeError(`Imported asset exceeds ${MAX_IMPORT_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolvePromise({ data: Buffer.concat(chunks), mimeType: response.headers['content-type'] }))
      response.on('error', reject)
    })
    req.setTimeout(15_000, () => req.destroy(new Error('asset_source.url timed out')))
    req.on('error', reject)
    req.end()
  })
}

function isPublicAddress(address) {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b))
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0))
  }
  if (family === 6) {
    const words = expandIpv6(address)
    if (!words) return false
    const first = Number.parseInt(words[0], 16)
    const second = Number.parseInt(words[1], 16)
    return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (second === 0 || second === 0x0db8))
  }
  return false
}

function expandIpv6(address) {
  const halves = address.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  return [...left, ...Array(missing).fill('0'), ...right]
}

function binaryStatStamp(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

function legacySegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function sanitizeSegment(value) {
  const segment = String(value)
  if (!segment) throw new TypeError('asset path segments must be non-empty strings')
  // Encode rather than replace: distinct board/asset ids must never share a
  // directory, and dots cannot overlap the asset/variant filename delimiter.
  return encodeURIComponent(segment).replace(/[.!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return {} }
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
    case 'convert': {
      if (!Array.isArray(operation.nodes) || !operation.nodes.length) throw new TypeError('convert requires a non-empty nodes array')
      for (const patch of operation.nodes) {
        if (!patch || typeof patch.id !== 'string' || typeof patch.type !== 'string' || !patch.type.trim()) {
          throw new TypeError('convert requires node id and target type')
        }
        const index = document.nodes.findIndex(node => node.id === patch.id)
        if (index === -1) throw new TypeError(`node not found for convert: ${patch.id}`)
        const current = document.nodes[index]
        const geometry = Object.fromEntries(['x', 'y', 'width', 'height', 'rotation', 'zIndex', 'locked', 'visible', 'parentId']
          .filter(key => current[key] !== undefined).map(key => [key, current[key]]))
        document.nodes[index] = normalizeNode({
          ...geometry, ...patch, id: current.id, typeVersion: patch.typeVersion ?? 1, props: patch.props ?? {},
        })
        collector.updatedNodeIds.push(current.id)
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
      if (Array.isArray(document.metadata?.connections)) {
        document.metadata.connections = document.metadata.connections.filter(edge => edge && !targets.has(edge.source) && !targets.has(edge.target))
      }
      break
    }
    case 'create_connections':
    case 'update_connections': {
      if (!Array.isArray(operation.connections) || !operation.connections.length) throw new TypeError(`${operation.type} requires a non-empty connections array`)
      const edges = clone(document.metadata?.connections || [])
      for (const input of operation.connections) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('connection must be an object')
        for (const key of Object.keys(input)) {
          if (!['id', 'source', 'target'].includes(key)) throw new TypeError(`unsupported connection field: ${key}`)
        }
        const creating = operation.type === 'create_connections'
        const id = creating && input.id === undefined ? randomUUID() : connectionId(input.id)
        const index = edges.findIndex(edge => edge.id === id)
        if (creating && index !== -1) throw new TypeError(`connection already exists: ${id}`)
        if (!creating && index === -1) throw new TypeError(`connection not found: ${id}`)
        const edge = { ...(creating ? {} : edges[index]), ...input, id }
        if (creating) edges.push(edge)
        else edges[index] = edge
      }
      document.metadata = { ...document.metadata, connections: edges }
      validateConnections(document)
      break
    }
    case 'delete_connections': {
      if (!Array.isArray(operation.connectionIds) || !operation.connectionIds.length) throw new TypeError('delete_connections requires a non-empty connectionIds array')
      const targets = new Set(operation.connectionIds.map(connectionId))
      const edges = document.metadata?.connections || []
      for (const id of targets) {
        if (!edges.some(edge => edge.id === id)) throw new TypeError(`connection not found: ${id}`)
      }
      document.metadata = { ...document.metadata, connections: edges.filter(edge => !targets.has(edge.id)) }
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

function connectionId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('connection id must be a non-empty string')
  return value
}

function validateConnections(document) {
  const edges = document.metadata?.connections
  if (edges === undefined) return
  if (!Array.isArray(edges)) throw new TypeError('metadata.connections must be an array')
  const nodes = new Set(document.nodes.map(node => node.id))
  const ids = new Set(), pairs = new Set()
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new TypeError('connection must be an object')
    const id = connectionId(edge.id)
    if (ids.has(id)) throw new TypeError(`duplicate connection id: ${id}`)
    ids.add(id)
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new TypeError(`connection ${id} endpoints must reference existing nodes`)
    if (edge.source === edge.target) throw new TypeError(`connection ${id} cannot link a node to itself`)
    const pair = JSON.stringify([edge.source, edge.target])
    if (pairs.has(pair)) throw new TypeError(`duplicate connection direction: ${edge.source} -> ${edge.target}`)
    pairs.add(pair)
  }
}

function validateDocument(document) {
  validateConnections(document)
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
