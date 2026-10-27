import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

test('pending and error media publications preserve current derivatives only for the same source', async t => {
  const { service, write, getDocument } = await fixture(t, { mediaProcessor: { probe: imageProbe(2, 1) } })
  await write({ operations: [{ type: 'create', nodes: [{
    id: 'video', type: 'video', width: 320, height: 180,
  }] }] })
  const assetId = 'video-asset'
  const originalHash = createHash('sha256').update('source-one').digest('hex')
  const previousVariant = `preview-${createHash('sha256').update('poster-one').digest('hex')}`
  const currentVariant = `preview-${createHash('sha256').update('poster-current').digest('hex')}`
  getDocument().assets.push({
    id: assetId,
    kind: 'video',
    metadata: {
      contentHash: originalHash,
      media: { contentHash: originalHash, status: 'ready', width: 1920, height: 1080 },
      derivatives: { poster: { variant: previousVariant, contentHash: 'a'.repeat(64), mimeType: 'image/webp' } },
    },
  })
  getDocument().nodes[0].assetRefs = {
    primary: { assetId, variant: 'original' },
    poster: { assetId, variant: currentVariant },
  }
  getDocument().nodes[0].props.mediaContentHash = originalHash
  await service.putBinary('board', assetId, 'original', Buffer.from('source-one'), { mimeType: 'video/mp4' })

  const pending = await service.publishMedia('board', {
    assetId, contentHash: originalHash,
    media: { status: 'pending', width: 1920, height: 1080 },
    preserveCurrentDerivatives: true,
    derivatives: {},
  })
  assert.equal(pending.applied, true)
  assert.deepEqual(pending.document.nodes.find(node => node.id === 'video').assetRefs.poster, { assetId, variant: currentVariant })
  assert.deepEqual(pending.asset.metadata.derivatives.poster.variant, previousVariant)

  const explicitVariant = `preview-${createHash('sha256').update('poster-two').digest('hex')}`
  const replaced = await service.publishMedia('board', {
    assetId, contentHash: originalHash,
    media: { status: 'error', error: 'poster unavailable' },
    preserveCurrentDerivatives: true,
    derivatives: { poster: { variant: explicitVariant, contentHash: 'b'.repeat(64), mimeType: 'image/webp' } },
  })
  const replacedNode = replaced.document.nodes.find(node => node.id === 'video')
  assert.deepEqual(replacedNode.assetRefs.poster, { assetId, variant: explicitVariant })
  assert.deepEqual(replaced.asset.metadata.derivatives.poster.variant, explicitVariant)

  const ready = await service.publishMedia('board', {
    assetId, contentHash: originalHash,
    media: { status: 'ready', width: 1920, height: 1080 },
    preserveCurrentDerivatives: true,
    derivatives: {},
  })
  assert.equal(ready.document.nodes.find(node => node.id === 'video').assetRefs.poster, undefined)
  assert.deepEqual(ready.asset.metadata.derivatives, {})

  getDocument().assets.find(asset => asset.id === assetId).metadata = {
    contentHash: originalHash,
    media: { contentHash: originalHash, status: 'ready', width: 1920, height: 1080 },
    derivatives: { poster: { variant: previousVariant, contentHash: 'a'.repeat(64), mimeType: 'image/webp' } },
  }
  getDocument().nodes[0].assetRefs.poster = { assetId, variant: currentVariant }
  getDocument().nodes[0].props.mediaContentHash = 'f'.repeat(64)
  const conflictingNode = await service.publishMedia('board', {
    assetId, contentHash: originalHash,
    media: { status: 'pending', width: 1920, height: 1080 },
    preserveCurrentDerivatives: true,
  })
  assert.deepEqual(conflictingNode.document.nodes.find(node => node.id === 'video').assetRefs.poster,
    { assetId, variant: previousVariant })

  getDocument().assets.find(asset => asset.id === assetId).metadata = {
    contentHash: originalHash,
    media: { contentHash: originalHash, status: 'ready', width: 1920, height: 1080 },
    derivatives: { poster: { variant: previousVariant, contentHash: 'a'.repeat(64), mimeType: 'image/webp' } },
  }
  const nextHash = createHash('sha256').update('source-two').digest('hex')
  await service.putBinary('board', assetId, 'original', Buffer.from('source-two'), { mimeType: 'video/mp4' })
  delete getDocument().nodes[0].props.mediaContentHash
  const replacedSource = await service.publishMedia('board', {
    assetId, contentHash: nextHash,
    media: { status: 'pending', width: 1280, height: 720 },
    preserveCurrentDerivatives: true,
  })
  assert.equal(replacedSource.document.nodes.find(node => node.id === 'video').assetRefs.poster, undefined)
  assert.deepEqual(replacedSource.asset.metadata.derivatives, {})
})

