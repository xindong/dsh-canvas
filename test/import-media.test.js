import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasService } from '../lib/index.js'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-import-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = Object.create(CanvasService.prototype)
  let document = { schemaVersion: 1, revision: 0, nodes: [], assets: [], viewport: { scale: 1, offset: { x: 0, y: 0 } } }
  const tools = new Map(), changes = []
  Object.assign(service, {
    root,
    assetsRoot: join(root, 'assets'),
    metaRoot: join(root, 'meta'),
    queues: new Map(),
    listeners: new Map(),
    allListeners: new Set(),
    focusRequests: new Map(),
    binaryVersions: new Map(),
    mediaProcessor: options.mediaProcessor,
  })
  service.load = async () => document
  service.persist = async (_id, next) => { document = structuredClone(next) }
  service.emit = (_id, change) => changes.push(change)
  service.ctx = { tools: { register: tool => tools.set(tool.name, tool) } }
  service.registerTools()
  const write = args => tools.get('canvas_write').execute(
    { board_id: 'board', ...args },
    { signal: new AbortController().signal },
  )
  return { root, service, write, changes, getDocument: () => document }
}

function imageProbe(width = 1200, height = 600) {
  return async ({ kind }) => kind === 'image' ? { width, height, displayWidth: width, displayHeight: height } : {}
}

test('image import derives node ratio and honors one explicit dimension', async t => {
  const { root, write, getDocument } = await fixture(t, { mediaProcessor: { probe: imageProbe() } })
  const imagePath = join(root, 'wide.png')
  await writeFile(imagePath, PNG_1X1)

  const result = await write({ operations: [{
    type: 'create',
    nodes: [
      { id: 'auto', type: 'image', asset_source: { path: imagePath } },
      { id: 'sized', type: 'image', width: 640, asset_source: { path: imagePath } },
    ],
  }] })
  const auto = result.document.nodes.find(node => node.id === 'auto')
  const sized = result.document.nodes.find(node => node.id === 'sized')

  assert.deepEqual({ width: auto.width, height: auto.height }, { width: 320, height: 160 })
  assert.deepEqual({ width: sized.width, height: sized.height }, { width: 640, height: 320 })
  assert.deepEqual(auto.assetRefs.primary, { assetId: auto.assetRefs.primary.assetId, variant: 'original' })
  assert.equal(auto.assetRefs.preview, undefined)
  assert.equal(auto.props.mediaAutoSize, true)
  assert.deepEqual(auto.props.mediaAutoSizeBaseline, { width: 320, height: 160 })
  assert.equal(sized.props.mediaAutoSize, false)
  assert.equal(Object.hasOwn(sized.props, 'mediaAutoSizeBaseline'), false)
  assert.deepEqual({ width: auto.props.intrinsicWidth, height: auto.props.intrinsicHeight }, { width: 1200, height: 600 })
  assert.equal(getDocument().assets.length, 2)
  for (const asset of getDocument().assets) {
    assert.equal(asset.metadata.media.status, 'pending')
    assert.deepEqual(
      { width: asset.metadata.media.width, height: asset.metadata.media.height },
      { width: 1200, height: 600 },
    )
  }
})

test('media publish backfills legacy hashes, rejects stale hashes, and preserves layout', async t => {
  const { root, service, write, getDocument } = await fixture(t, { mediaProcessor: { probe: imageProbe(2, 1) } })
  const imagePath = join(root, 'layout.png')
  await writeFile(imagePath, PNG_1X1)
  const created = await write({ operations: [{
    type: 'create',
    nodes: [{ id: 'image', type: 'image', width: 640, height: 480, asset_source: { path: imagePath } }],
  }] })
  const assetId = created.document.nodes[0].assetRefs.primary.assetId
  const asset = getDocument().assets[0]
  const baselineRevision = getDocument().revision
  const binaryPath = service.assetPath('board', assetId, 'original')

  delete asset.metadata.contentHash
  await rm(`${binaryPath}.meta.json`, { force: true })
  const bytes = await readFile(binaryPath)
  const expectedHash = createHash('sha256').update(bytes).digest('hex')

  const stale = await service.publishMedia('board', {
    assetId, contentHash: '0'.repeat(64), media: { status: 'ready', width: 3000, height: 1000 },
  })
  assert.deepEqual(stale, { applied: false })
  assert.equal(getDocument().revision, baselineRevision)
  assert.equal(getDocument().nodes[0].width, 640)

  const published = await service.publishMedia('board', {
    assetId, media: { status: 'ready', width: 3000, height: 1000 },
  })
  const node = published.document.nodes[0]
  assert.equal(published.applied, true)
  assert.equal(published.contentHash, expectedHash)
  assert.equal(published.asset.metadata.contentHash, expectedHash)
  assert.equal(published.asset.metadata.media.contentHash, expectedHash)
  assert.equal(node.props.mediaContentHash, expectedHash)
  assert.equal(node.props.mediaPreparationStatus, 'ready')
  assert.deepEqual({ width: node.width, height: node.height }, { width: 640, height: 480 })
  assert.deepEqual({ width: node.props.intrinsicWidth, height: node.props.intrinsicHeight }, { width: 3000, height: 1000 })
  assert.equal(Object.hasOwn(published.nodePatches[0], 'width'), false)
  assert.equal(Object.hasOwn(published.nodePatches[0], 'height'), false)
})

