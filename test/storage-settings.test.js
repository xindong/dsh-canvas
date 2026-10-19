import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageSettingsStore } from '../lib/storage-settings.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'canvas-storage-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return realpath(home)
}

test('default, saved pointer, restart behavior and no migration', async t => {
  const home = await fixture(t)
  const defaultRoot = join(home, 'original')
  const store = new StorageSettingsStore({ home, defaultRoot })
  assert.deepEqual(store.get(), { root: defaultRoot, configuredRoot: defaultRoot, restartRequired: false })
  const target = join(home, 'target')
  const saved = await store.save({ root: target })
  assert.deepEqual(saved, { root: defaultRoot, configuredRoot: target, restartRequired: true })
  assert.deepEqual(await readdir(target), [])
  assert.equal(JSON.parse(await readFile(join(home, 'canvas-storage.json'), 'utf8')).root, target)
  const restarted = new StorageSettingsStore({ home, defaultRoot })
  assert.deepEqual(restarted.get(), { root: target, configuredRoot: target, restartRequired: false })
})

test('invalid paths never replace configuration; file targets fail', async t => {
  const home = await fixture(t)
  const store = new StorageSettingsStore({ home })
  for (const value of [null, {}, [], { root: '' }, { root: 'relative' }, { root: 1 }, { root: '/invalid\0path' }]) {
    await assert.rejects(store.save(value), TypeError)
  }
  const file = join(home, 'file')
  await writeFile(file, '')
  await assert.rejects(store.save({ root: file }))
  assert.equal(store.get().configuredRoot, join(home, 'canvas'))
})

test('corrupt persisted configuration fails explicitly', async t => {
  const home = await fixture(t)
  for (const value of ['{bad', '{}', '{"root":"relative"}', 'null']) {
    await writeFile(join(home, 'canvas-storage.json'), value)
    assert.throws(() => new StorageSettingsStore({ home }), /无法读取画布目录配置/)
  }
})