test('legacy error publications prefer a current derivative and fall back to previous when absent', async t => {
  const { service, write, getDocument } = await fixture(t)
  await write({ operations: [{ type: 'create', nodes: [{ id: 'video', type: 'video', width: 320, height: 180 }] }] })
  const assetId = 'video-asset'
  const contentHash = createHash('sha256').update('legacy-source').digest('hex')
  const previousVariant = `preview-${'4'.repeat(64)}`
  const currentNodeVariant = `preview-${'5'.repeat(64)}`
  getDocument().assets.push({
    id: assetId,
    kind: 'video',
    metadata: {
      contentHash,
      media: { contentHash, status: 'ready', width: 1920, height: 1080 },
      derivatives: { poster: { variant: previousVariant, contentHash: '6'.repeat(64), mimeType: 'image/webp' } },
    },
  })
  getDocument().nodes[0].assetRefs = {
    primary: { assetId, variant: 'original' },
    poster: { assetId, variant: currentNodeVariant },
  }
  getDocument().nodes[0].props.mediaContentHash = contentHash
  await service.putBinary('board', assetId, 'original', Buffer.from('legacy-source'), { mimeType: 'video/mp4' })

  const published = await service.publishMedia('board', {
    assetId, contentHash,
    media: { status: 'error', error: 'poster unavailable' },
  })

  assert.deepEqual(published.document.nodes[0].assetRefs.poster, { assetId, variant: currentNodeVariant })
  assert.deepEqual(published.asset.metadata.derivatives.poster, {
    variant: previousVariant, contentHash: '6'.repeat(64), mimeType: 'image/webp',
  })

  delete getDocument().nodes[0].assetRefs.poster
  const fallback = await service.publishMedia('board', {
    assetId, contentHash,
    media: { status: 'error', error: 'poster unavailable' },
  })
  assert.deepEqual(fallback.document.nodes[0].assetRefs.poster, { assetId, variant: previousVariant })

  getDocument().assets.find(asset => asset.id === assetId).metadata.derivatives = {
    poster: { variant: previousVariant, contentHash: '6'.repeat(64), mimeType: 'image/webp' },
  }
  getDocument().nodes[0].assetRefs.poster = { assetId, variant: currentNodeVariant }
  const explicitVariant = `preview-${'7'.repeat(64)}`
  const explicit = await service.publishMedia('board', {
    assetId, contentHash,
    media: { status: 'error', error: 'poster unavailable' },
    derivatives: { poster: { variant: explicitVariant, contentHash: '8'.repeat(64), mimeType: 'image/webp' } },
  })
  assert.deepEqual(explicit.document.nodes[0].assetRefs.poster, { assetId, variant: explicitVariant })
  assert.deepEqual(explicit.asset.metadata.derivatives.poster.variant, explicitVariant)

  const removed = await service.publishMedia('board', {
    assetId, contentHash,
    media: { status: 'error', error: 'poster removed' },
    derivatives: { poster: null },
  })
  assert.equal(removed.document.nodes[0].assetRefs.poster, undefined)
  assert.equal(removed.asset.metadata.derivatives.poster, null)
})