test('document import keeps the original primary reference while preview is pending', async t => {
  const { root, write } = await fixture(t)
  const documentPath = join(root, 'README.md')
  await writeFile(documentPath, '# README\n\nDocument body.\n')

  const result = await write({ operations: [{
    type: 'create',
    nodes: [{ id: 'document', type: 'markdown', asset_source: { path: documentPath } }],
  }] })
  const node = result.document.nodes[0]
  const asset = result.document.assets[0]

  assert.equal(asset.kind, 'markdown')
  assert.deepEqual(node.assetRefs.primary, { assetId: asset.id, variant: 'original' })
  assert.deepEqual(node.assetRefs.preview, { assetId: asset.id, variant: 'preview' })
  assert.equal(node.props.previewStatus, 'pending')
  assert.equal(typeof node.props.previewRequestId, 'string')
  assert.ok(node.props.previewRequestId.length > 0)
  assert.equal(node.props.previewJobId, null)
  assert.equal(node.props.previewError, null)
  assert.deepEqual(node.props.previewSpec, { width: 1024, height: 704, page: 1, mode: 'viewport', quality: 'thumbnail' })
  assert.equal(asset.metadata.relativePath, 'README.md')
  assert.equal(asset.metadata.contentHash, createHash('sha256').update(await readFile(documentPath)).digest('hex'))
})

test('path document import recursively stores same-package attachments inside root_path', async t => {
  const { root, service, write, getDocument } = await fixture(t, {
    mediaProcessor: { probe: imageProbe(1200, 600) },
  })
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await mkdir(join(docs, 'styles'), { recursive: true })
  await writeFile(join(root, 'outside.png'), PNG_1X1)
  await writeFile(join(docs, 'guide.md'), [
    '# Guide',
    '',
    '![Logo](img/logo.png)',
    '<link rel="stylesheet" href="styles/guide.css">',
    '![Outside](../../outside.png)',
  ].join('\n'))
  await writeFile(join(docs, 'img', 'logo.png'), PNG_1X1)
  await writeFile(join(docs, 'styles', 'guide.css'), 'body { background-image: url("../img/background.png"); }\n')
  await writeFile(join(docs, 'img', 'background.png'), PNG_1X1)

  const result = await write({ operations: [{
    type: 'create',
    nodes: [{
      id: 'guide',
      type: 'markdown',
      asset_source: {
        path: join(docs, 'guide.md'),
        root_path: project,
        relative_path: 'docs/guide.md',
      },
    }],
  }] })
  const node = result.document.nodes[0]
  const source = result.document.assets.find(asset => asset.id === node.assetRefs.primary.assetId)
  const resources = result.document.assets.filter(asset => asset.id !== source.id)
  const byPath = new Map(resources.map(asset => [asset.metadata.relativePath, asset]))

  assert.equal(source.metadata.relativePath, 'docs/guide.md')
  assert.equal(source.metadata.sourceType, 'path')
  assert.equal(resources.length, 3)
  assert.deepEqual([...byPath.keys()].sort(), [
    'docs/img/background.png',
    'docs/img/logo.png',
    'docs/styles/guide.css',
  ])
  assert.equal(byPath.has('outside.png'), false)
  assert.equal(byPath.has('docs/outside.png'), false)
  for (const asset of resources) {
    assert.equal(asset.metadata.sourcePackage, source.metadata.sourcePackage)
    assert.equal(asset.metadata.resourceFor, source.id)
    assert.equal(asset.metadata.sourceType, 'path')
    assert.equal(asset.metadata.contentHash, createHash('sha256')
      .update(await readFile(join(project, ...asset.metadata.relativePath.split('/')))).digest('hex'))
    assert.ok(await service.getBinary('board', asset.id, 'original'))
  }
  assert.equal(node.props.previewStatus, 'pending')
  assert.equal(getDocument().assets.length, 4)
})

