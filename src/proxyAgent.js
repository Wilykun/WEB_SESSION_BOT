// Agen CONNECT buat WebSocket Baileys (WhatsApp) lewat egress proxy VM.
//
// Masalah (ditemukan 26 Nov 2026, dari server/proxy-agent.js panel
// WEB_JADIBOT — solusi yang sama, dipinjam ke SessionBot): Baileys (ws)
// konek langsung ke wss://web.whatsapp.com/ws/chat tanpa lewat proxy.
// Egress langsung di VM ini diblokir (TLS "wrong version number"), jadi
// semua koneksi WhatsApp mati instan kode 408 — dan belum pernah ada
// pairing code / QR asli yang terbit dari VM ini tanpa agen ini. HTTPS via
// proxy jalan, jadi WebSocket juga harus lewat proxy yang sama.
//
// Agen ini dipakai sebagai opsi `agent` di makeWASocket (didukung Baileys 7).
// Kalau tidak ada proxy (PC/VPS dengan jaringan normal) -> undefined,
// koneksi langsung seperti biasa. URL proxy diambil dari env dulu, kalau
// kosong dibaca dari file config egress VM sendiri (/etc/environment, lalu
// /etc/profile.d/hatch-egress.sh). Nilai proxy tidak pernah di-log.

import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'

const PROXY_ENV_FILES = ['/etc/environment', '/etc/profile.d/hatch-egress.sh']

function readProxyUrlFromFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(/^(?:export\s+)?HTTPS_PROXY=(.*)$/m)
    if (!match) return ''
    let value = match[1].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value
  } catch {
    return ''
  }
}

export function getProxyUrl() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || ''
  if (fromEnv) return fromEnv
  for (const file of PROXY_ENV_FILES) {
    const value = readProxyUrlFromFile(file)
    if (value) return value
  }
  return ''
}

// Bikin https.Agent yang tunnel lewat proxy (CONNECT) untuk satu URL proxy.
// proxyUrl kosong / tidak valid -> undefined (koneksi langsung).
export function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined
  let parsed
  try {
    parsed = new URL(proxyUrl)
  } catch {
    return undefined
  }
  if (!parsed.hostname) return undefined
  const proxyPort = Number(parsed.port) || 3128
  const authHeader = parsed.username
    ? `Proxy-Authorization: Basic ${Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}`
      ).toString('base64')}\r\n`
    : ''
  const agent = new https.Agent({ keepAlive: false })
  agent.createConnection = (options, callback) => {
    const targetHost = options.host
    const targetPort = Number(options.port) || 443
    const servername = options.servername || targetHost
    let settled = false
    const done = (err, socket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(err, socket)
    }
    const proxySocket = net.connect({ host: parsed.hostname, port: proxyPort })
    const timer = setTimeout(() => {
      proxySocket.destroy()
      done(new Error('Proxy CONNECT timeout (30 detik)'))
    }, 30000)
    proxySocket.on('error', (err) => done(err))
    let buf = Buffer.alloc(0)
    proxySocket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end === -1) return
      const head = buf.subarray(0, end).toString()
      if (!/^HTTP\/\d\.\d 200/.test(head)) {
        proxySocket.destroy()
        done(new Error(`Proxy menolak CONNECT: ${head.split('\r\n')[0]}`))
        return
      }
      const rest = buf.subarray(end + 4)
      proxySocket.removeAllListeners('data')
      proxySocket.removeAllListeners('error')
      const tlsSocket = tls.connect({ socket: proxySocket, servername })
      if (rest.length) tlsSocket.unshift(rest)
      tlsSocket.on('error', (err) => done(err))
      tlsSocket.on('secureConnect', () => done(null, tlsSocket))
    })
    proxySocket.on('connect', () => {
      proxySocket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`
      )
    })
  }
  return agent
}

export function getWhatsAppProxyAgent() {
  return createProxyAgent(getProxyUrl())
}