test('concurrent media publications preserve derivatives newest node state without resurrecting stale refs', async t => {
  const { service, write, getDocument } = await fixture(t)
  await write({ operations: [{ type: 'create', nodes: [{ id: 'audio', type: 'audio', width: 320, height: 96 }] }] })
  const assetId = 'audio-asset'
  const hash = createHash('sha256').update('audio-source').digest('hex')
  const oldVariant = `preview-${'1'.repeat(64)}`
  const newVariant = `preview-${'2'.repeat(64)}`
  getDocument().assets.push({
    id: assetId,
    kind: 'audio',
    metadata: {
      contentHash: hash,
      media: { contentHash: hash, status: 'ready', duration: 10 },
      derivatives: { waveform: { variant: oldVariant, contentHash: '3'.repeat(64), mimeType: 'image/webp' } },
    },
  })
  getDocument().nodes[0].assetRefs = {
    primary: { assetId, variant: 'original' },
    waveform: { assetId, variant: oldVariant },
  }
  getDocument().nodes[0].props.mediaContentHash = hash
  await service.putBinary('board', assetId, 'original', Buffer.from('audio-source'), { mimeType: 'audio/mpeg' })

  let release
  const gate = new Promise(resolvePromise => { release = resolvePromise })
  const blocker = service.enqueue('board', () => gate)
  const nodeUpdate = service.write('board', {
    operations: [{ type: 'update', nodes: [{
      id: 'audio', width: 640,
      assetRefs: { primary: { assetId, variant: 'original' }, waveform: { assetId, variant: newVariant } },
    }] }],
  })
  const queuedPublication = service.publishMedia('board', {
    assetId, contentHash: hash,
    media: { status: 'pending', duration: 10 },
    preserveCurrentDerivatives: true,
  })
  release()
  await blocker
  const [updated, published] = await Promise.all([nodeUpdate, queuedPublication])
  const publishedNode = published.document.nodes[0]
  const finalNode = getDocument().nodes[0]

  assert.equal(updated.revision < published.revision, true)
  assert.equal(publishedNode.props.mediaContentHash, hash)
  assert.equal(finalNode.props.mediaContentHash, hash)
  assert.equal(publishedNode.width, 640)
  assert.deepEqual(publishedNode.assetRefs.waveform, { assetId, variant: newVariant })
  assert.deepEqual(finalNode.assetRefs.waveform, { assetId, variant: newVariant })
  assert.deepEqual(getDocument().assets.find(asset => asset.id === assetId).metadata.derivatives.waveform.variant, oldVariant)
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

test('path HTML import follows nested and cyclic JavaScript modules, inline modules, and root boundaries', async t => {
  const { root, write, getDocument } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  const modules = join(docs, 'modules')
  await mkdir(modules, { recursive: true })
  await writeFile(join(root, 'outside-html.js'), 'export const outside = true')
  await writeFile(join(root, 'outside-escape.js'), 'export const escaped = true')
  await symlink(join(root, 'outside-escape.js'), join(modules, 'escape.js'))
  await writeFile(join(project, 'outside.js'), 'export const insideRoot = true')
  await writeFile(join(docs, 'guide.html'), [
    '<script type="module" src="app.mjs"></script>',
    '<script src="classic.js"></script>',
    '<script src="../../outside-html.js"></script>',
    '<script type="module">',
    "  import './inline.js?version=1#entry'",
    "  export * from './inline-export.js'",
    "  import('./inline-dynamic.mjs')",
    "  import(`./inline-template.mjs`)",
    "  import(`./inline-${name}.mjs`)",
    "  import 'bare-package'",
    '</script>',
  ].join('\n'))
  await writeFile(join(docs, 'app.mjs'), [
    "import '../outside.js'",
    "import './modules/cycle-a.js'",
    "import './modules/escape.js'",
    "import './modules/definitely-missing.js'",
    "export { value } from './modules/reexport.js'",
    "export * from './modules/reexport-star.js'",
    "import('./modules/dynamic.js')",
    'import(`./modules/template.mjs`)',
    'import(`./modules/${name}.js`)',
    "import '../../outside.js'",
    "import 'another-package'",
  ].join('\n'))
  await writeFile(join(docs, 'classic.js'), 'window.classic = true')
  await writeFile(join(docs, 'inline.js'), "import './inline-nested.js'")
  await writeFile(join(docs, 'inline-nested.js'), 'export const nested = true')
  await writeFile(join(docs, 'inline-export.js'), 'export const inlineExport = true')
  await writeFile(join(docs, 'inline-dynamic.mjs'), 'export const inlineDynamic = true')
  await writeFile(join(docs, 'inline-template.mjs'), 'export const inlineTemplate = true')
  await writeFile(join(modules, 'cycle-a.js'), "import './cycle-b.js'")
  await writeFile(join(modules, 'cycle-b.js'), "import './cycle-a.js'\nimport '../app.mjs'")
  await writeFile(join(modules, 'reexport.js'), 'export const value = 1')
  await writeFile(join(modules, 'reexport-star.js'), 'export const star = 1')
  await writeFile(join(modules, 'dynamic.js'), 'export const dynamic = true')
  await writeFile(join(modules, 'template.mjs'), 'export const template = true')

  const result = await write({ operations: [{ type: 'create', nodes: [{
    id: 'html', type: 'html', asset_source: {
      path: join(docs, 'guide.html'), root_path: project, relative_path: 'docs/guide.html',
    },
  }] }] })
  const sourceId = result.document.nodes[0].assetRefs.primary.assetId
  const resources = result.document.assets.filter(asset => asset.metadata.resourceFor === sourceId)
    .map(asset => asset.metadata.relativePath).sort()

  assert.deepEqual(resources, [
    'docs/app.mjs',
    'docs/classic.js',
    'docs/inline-dynamic.mjs',
    'docs/inline-export.js',
    'docs/inline-nested.js',
    'docs/inline-template.mjs',
    'docs/inline.js',
    'docs/modules/cycle-a.js',
    'docs/modules/cycle-b.js',
    'docs/modules/dynamic.js',
    'docs/modules/reexport-star.js',
    'docs/modules/reexport.js',
    'docs/modules/template.mjs',
    'outside.js',
  ])
  assert.equal(new Set(resources).size, resources.length)
  assert.equal(getDocument().assets.some(asset => /outside-(html|escape)\.js$/.test(asset.metadata.relativePath || '')), false)
})

test('URL JavaScript imports stay same-origin, resolve against each module, and deduplicate cycles', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    let text = 'export const value = true'
    if (relativePath === 'docs/app') {
      text = [
        "import './dep.mjs'",
        "import '/shared.js'",
        "import 'https://other.example.test/foreign.js'",
        "export * from './dep.mjs'",
      ].join('\n')
    } else if (relativePath === 'docs/dep.mjs') {
      text = "import './app'\nimport './leaf.js?version=1'\nimport './leaf.js?version=2'"
    }
    const mimeType = relativePath.endsWith('.mjs') || relativePath === 'docs/app' || relativePath === 'shared.js'
      ? 'application/javascript' : 'image/png'
    return { data: Buffer.from(text), fileName: relativePath.split('/').pop(), mimeType,
      text, sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from('<script type="module" src="app"></script>'),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests.map(request => request.url), [
    'https://cdn.example.test/docs/app',
    'https://cdn.example.test/docs/dep.mjs',
    'https://cdn.example.test/shared.js',
    'https://cdn.example.test/docs/leaf.js?version=1',
    'https://cdn.example.test/docs/leaf.js?version=2',
  ])
  assert.deepEqual(requests.map(request => request.relativePath), [
    'docs/app', 'docs/dep.mjs', 'shared.js', 'docs/leaf.js', 'docs/leaf.js',
  ])
})

test('JavaScript MIME types follow modules with other extensions and cjs without overriding document extensions', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    const modules = new Map([
      ['docs/module.php', "import './mime-dep.js'\nimport './mime-nested.cjs'"],
      ['docs/mime-dep.js', "import './x-javascript-dep.js'"],
      ['docs/mime-nested.cjs', 'export const nested = true'],
      ['docs/x-javascript-dep.js', 'export const dep = true'],
    ])
    if (modules.has(relativePath)) {
      const text = modules.get(relativePath)
      const mimeType = relativePath.endsWith('.cjs') ? 'text/javascript'
        : relativePath === 'docs/module.php' ? 'application/x-javascript; charset=utf-8'
          : relativePath === 'docs/x-javascript-dep.js' ? 'text/x-javascript' : 'application/javascript'
      return { data: Buffer.from(text), fileName: relativePath.split('/').pop(), mimeType, text,
        sourceUrl: task.url, relativePath }
    }
    return { data: Buffer.from('<p>document</p>'), fileName: relativePath.split('/').pop(),
      mimeType: 'text/html', text: '<p>document</p>', sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from('<script type="module" src="module.php"></script>'),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests.map(request => request.relativePath), [
    'docs/module.php', 'docs/mime-dep.js', 'docs/mime-nested.cjs', 'docs/x-javascript-dep.js',
  ])

  requests.length = 0
  const misleadingMimeSource = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.css',
    relativePath: 'docs/index.css', physicalFileName: 'index.css', mimeType: 'text/html', sourcePackage: 'package',
    data: Buffer.from('@import "style-dep.css";'),
  }
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    return { data: Buffer.from('body {}'), fileName: relativePath.split('/').pop(), mimeType: 'application/javascript',
      text: 'body {}', sourceUrl: task.url, relativePath }
  }
  await service.importSourceResources('board', misleadingMimeSource, misleadingMimeSource.data.length, 'source')
  assert.deepEqual(requests.map(request => request.relativePath).sort(), ['docs/style-dep.css'])
})

