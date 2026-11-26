/**
 * authState.js — useSingleFileAuthState (adaptasi ringkas dari V1)
 *
 * Pola dari ReadSwEsm_V1 src/helper/authState.js:
 *  - SATU file JSON per sesi: { creds, keys, contacts, groups, settings }
 *    BUKAN useMultiFileAuthState (multi-file).
 *  - File berisi creds+keys dengan BufferJSON (agar Buffer tersimpan benar).
 *  - Tulis mutex-safe + debounce 300 ms, atomic lewat file .tmp -> rename.
 *
 * Adaptasi di proyek ini (tetap benar, tanpa dependency tambahan):
 *  - Mutex diganti rantai Promise sederhana (V1 memakai paket async-mutex;
 *    di sini tidak ditambah dependency itu, jadi mutex ditulis sendiri).
 *  - contacts/groups/settings disimpan di file yang sama, tapi SessionBot
 *    hanya memakai creds+keys; ketiganya tetap dipertahankan agar format
 *    file kompatibel dengan pola V1.
 *  - Pemulihan backup (pola WEB_JADIBOT): bila file utama rusak / JSON
 *    tidak bisa dibaca, coba berurutan sessions/<nomor>.json.good lalu
 *    .bak, dan salin yang berhasil kembali ke file utama.
 */
import { mkdir, readFile, rename, unlink, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js'
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics.js'
import { proto } from '@whiskeysockets/baileys'

const CONSOLIDATED_TYPES = new Set([
  'lid-mapping',
  'device-list',
  'identity-key',
  'pre-key',
  'sender-key',
  'session',
  'tctoken',
  'app-state-sync-key',
  'app-state-sync-version'
])

const MEMORY_ONLY_TYPES = new Set(['sender-key-memory'])

// Mutex sederhana per path: rantai Promise, tanpa dependency luar.
const _mutexes = new Map()
function _withMutex(absPath, fn) {
  const prev = _mutexes.get(absPath) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  _mutexes.set(absPath, run.catch(() => {}))
  return run
}

export async function useSingleFileAuthState(filePath) {
  await mkdir(dirname(filePath), { recursive: true })
  const absPath = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath)

  let creds = null
  const keyStore = new Map()
  const memStore = new Map()
  const _contacts = {}
  const _groups = {}
  const _settings = {}
  for (const type of CONSOLIDATED_TYPES) keyStore.set(type, new Map())
  memStore.set('sender-key-memory', new Map())

  let writeTimer = null
  let sealed = false

  async function flushNow() {
    const keysObj = {}
    for (const [type, store] of keyStore) {
      if (store.size === 0) continue
      const obj = {}
      for (const [id, val] of store) obj[id] = val
      keysObj[type] = obj
    }
    const payload = JSON.stringify(
      { creds, keys: keysObj, contacts: _contacts, groups: _groups, settings: _settings },
      BufferJSON.replacer
    )
    const tmpPath = filePath + '.tmp'
    await _withMutex(absPath, async () => {
      try {
        await writeFile(tmpPath, payload)
        await rename(tmpPath, filePath)
      } catch (err) {
        console.error(`[SingleFile] Gagal tulis ${filePath}:`, err.message)
        try { await unlink(tmpPath) } catch {}
      }
    })
  }

  function scheduleFlush() {
    if (sealed) return
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => { writeTimer = null; flushNow().catch(() => {}) }, 300)
  }

  // Muat satu file; kembalikan true bila berhasil.
  async function tryLoad(path) {
    try {
      const raw = await readFile(path, 'utf-8')
      const data = JSON.parse(raw, BufferJSON.reviver)
      if (!data || typeof data !== 'object') return false
      creds = data.creds || null
      if (data.keys) {
        for (const [type, entries] of Object.entries(data.keys)) {
          if (!keyStore.has(type)) keyStore.set(type, new Map())
          for (const [id, val] of Object.entries(entries)) keyStore.get(type).set(id, val)
        }
      }
      if (data.contacts) Object.assign(_contacts, data.contacts)
      if (data.groups) Object.assign(_groups, data.groups)
      if (data.settings) Object.assign(_settings, data.settings)
      return true
    } catch {
      return false
    }
  }

  // Urutan pemulihan: live -> .good -> .bak (pola WEB_JADIBOT).
  let loaded = await tryLoad(filePath)
  if (!loaded) {
    for (const suffix of ['.good', '.bak']) {
      const backupPath = filePath + suffix
      if (await tryLoad(backupPath)) {
        console.warn(`[SingleFile] File utama rusak, dipulihkan dari ${backupPath}`)
        try { await copyFile(backupPath, filePath) } catch {}
        loaded = true
        break
      }
    }
  }
  if (!loaded) creds = null
  if (!creds) creds = initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          if (MEMORY_ONLY_TYPES.has(type)) {
            const s = memStore.get(type)
            for (const id of ids) data[id] = s?.get(id) ?? null
          } else {
            const s = keyStore.get(type)
            for (const id of ids) {
              let value = s?.get(id) ?? null
              if (type === 'app-state-sync-key' && value) {
                try { value = proto.Message.AppStateSyncKeyData.fromObject(value) } catch {}
              }
              data[id] = value
            }
          }
          return data
        },
        set: async (data) => {
          let changed = false
          for (const category in data) {
            if (MEMORY_ONLY_TYPES.has(category)) {
              const s = memStore.get(category)
              for (const id in data[category]) {
                const v = data[category][id]
                if (v != null) s.set(id, v); else s.delete(id)
              }
            } else {
              if (!keyStore.has(category)) keyStore.set(category, new Map())
              const s = keyStore.get(category)
              for (const id in data[category]) {
                const v = data[category][id]
                if (v != null) s.set(id, v); else s.delete(id)
                changed = true
              }
            }
          }
          if (changed) scheduleFlush()
        }
      }
    },
    saveCreds: (update) => {
      if (update && typeof update === 'object') Object.assign(creds, update)
      scheduleFlush()
    },
    flushImmediate: () => flushNow(),
    stopFlush: () => {
      sealed = true
      if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    }
  }
}

export default useSingleFileAuthState
