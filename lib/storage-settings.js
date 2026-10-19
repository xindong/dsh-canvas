import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('画布目录必须是非空绝对路径')
  const path = value.trim()
  if (path.includes('\0')) throw new TypeError('画布目录不能包含 NUL 字符')
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new TypeError('画布目录必须是绝对路径')
  return resolve(expanded)
}

function parseSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('无效的画布目录配置')
  return normalizeRoot(value.root)
}

/** The pointer lives outside the selected canvas directory so it survives switches. */
export class StorageSettingsStore {
  constructor({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), defaultRoot } = {}) {
    this.home = resolve(home)
    this.path = join(this.home, 'canvas-storage.json')
    this.configuredRoot = null
    try {
      this.configuredRoot = parseSettings(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法读取画布目录配置 ${this.path}: ${error.message}`, { cause: error })
    }
    this.root = this.configuredRoot || defaultRoot || join(home, 'canvas')
    this.queue = Promise.resolve()
  }

  get() {
    let activeRoot = resolve(this.root)
    try { activeRoot = realpathSync(activeRoot) } catch { /* The default directory may not exist yet. */ }
    return { root: this.root, configuredRoot: this.configuredRoot || this.root, restartRequired: this.configuredRoot !== null && activeRoot !== this.configuredRoot }
  }

  save(request) {
    const operation = this.queue.then(() => this.write(request))
    this.queue = operation.catch(() => {})
    return operation
  }

  async write(request) {
    const requestedRoot = parseSettings(request)
    await mkdir(requestedRoot, { recursive: true })
    const root = await realpath(requestedRoot)
    const probe = join(root, `.canvas-write-check-${randomUUID()}`)
    try {
      await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
    } finally {
      await rm(probe, { force: true })
    }
    await mkdir(this.home, { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify({ root }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true })
    }
    this.configuredRoot = root
    return this.get()
  }
}