test('local Markdown, HTML, and CSS decode URL paths once and enforce root boundaries', async t => {
  const { root, write } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await writeFile(join(root, 'outside.png'), PNG_1X1)
  await symlink(join(root, 'outside.png'), join(docs, 'img', 'escape link.png'))
  await writeFile(join(docs, 'guide.md'), [
    '![space](img/my%20logo.png?version=1#part)',
    '![unicode](img/caf%C3%A9.png)',
    '![percent](img/literal%2520name.png)',
    '![reserved](img/hash%23question%3F.png)',
    '![separator](img%2Fslash.png)',
    '![escape](..%2F..%2Foutside.png)',
    '![escape-backslash](..%5C..%5Coutside.png)',
    '![escape-dots](%2e%2e/%2e%2e/outside.png)',
    '![symlink](img/escape%20link.png)',
    '<img src="img/html%20image.png">',
    '<link rel="stylesheet" href="style%20sheet.css">',
  ].join('\n'))
  await writeFile(join(docs, 'style sheet.css'), 'body { background: url("img/css%20image.png?x=1#part") }')
  for (const path of ['my logo.png', 'café.png', 'literal%20name.png', 'hash#question?.png', 'slash.png', 'html image.png', 'css image.png']) {
    await writeFile(join(docs, 'img', path), PNG_1X1)
  }

  const result = await write({ operations: [{ type: 'create', nodes: [{
    id: 'guide', type: 'markdown', asset_source: { path: join(docs, 'guide.md'), root_path: project },
  }] }] })
  const sourceId = result.document.nodes[0].assetRefs.primary.assetId
  const resources = result.document.assets.filter(asset => asset.metadata.resourceFor === sourceId)
    .map(asset => asset.metadata.relativePath).sort()
  assert.deepEqual(resources, [
    'docs/img/café.png', 'docs/img/css image.png', 'docs/img/hash#question?.png', 'docs/img/html image.png',
    'docs/img/literal%20name.png', 'docs/img/my logo.png', 'docs/img/slash.png', 'docs/style sheet.css',
  ])
})

