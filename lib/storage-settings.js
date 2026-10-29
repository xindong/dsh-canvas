import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
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

function bounded(work, timeout = 3000) {
  let timer
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('画布目录访问超时')), timeout)
  })]).finally(() => clearTimeout(timer))
}

async function probeRoot(candidate) {
  await mkdir(candidate, { recursive: true, mode: 0o700 })
  const root = await realpath(candidate)
  // Checking readability also rejects regular files and inaccessible directories.
  await readdir(root)
  const probe = join(root, '.canvas-write-check-' + randomUUID())
  try { await writeFile(probe, '', { flag: 'wx', mode: 0o600 }) }
  finally { await rm(probe, { force: true }) }
  return root
}

/** The pointer lives outside the selected canvas directory so it survives switches. */
export class StorageSettingsStore {
  static async open(options = {}) {
    const store = new StorageSettingsStore(options)
    await store.initialize()
    return store
  }

  constructor({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), defaultRoot } = {}) {
    this.home = resolve(home)
    this.path = join(this.home, 'canvas-storage.json')
    this.configuredRoot = null
    try { this.defaultRoot = defaultRoot === undefined ? undefined : normalizeRoot(defaultRoot) }
    catch (error) { this.defaultError = error }
    this.root = this.defaultRoot || join(this.home, 'canvas')
    this.queue = Promise.resolve()
  }

  initialize() {
    return this.ready ??= this.open()
  }

  async open() {
    const errors = this.defaultError ? [this.defaultError] : []
    try {
      const value = await bounded((async () => {
        const info = await stat(this.path)
        if (!info.isFile() || info.size > 64 * 1024) throw new TypeError('无效的画布目录配置文件')
        return JSON.parse(await readFile(this.path, 'utf8'))
      })())
      this.configuredRoot = parseSettings(value)
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error)
    }
    const requestedRoot = this.configuredRoot || this.defaultRoot || this.root
    const candidates = [...new Set([requestedRoot, this.defaultRoot, join(this.home, 'canvas')].filter(Boolean))]
    for (const candidate of candidates) {
      try {
        // The probe itself never changes service state if it completes late.
        this.root = await bounded(probeRoot(candidate))
        this.activeConfiguredRoot = candidate === this.configuredRoot ? this.configuredRoot : null
        if (errors.length) this.recovery = { requestedRoot, temporary: false, message: errors.map(error => error.message).join('; ') }
        return this
      } catch (error) { errors.push(error) }
    }
    // Never share a recovery canvas between homes, profiles or other users.
    this.root = await bounded((async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-canvas-recovery-'))
      return probeRoot(temporaryRoot)
    })())
    this.recovery = { requestedRoot, temporary: true, message: errors.map(error => error.message).join('; ') }
    return this
  }

  get() {
    return {
      root: this.root,
      configuredRoot: this.configuredRoot || this.root,
      restartRequired: this.configuredRoot !== null && this.configuredRoot !== this.activeConfiguredRoot && this.configuredRoot !== this.root,
      ...(this.recovery ? { recovery: { ...this.recovery } } : {}),
    }
  }

  async save(request) {
    await this.initialize()
    const operation = this.queue.then(() => this.write(request))
    this.queue = operation.catch(() => {})
    return operation
  }

  async write(request) {
    const requestedRoot = parseSettings(request)
    const root = await bounded(probeRoot(requestedRoot))
    await mkdir(this.home, { recursive: true })
    const temporary = this.path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify({ root }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
    this.configuredRoot = root
    return this.get()
  }
}
