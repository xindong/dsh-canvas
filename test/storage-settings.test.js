import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageSettingsStore } from '../lib/storage-settings.js'
import { CanvasService } from '../lib/index.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'canvas-storage-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return realpath(home)
}

test('default, saved pointer, restart behavior and no migration', async t => {
  const home = await fixture(t)
  const defaultRoot = join(home, 'original')
  const store = await StorageSettingsStore.open({ home, defaultRoot })
  assert.deepEqual(store.get(), { root: await realpath(defaultRoot), configuredRoot: await realpath(defaultRoot), restartRequired: false })
  const target = join(home, 'target')
  const saved = await store.save({ root: target })
  assert.deepEqual(saved, { root: defaultRoot, configuredRoot: target, restartRequired: true })
  assert.deepEqual(await readdir(target), [])
  const resolvedTarget = await realpath(target)
  assert.equal(JSON.parse(await readFile(join(home, 'canvas-storage.json'), 'utf8')).root, resolvedTarget)
  const restarted = await StorageSettingsStore.open({ home, defaultRoot })
  assert.deepEqual(restarted.get(), { root: resolvedTarget, configuredRoot: resolvedTarget, restartRequired: false })
})

test('invalid paths never replace configuration; file targets fail', async t => {
  const home = await fixture(t)
  const store = await StorageSettingsStore.open({ home })
  for (const value of [null, {}, [], { root: '' }, { root: 'relative' }, { root: 1 }, { root: '/invalid\0path' }]) {
    await assert.rejects(store.save(value), TypeError)
  }
  const file = join(home, 'file')
  await writeFile(file, '')
  await assert.rejects(store.save({ root: file }))
  assert.equal(store.get().configuredRoot, await realpath(join(home, 'canvas')))
})

test('corrupt persisted configuration falls back without blocking startup', async t => {
  const home = await fixture(t)
  for (const value of ['{bad', '{}', '{"root":"relative"}', 'null']) {
    await writeFile(join(home, 'canvas-storage.json'), value)
    const store = await StorageSettingsStore.open({ home })
    assert.equal(store.get().root, await realpath(join(home, 'canvas')))
    assert.equal(store.get().recovery.temporary, false)
    assert.equal(await readFile(join(home, 'canvas-storage.json'), 'utf8'), value)
  }
})

test('unavailable configured root falls back to the writable default', async t => {
  const home = await fixture(t)
  const unavailable = join(home, 'not-a-directory')
  await writeFile(unavailable, '')
  await writeFile(join(home, 'canvas-storage.json'), `${JSON.stringify({ root: unavailable })}\n`)
  const store = await StorageSettingsStore.open({ home })
  assert.equal(store.get().root, await realpath(join(home, 'canvas')))
  assert.equal(store.get().configuredRoot, unavailable)
  assert.equal(store.get().restartRequired, true)
  assert.equal(store.get().recovery.requestedRoot, unavailable)
})

test('unavailable default and DSH roots use the temporary recovery directory', async t => {
  const home = await fixture(t)
  const defaultRoot = join(home, 'unavailable-default')
  await Promise.all([writeFile(defaultRoot, ''), writeFile(join(home, 'canvas'), '')])
  const store = await StorageSettingsStore.open({ home, defaultRoot })
  const recoveryRoot = store.get().root
  t.after(() => rm(recoveryRoot, { recursive: true, force: true }))
  assert.equal(store.get().recovery.temporary, true)
  assert.match(recoveryRoot, /dsh-canvas-recovery-/)
  assert.deepEqual(await readdir(recoveryRoot), [])
  const other = await StorageSettingsStore.open({ home, defaultRoot })
  t.after(() => rm(other.root, { recursive: true, force: true }))
  assert.notEqual(other.root, recoveryRoot)
  await store.initialize()
  assert.equal(store.root, recoveryRoot)
})

test('symlink directories are valid without recovery or restart prompts', async t => {
  const home = await fixture(t)
  const target = join(home, 'target')
  const linked = join(home, 'linked')
  await mkdir(target)
  await symlink(target, linked)
  await writeFile(join(home, 'canvas-storage.json'), JSON.stringify({ root: linked }))
  const store = await StorageSettingsStore.open({ home })
  assert.equal(store.root, target)
  assert.equal(store.get().configuredRoot, linked)
  assert.equal(store.get().restartRequired, false)
  assert.equal(store.get().recovery, undefined)
})

test('service waits for recovery before selecting paths and writing board data', async t => {
  const home = await fixture(t)
  const badRoot = join(home, 'file')
  await writeFile(badRoot, 'original')
  await writeFile(join(home, 'canvas-storage.json'), JSON.stringify({ root: badRoot }))
  const store = new StorageSettingsStore({ home })
  const service = new CanvasService({
    tools: { register() {} }, systemPrompt: { section() {}, context() {} }, logger: { warn() {} },
  }, {}, store)
  await service.createBoard('recovery', { name: '恢复画布' })
  await service.setCurrentBoardId('recovery')
  assert.equal(service.root, join(home, 'canvas'))
  assert.equal(service.assetsRoot, join(service.root, 'assets'))
  assert.equal(service.metaRoot, join(service.root, 'meta'))
  assert.equal(service.promptSettings.directory, join(service.root, 'settings'))
  assert.equal((await service.getStorageSettings()).recovery.requestedRoot, badRoot)
  assert.equal(await readFile(badRoot, 'utf8'), 'original')
  assert.equal(JSON.parse(await readFile(service.currentPath(), 'utf8')).boardId, 'recovery')
})

test('invalid default roots recover and do not throw during construction', async t => {
  const home = await fixture(t)
  const store = await StorageSettingsStore.open({ home, defaultRoot: 'relative' })
  assert.equal(store.root, join(home, 'canvas'))
  assert.ok(store.get().recovery)
})