test('Markdown inline image destinations and quoted titles can contain closing parentheses', async t => {
  const { root, write } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await writeFile(join(docs, 'guide.md'), [
    '![angle](<img/a)b.png>)',
    '![angle-title](<img/a)b.png> "Version (large)")',
    '![quoted](img/b.png "Version (large)")',
    '![escaped-title](img/b.png "Version \\\"(large)\\\"")',
    "![single](img/c.png 'Version (large)')",
    '![paren-title](img/d.png (Version large))',
    '![broken](<img/missing.png)',
    '![next](img/e.png)',
  ].join('\n'))
  for (const name of ['a)b.png', 'b.png', 'c.png', 'd.png', 'e.png', 'missing.png']) {
    await writeFile(join(docs, 'img', name), PNG_1X1)
  }

  const result = await write({ operations: [{ type: 'create', nodes: [{
    id: 'guide', type: 'markdown', asset_source: { path: join(docs, 'guide.md'), root_path: project },
  }] }] })
  const sourceId = result.document.nodes[0].assetRefs.primary.assetId
  const resources = result.document.assets.filter(asset => asset.metadata.resourceFor === sourceId)
    .map(asset => asset.metadata.relativePath).sort()
  assert.deepEqual(resources, ['docs/img/a)b.png', 'docs/img/b.png', 'docs/img/c.png', 'docs/img/d.png', 'docs/img/e.png'])
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

test('document scanning stays linear under repeated unterminated URL, tag, and Markdown syntax', async t => {
  const { service } = await fixture(t)
  service.readDocumentResource = async ({ task, relativePath }) => {
    if (relativePath.endsWith('.css')) {
      return { data: Buffer.from('body {}'), fileName: 'guide.css', mimeType: 'text/css', text: 'body {}' }
    }
    return { data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'application/octet-stream', text: 'resource' }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const repeatedCss = 'url("a'.repeat(20_000)
  const repeatedTags = '<img src="'.repeat(20_000)
  const repeatedMarkdown = '!['.repeat(20_000)
  const repeatedMarkdownLabels = '!['.repeat(20_000) + ']'
  const repeatedMarkdownReferences = '![x][unclosed'.repeat(20_000) + ']'
  const repeatedMarkdownAngles = '![x](<unterminated'.repeat(20_000)
  const repeatedMarkdownTitles = '![x](image.png "unterminated'.repeat(20_000)
  const repeatedComments = '<!--'.repeat(20_000)
  const unterminatedQuotedTag = '<img title="<!--' + '<img '.repeat(20_000)
  const repeatedClosedComments = '<!--x-->'.repeat(20_000)
  const source = (relativePath, data, physicalFileName = relativePath) => ({
    sourceType: 'path', sourceRoot: '/unused', relativePath, physicalFileName,
    data: Buffer.from(data), sourcePackage: 'package',
  })

  const started = performance.now()
  const cssAssets = await service.importSourceResources('board', source('styles/guide.css', repeatedCss), repeatedCss.length, 'css')
  const htmlAssets = await service.importSourceResources('board', source('guide.html', `${repeatedTags}${repeatedComments}`), repeatedTags.length + repeatedComments.length, 'html')
  const markdownAssets = await service.importSourceResources('board', source('guide.md', repeatedMarkdown), repeatedMarkdown.length, 'markdown')
  const labelAssets = await service.importSourceResources('board', source('labels.md', repeatedMarkdownLabels), repeatedMarkdownLabels.length, 'labels')
  const referenceAssets = await service.importSourceResources('board', source('references.md', repeatedMarkdownReferences), repeatedMarkdownReferences.length, 'references')
  const angleAssets = await service.importSourceResources('board', source('angles.md', repeatedMarkdownAngles), repeatedMarkdownAngles.length, 'angles')
  const titleAssets = await service.importSourceResources('board', source('titles.md', repeatedMarkdownTitles), repeatedMarkdownTitles.length, 'titles')
  const quotedAssets = await service.importSourceResources('board', source('quoted.html', unterminatedQuotedTag), unterminatedQuotedTag.length, 'quoted')
  const commentAssets = await service.importSourceResources('board', source('comments.html', repeatedClosedComments), repeatedClosedComments.length, 'comments')
  const elapsed = performance.now() - started

  assert.deepEqual([cssAssets, htmlAssets, markdownAssets, labelAssets, referenceAssets, angleAssets, titleAssets, quotedAssets, commentAssets], [[], [], [], [], [], [], [], [], []])
  assert.ok(elapsed < 5_000, `repeated malformed syntax took ${elapsed.toFixed(0)}ms`)
})

test('HTML scanning skips script content but keeps its src, styles, srcset, and comments safe', async t => {
  const { root, write, getDocument } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await writeFile(join(docs, 'guide.html'), [
    '<script src="app.js">const image = "<img src=\\"hidden.png\\">"</script >',
    '<style>.hero { background: url("img/background.png") }</style>',
    '<img srcset="data:image/png;base64,AAAA 1x, img/srcset.png 2x" src="img/main.png">',
    '<!-- <img src="ignored.png"> --!> <img src="img/after-comment.png">',
    '<img src="/root.png">',
    '<a href="page.html">Navigation is not a resource</a>',
  ].join('\n'))
  for (const path of ['app.js', 'img/background.png', 'img/srcset.png', 'img/main.png', 'img/after-comment.png', 'root.png', 'page.html']) {
    await writeFile(join(docs, ...path.split('/')), PNG_1X1)
  }

  const result = await write({ operations: [{
    type: 'create',
    nodes: [{ id: 'html', type: 'html', asset_source: { path: join(docs, 'guide.html'), root_path: project, relative_path: 'docs/guide.html' } }],
  }] })
  const node = result.document.nodes[0]
  const resources = result.document.assets
    .filter(asset => asset.metadata.resourceFor === node.assetRefs.primary.assetId)
    .map(asset => asset.metadata.relativePath)
    .sort()

  assert.deepEqual(resources, [
    'docs/app.js',
    'docs/img/after-comment.png',
    'docs/img/background.png',
    'docs/img/main.png',
    'docs/img/srcset.png',
  ])
  assert.equal(getDocument().assets.some(asset => asset.metadata.relativePath.includes('hidden.png')), false)
  assert.equal(getDocument().assets.some(asset => asset.metadata.relativePath.includes('ignored.png')), false)
})

test('HTML comment markers inside quoted attributes do not hide resources or the document base', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push(task.url)
    return { data: Buffer.from('resource'), fileName: 'resource', mimeType: 'image/png',
      text: 'resource', sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({ asset: { metadata: input.metadata } })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from([
      '<img title="<!--" src="before.png">',
      '<base data-note="<!-- ignored -->" href="/static/">',
      "<img title='<!--' src='after.png'>",
      '<img title="<!-- still text -->" src="third.png">',
      '<!-- <img src="hidden.png"> --!>',
      '<img src="last.png">',
    ].join('\n')),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')
  assert.deepEqual(requests, ['before.png', 'after.png', 'third.png', 'last.png']
    .map(name => `https://cdn.example.test/static/${name}`))
})

test('HTML entities decode once and script/style raw text ends at the HTML end tag', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push(task.url)
    return { data: Buffer.from('resource'), fileName: 'resource', mimeType: 'image/png',
      text: 'resource', sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({ asset: { metadata: input.metadata } })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from([
      '<img src="one.png?x=1&amp;amp;y=2">',
      '<div style="background:url(two.png?x=1&amp;amp;y=2)"></div>',
      '<style>body{background:url(three.png?x=1&amp;y=2)}</style>',
      '<script>const s = "</script><img src="after-script.png">',
      '<style>/* </style><img src="after-style.png">',
    ].join('\n')),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')
  assert.deepEqual(requests, [
    'https://cdn.example.test/docs/one.png?x=1&amp;y=2',
    'https://cdn.example.test/docs/two.png?x=1&amp;y=2',
    'https://cdn.example.test/docs/three.png?x=1&amp;y=2',
    'https://cdn.example.test/docs/after-script.png',
    'https://cdn.example.test/docs/after-style.png',
  ])
})

test('Markdown image forms and HTML resource forms preserve their existing distinctions', async t => {
  const { root, write } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await mkdir(join(docs, 'media'), { recursive: true })
  await writeFile(join(docs, 'guide.md'), [
    '![Inline](img/inline.png "title")',
    '![Angle](<img/angle.png>)',
    '![Collapsed][]',
    '![Shortcut]',
    '![Reference][logo]',
    '[ordinary]: img/not-an-image.png',
    '[collapsed]: img/collapsed.png',
    '[shortcut]: img/shortcut.png',
    '[logo]: <img/logo.png>',
    '<video src="media/video.mp4" poster="media/poster.png"></video>',
    '<link rel="preload stylesheet" href="styles.css">',
    '<div style="background-image: url(img/style.png)"></div>',
  ].join('\n'))
  for (const path of [
    'img/inline.png', 'img/angle.png', 'img/collapsed.png', 'img/shortcut.png', 'img/logo.png',
    'media/video.mp4', 'media/poster.png', 'styles.css', 'img/style.png',
  ]) {
    await writeFile(join(docs, ...path.split('/')), PNG_1X1)
  }

  const result = await write({ operations: [{
    type: 'create',
    nodes: [{ id: 'markdown', type: 'markdown', asset_source: { path: join(docs, 'guide.md'), root_path: project, relative_path: 'docs/guide.md' } }],
  }] })
  const node = result.document.nodes[0]
  const resources = result.document.assets
    .filter(asset => asset.metadata.resourceFor === node.assetRefs.primary.assetId)
    .map(asset => asset.metadata.relativePath)
    .sort()

  assert.deepEqual(resources, [
    'docs/img/angle.png',
    'docs/img/collapsed.png',
    'docs/img/inline.png',
    'docs/img/logo.png',
    'docs/img/shortcut.png',
    'docs/img/style.png',
    'docs/media/poster.png',
    'docs/media/video.mp4',
    'docs/styles.css',
  ])
})

test('URL document import preserves root-relative paths and deduplicates by case-sensitive URL with query', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    return {
      data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'application/octet-stream',
      text: 'resource', sourceUrl: task.url, relativePath,
    }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/guide.html',
    relativePath: 'docs/guide.html', physicalFileName: 'guide.html', sourcePackage: 'package',
    data: Buffer.from([
      '<img src="../assets/Logo.png">',
      '<img src="../assets/logo.png">',
      '<img src="/styles.css">',
      ' <img src="styles.css">',
      '<img src="image.png?size=small">',
      '<img src="image.png?size=large">',
      '<img src="image.png">',
    ].join('\n')),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests.map(request => request.url).sort(), [
    'https://cdn.example.test/assets/Logo.png',
    'https://cdn.example.test/assets/logo.png',
    'https://cdn.example.test/docs/image.png',
    'https://cdn.example.test/docs/image.png?size=large',
    'https://cdn.example.test/docs/image.png?size=small',
    'https://cdn.example.test/docs/styles.css',
    'https://cdn.example.test/styles.css',
  ])
  assert.deepEqual(requests.map(request => request.relativePath).sort(), [
    'assets/Logo.png',
    'assets/logo.png',
    'docs/image.png',
    'docs/image.png',
    'docs/image.png',
    'docs/styles.css',
    'styles.css',
  ])
})

test('URL resource paths preserve encoded separators and percent signs without collisions', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    const text = relativePath.endsWith('.css') ? 'body {background:url("icon%2Fsmall.png")}' : 'resource'
    return { data: Buffer.from(text), fileName: relativePath.split('/').pop(),
      mimeType: relativePath.endsWith('.css') ? 'text/css' : 'image/png', text, sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({ asset: { metadata: input.metadata } })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from([
      '<img src="a%2Fb.png">', '<img src="a/b.png">',
      '<img src="a%5Cb.png">', '<img src="a%252Fb.png">',
      '<img src="bad%2F%FF.png">', '<img src="bad%252F%25FF.png">',
      '<img src="caf%C3%A9%20image.png">',
      '<link rel="stylesheet" href="styles%2Fmain.css">',
    ].join('\n')),
  }

  const assets = await service.importSourceResources('board', source, source.data.length, 'source')
  assert.deepEqual(requests.map(item => item.relativePath), [
    'docs/a%2Fb.png', 'docs/a/b.png', 'docs/a%5Cb.png', 'docs/a%252Fb.png',
    'docs/bad%2F%FF.png', 'docs/bad%252F%25FF.png',
    'docs/café image.png', 'docs/styles%2Fmain.css', 'docs/icon%2Fsmall.png',
  ])
  assert.deepEqual(assets.map(asset => asset.metadata.relativePath), requests.map(item => item.relativePath))
  assert.equal(assets[0].metadata.sourceUrl, 'https://cdn.example.test/docs/a%2Fb.png')
})