test('document import ignores navigation targets and keeps loaded resources', async t => {
  const { root, write } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await writeFile(join(docs, 'guide.md'), [
    '# Guide',
    '',
    '![Inline](img/inline.png)',
    '[Ordinary link](page.md)',
    '[Reference link][docs]',
    '![Reference image][logo]',
    '<a href="page.md">HTML link</a>',
    '<form action="submit"></form>',
    '<link rel="stylesheet" href="styles.css">',
    '<style>main { background-image: url(img/background.png); }</style>',
    '',
    '[docs]: page.md',
    '[logo]: img/logo.png',
  ].join('\n'))
  await writeFile(join(docs, 'guide.html'), [
    '<link rel="stylesheet" href="styles.css">',
    '<script src="app.js"></script>',
    '<img src="img/html.png">',
    '<img srcset="data:image/png;base64,AAAA 1x, img/srcset.png 2x">',
    '<a href="page.md">HTML link</a>',
    '<form action="submit"></form>',
  ].join('\n'))
  for (const path of ['page.md', 'submit', 'styles.css', 'app.js', 'img/inline.png', 'img/logo.png', 'img/background.png', 'img/html.png', 'img/srcset.png']) {
    await writeFile(join(docs, ...path.split('/')), PNG_1X1)
  }

  const result = await write({ operations: [{
    type: 'create',
    nodes: [
      { id: 'markdown', type: 'markdown', asset_source: { path: join(docs, 'guide.md'), root_path: project, relative_path: 'docs/guide.md' } },
      { id: 'html', type: 'html', asset_source: { path: join(docs, 'guide.html'), root_path: project, relative_path: 'docs/guide.html' } },
    ],
  }] })
  const sourceIds = new Map(result.document.nodes.map(node => [node.id, node.assetRefs.primary.assetId]))
  const resources = id => result.document.assets
    .filter(asset => asset.metadata.resourceFor === sourceIds.get(id))
    .map(asset => asset.metadata.relativePath)
    .sort()

  assert.deepEqual(resources('markdown'), [
    'docs/img/background.png',
    'docs/img/inline.png',
    'docs/img/logo.png',
    'docs/styles.css',
  ])
  assert.deepEqual(resources('html'), [
    'docs/app.js',
    'docs/img/html.png',
    'docs/img/srcset.png',
    'docs/styles.css',
  ])
})

test('URL document resources allow only same-origin absolute and protocol-relative attachments', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    const isCss = relativePath.endsWith('.css')
    return {
      data: Buffer.from(isCss ? 'body {}' : 'resource'),
      fileName: relativePath.split('/').pop(),
      mimeType: isCss ? 'text/css' : 'application/octet-stream',
      text: isCss ? 'body {}' : 'resource',
      sourceUrl: task.url,
    }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url',
    documentUrl: 'https://cdn.example.test/docs/guide.html',
    relativePath: 'guide.html',
    physicalFileName: 'guide.html',
    sourcePackage: 'package',
    data: Buffer.from([
      '<link rel="stylesheet" href="https://cdn.example.test/styles.css">',
      '<img src="https://cdn.example.test/assets/absolute.png">',
      '<img src="//cdn.example.test/assets/protocol.png">',
      '<img src="https://other.example.test/assets/foreign.png">',
      '<a href="https://cdn.example.test/page.html">Page</a>',
      '<form action="//cdn.example.test/submit"></form>',
    ].join('\n')),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), [
    { url: 'https://cdn.example.test/assets/absolute.png', relativePath: 'assets/absolute.png' },
    { url: 'https://cdn.example.test/assets/protocol.png', relativePath: 'assets/protocol.png' },
    { url: 'https://cdn.example.test/styles.css', relativePath: 'styles.css' },
  ])
})

test('intrinsic fitting keeps rounded dimensions at least one pixel', async t => {
  const { service } = await fixture(t)
  const imported = {
    assetId: 'image', fileName: 'strip.png', mimeType: 'image/png', kind: 'image', size: PNG_1X1.length,
    intrinsicWidth: 10_000, intrinsicHeight: 1,
  }

  const horizontal = service.createImportedNode(imported)
  const vertical = service.createImportedNode({ ...imported, intrinsicWidth: 1, intrinsicHeight: 10_000 })

  assert.deepEqual({ width: horizontal.width, height: horizontal.height }, { width: 320, height: 1 })
  assert.deepEqual({ width: vertical.width, height: vertical.height }, { width: 1, height: 320 })
})

test('media publish prefers display dimensions when updating intrinsic ratio', async t => {
  const { root, service, write } = await fixture(t, { mediaProcessor: { probe: imageProbe(1200, 600) } })
  const imagePath = join(root, 'auto.png')
  await writeFile(imagePath, PNG_1X1)
  const created = await write({ operations: [{
    type: 'create', nodes: [{ id: 'auto', type: 'image', asset_source: { path: imagePath } }],
  }] })
  const assetId = created.document.nodes[0].assetRefs.primary.assetId

  const published = await service.publishMedia('board', {
    assetId,
    media: { status: 'ready', width: 3000, height: 1000, displayWidth: 600, displayHeight: 200 },
  })
  const node = published.document.nodes[0]

  assert.deepEqual({ width: node.props.intrinsicWidth, height: node.props.intrinsicHeight }, { width: 600, height: 200 })
  assert.deepEqual({ width: node.width, height: node.height }, { width: 320, height: 107 })
  assert.deepEqual(node.props.mediaAutoSizeBaseline, { width: 320, height: 107 })
})

test('audio import defaults to 320x96 while preserving explicit dimensions', async t => {
  const { service } = await fixture(t)
  const imported = {
    assetId: 'audio', fileName: 'track.mp3', mimeType: 'audio/mpeg', kind: 'audio', size: 128,
  }

  const auto = service.createImportedNode(imported)
  const sized = service.createImportedNode(imported, { node: { width: 480, height: 120 } })

  assert.deepEqual({ width: auto.width, height: auto.height }, { width: 320, height: 96 })
  assert.deepEqual({ width: sized.width, height: sized.height }, { width: 480, height: 120 })
})
