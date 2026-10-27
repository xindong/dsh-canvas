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
  const quotedAssets = await service.importSourceResources('board', source('quoted.html', unterminatedQuotedTag), unterminatedQuotedTag.length, 'quoted')
  const commentAssets = await service.importSourceResources('board', source('comments.html', repeatedClosedComments), repeatedClosedComments.length, 'comments')
  const elapsed = performance.now() - started

  assert.deepEqual([cssAssets, htmlAssets, markdownAssets, quotedAssets, commentAssets], [[], [], [], [], []])
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