test('URL imports normalize and remove fragments before fetch and deduplication while preserving query', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push(task.url)
    return { data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'image/png',
      text: 'resource', sourceUrl: task.url, relativePath }
  }
  service.storeImportedAsset = async (_boardId, input) => ({ asset: { metadata: input.metadata } })
  const source = {
    sourceType: 'url', documentUrl: 'https://CDN.example.test:443/docs/index.html#entry',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from([
      '<img src="index.html#other">',
      '<img src="img.png#one">', '<img src="./img.png#two">',
      '<img src="https://CDN.example.test:443/docs/img.png">',
      '<img src="img.png?size=small#one">', '<img src="img.png?size=small#two">',
      '<img src="img.png?size=large#one">',
      ...Array.from({ length: 140 }, (_, index) => `<img src="img.png#alias${index}">`),
      '<img src="after-aliases.png">',
    ].join('\n')),
  }

  const assets = await service.importSourceResources('board', source, source.data.length, 'source')
  assert.deepEqual(requests, [
    'https://cdn.example.test/docs/img.png',
    'https://cdn.example.test/docs/img.png?size=small',
    'https://cdn.example.test/docs/img.png?size=large',
    'https://cdn.example.test/docs/after-aliases.png',
  ])
  assert.deepEqual(assets.map(asset => asset.metadata.sourceUrl), requests)
})

test('URL import rejects IPv6 6to4 tunnel destinations, including embedded private IPv4', async t => {
  const { service } = await fixture(t)
  for (const host of ['2002:c0a8:0101::1', '2002:7f00:1::1', '2002:0808:0808::1', '::ffff:127.0.0.1']) {
    await assert.rejects(service.readImportSource({ url: `http://[${host}]/file` }),
      /must resolve only to public IP addresses/)
  }
})

test('extensionless HTML and CSS use MIME types without losing nested attachments', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    if (relativePath === 'styles') {
      return {
        data: Buffer.from('@import "nested.css"; .hero { background: url("hero.png") }'),
        fileName: 'styles', mimeType: 'text/css; charset=utf-8', text: '@import "nested.css"; .hero { background: url("hero.png") }',
        sourceUrl: task.url, relativePath,
      }
    }
    return {
      data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'image/png',
      text: 'resource', sourceUrl: task.url, relativePath,
    }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/guide', relativePath: 'docs/guide',
    physicalFileName: 'guide', mimeType: 'text/html', sourcePackage: 'package',
    data: Buffer.from('<link rel="stylesheet" href="/styles?id=123"><img src="/logo">'),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests.map(request => request.url).sort(), [
    'https://cdn.example.test/hero.png',
    'https://cdn.example.test/logo',
    'https://cdn.example.test/nested.css',
    'https://cdn.example.test/styles?id=123',
  ])
})

test('HTML entities, base href, missing link rel, and root boundaries preserve existing semantics', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    return {
      data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'application/octet-stream',
      text: 'resource', sourceUrl: task.url, relativePath,
    }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from([
      '<base href="/static/?token=1&amp;x=2">',
      '<link href="ignored.css">',
      '<link rel="stylesheet" href="styles.css">',
      '<img src="logo.png?w=100&amp;h=200">',
      '<img src="/outside.png">',
      '<img src="https://other.example.test/foreign.png">',
    ].join('\n')),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests, [
    { url: 'https://cdn.example.test/static/styles.css', relativePath: 'static/styles.css' },
    { url: 'https://cdn.example.test/static/logo.png?w=100&h=200', relativePath: 'static/logo.png' },
    { url: 'https://cdn.example.test/outside.png', relativePath: 'outside.png' },
  ])
})

test('CSS attachments resolve against the stylesheet URL instead of an HTML base element', async t => {
  const { service } = await fixture(t)
  const requests = []
  service.readDocumentResource = async ({ task, relativePath }) => {
    requests.push({ url: task.url, relativePath })
    if (relativePath === 'site/styles.css') {
      const text = '<base href="/wrong/"> body { background-image: url("img.png"); }'
      return {
        data: Buffer.from(text), fileName: 'styles.css', mimeType: 'text/css', text,
        sourceUrl: task.url, relativePath,
      }
    }
    return {
      data: Buffer.from('resource'), fileName: relativePath.split('/').pop(), mimeType: 'image/png',
      text: 'resource', sourceUrl: task.url, relativePath,
    }
  }
  service.storeImportedAsset = async (_boardId, input) => ({
    asset: { id: input.metadata.relativePath, kind: 'file', metadata: input.metadata },
  })
  const source = {
    sourceType: 'url', documentUrl: 'https://cdn.example.test/docs/index.html',
    relativePath: 'docs/index.html', physicalFileName: 'index.html', sourcePackage: 'package',
    data: Buffer.from('<link rel="stylesheet" href="https://cdn.example.test/site/styles.css">'),
  }

  await service.importSourceResources('board', source, source.data.length, 'source')

  assert.deepEqual(requests, [
    { url: 'https://cdn.example.test/site/styles.css', relativePath: 'site/styles.css' },
    { url: 'https://cdn.example.test/site/img.png', relativePath: 'site/img.png' },
  ])
  assert.equal(requests.some(request => request.url === 'https://cdn.example.test/wrong/img.png'), false)
})

test('local document attachment identities remain case-sensitive and root-bounded', async t => {
  const { root, write } = await fixture(t)
  const project = join(root, 'project')
  const docs = join(project, 'docs')
  await mkdir(join(docs, 'img'), { recursive: true })
  await writeFile(join(docs, 'guide.md'), [
    '![Upper](img/Logo.png)',
    '![Lower](img/logo.png)',
    '<img src="/img/Logo.png">',
    '<link rel="stylesheet" href="less.css">',
    '<link href="no-rel.css">',
  ].join('\n'))
  for (const path of ['img/Logo.png', 'img/logo.png', 'less.css']) {
    await writeFile(join(docs, ...path.split('/')), PNG_1X1)
  }

  const result = await write({ operations: [{
    type: 'create',
    nodes: [{ id: 'guide', type: 'markdown', asset_source: { path: join(docs, 'guide.md'), root_path: project, relative_path: 'docs/guide.md' } }],
  }] })
  const node = result.document.nodes[0]
  const resources = result.document.assets
    .filter(asset => asset.metadata.resourceFor === node.assetRefs.primary.assetId)
    .map(asset => asset.metadata.relativePath)
    .sort()

  assert.deepEqual(resources, ['docs/img/Logo.png', 'docs/img/logo.png', 'docs/less.css'])
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
