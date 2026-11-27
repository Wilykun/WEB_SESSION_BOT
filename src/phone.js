/**
 * phone.js — Validasi nomor + format otomatis + deteksi region
 *
 * Dipakai SERVER (server.js) dan logikanya diduplikasi di public/app.js
 * (client) — server TIDAK PERNAH percaya client, selalu validasi ulang.
 *
 * Aturan (sama di client & server) — WAJIB ada kode negara (27 Nov 2026):
 *  - Hanya digit setelah dibersihkan; huruf / kosong / terlalu pendek ditolak.
 *  - Hapus spasi, strip (-), tanda +.
 *  - Awalan + -> kode negara eksplisit, dihormati (mis. +62, +60, +1, +44).
 *  - Awalan 00 -> kode akses internasional, buang "00"-nya (mis. 0062 -> 62).
 *  - Awalan 0 -> nomor lokal Indonesia, 0 diganti 62 (mis. 0812 -> 62812).
 *  - Sudah ada kode negara (62/60/65/1/44/81/...) -> dipakai apa adanya.
 *  - TANPA 0 / + / 00 / kode negara (mis. 89..., 99...) -> DITOLAK, jangan
 *    ditebak jadi 62. Region wajib diisi pengguna (contoh: 62 Indonesia).
 *  - Panjang akhir 10-15 digit (termasuk kode negara).
 *
 * Deteksi region:
 *  - detectRegion(): peta prefix murni (tanpa dependency) — dipakai
 *    client dan sebagai fallback server.
 *  - detectRegionFull(): libphonenumber-js (parsePhoneNumber) — server
 *    adalah sumber kebenaran. Mengembalikan:
 *    { country, countryName, flag, callingCode, valid, type }
 */
import { parsePhoneNumber } from 'libphonenumber-js'

// Peta prefix umum: callingCode -> info negara.
// Nama negara diambil dari Intl.DisplayNames bila tersedia.
export const COUNTRY_PREFIXES = {
  '62': { country: 'ID', flag: '🇮🇩' },
  '60': { country: 'MY', flag: '🇲🇾' },
  '65': { country: 'SG', flag: '🇸🇬' },
  '1': { country: 'US', flag: '🇺🇸' },
  '91': { country: 'IN', flag: '🇮🇳' },
  '44': { country: 'GB', flag: '🇬🇧' },
  '81': { country: 'JP', flag: '🇯🇵' },
  '82': { country: 'KR', flag: '🇰🇷' },
  '86': { country: 'CN', flag: '🇨🇳' },
  '61': { country: 'AU', flag: '🇦🇺' },
  '33': { country: 'FR', flag: '🇫🇷' },
  '49': { country: 'DE', flag: '🇩🇪' },
  '31': { country: 'NL', flag: '🇳🇱' },
  '34': { country: 'ES', flag: '🇪🇸' },
  '39': { country: 'IT', flag: '🇮🇹' },
  '55': { country: 'BR', flag: '🇧🇷' },
  '52': { country: 'MX', flag: '🇲🇽' },
  '63': { country: 'PH', flag: '🇵🇭' },
  '84': { country: 'VN', flag: '🇻🇳' },
  '66': { country: 'TH', flag: '🇹🇭' },
  '90': { country: 'TR', flag: '🇹🇷' },
  '7': { country: 'RU', flag: '🇷🇺' },
  '20': { country: 'EG', flag: '🇪🇬' },
  '27': { country: 'ZA', flag: '🇿🇦' },
  '234': { country: 'NG', flag: '🇳🇬' },
  '92': { country: 'PK', flag: '🇵🇰' },
  '880': { country: 'BD', flag: '🇧🇩' }
}

const DEFAULT_CALLING_CODE = '62' // Indonesia — web ini berbahasa Indonesia

let _displayNames = null
try {
  _displayNames = new Intl.DisplayNames(['id'], { type: 'region' })
} catch {}

export function countryNameOf(countryCode) {
  if (!countryCode) return 'Tidak dikenal'
  try {
    return _displayNames?.of(countryCode) || countryCode
  } catch {
    return countryCode
  }
}

/** Bersihkan input mentah jadi digit saja (hapus spasi, strip, +, dll). */
export function cleanPhone(input) {
  return String(input ?? '').replace(/[^0-9]/g, '')
}

/** Kode negara terpanjang yang cocok di awal digit (mis. 62, 60, 1, 44). */
export function findCallingCode(digits) {
  const codes = Object.keys(COUNTRY_PREFIXES).sort((a, b) => b.length - a.length)
  for (const code of codes) {
    if (digits.startsWith(code)) return code
  }
  return null
}

/**
 * Format otomatis -> nomor internasional tanpa +.
 *  - '0812...'        -> '62812...'  (0 di depan -> 62)
 *  - '+62 812...'     -> '62812...'  (+ eksplisit dihormati)
 *  - '+1 212...' (US) -> '1212...'  (+ eksplisit dihormati)
 *  - '62 812...'      -> '62812...'  (kode negara sudah ada)
 *  - '60 12...' (MY)  -> '6012...'  (kode negara sudah ada)
 *  - '0062 812...'    -> '62812...'  (00 = akses internasional)
 *  - '89...' / '99...' -> '' (TANPA kode negara -> DITOLAK, jangan ditebak)
 *
 * Jangan pernah menebak region: nomor tanpa 0 / + / 00 / kode negara
 * (mis. 89...) TIDAK boleh otomatis jadi 62 — pengguna wajib menulis
 * kode negaranya (62 Indonesia, 60 Malaysia, 1 Amerika, 44 Inggris, ...).
 */
export function normalizePhone(input) {
  const raw = String(input ?? '')
  const hasPlus = raw.trim().startsWith('+')
  let digits = cleanPhone(raw)
  if (!digits) return ''
  if (hasPlus) return digits // kode negara eksplisit dari pengguna, hormati
  // "00" di depan = kode akses internasional, buang "00"-nya.
  if (digits.startsWith('00')) {
    digits = digits.slice(2)
    if (!digits) return ''
    return findCallingCode(digits) ? digits : ''
  }
  // "0" di depan = nomor lokal Indonesia, 0 diganti 62.
  if (digits.startsWith('0')) {
    while (digits.startsWith('0')) digits = digits.slice(1)
    if (!digits) return ''
    return DEFAULT_CALLING_CODE + digits
  }
  // Sudah ada kode negara? Harus cocok dengan peta calling code.
  if (findCallingCode(digits)) return digits
  // Tanpa 0 / + / 00 / kode negara -> region tidak diketahui, jangan ditebak.
  return ''
}

/** Operator Indonesia dari 4 digit pertama (prefix standar). */
export const CARRIER_PREFIXES = {
  '0811': 'Telkomsel', '0812': 'Telkomsel', '0813': 'Telkomsel',
  '0821': 'Telkomsel', '0822': 'Telkomsel', '0823': 'Telkomsel',
  '0851': 'by.U (Telkomsel)', '0852': 'Telkomsel', '0853': 'Telkomsel',
  '0814': 'Indosat', '0815': 'Indosat', '0816': 'Indosat',
  '0855': 'Indosat', '0856': 'Indosat', '0857': 'Indosat', '0858': 'Indosat',
  '0817': 'XL', '0818': 'XL', '0819': 'XL', '0859': 'XL', '0877': 'XL', '0878': 'XL',
  '0831': 'Axis', '0832': 'Axis', '0833': 'Axis', '0838': 'Axis',
  '0895': 'Tri', '0896': 'Tri', '0897': 'Tri', '0898': 'Tri', '0899': 'Tri',
  '0881': 'Smartfren', '0882': 'Smartfren', '0883': 'Smartfren', '0884': 'Smartfren',
  '0885': 'Smartfren', '0886': 'Smartfren', '0887': 'Smartfren', '0888': 'Smartfren', '0889': 'Smartfren'
}

/**
 * Deteksi operator Indonesia dari nomor ternormalisasi (62...).
 * Mengembalikan nama operator, 'unknown' bila prefix tidak dikenal
 * (mis. 0890 — JANGAN ditebak), atau null bila bukan nomor Indonesia.
 */
export function detectCarrier(phone) {
  const digits = cleanPhone(phone)
  if (!digits.startsWith('62') || digits.length < 6) return null
  const prefix = '0' + digits.slice(2, 5)
  return CARRIER_PREFIXES[prefix] || 'unknown'
}

/** Deteksi region dari peta prefix (tanpa dependency). */
export function detectRegion(phone) {
  const digits = cleanPhone(phone)
  const codes = Object.keys(COUNTRY_PREFIXES).sort((a, b) => b.length - a.length)
  for (const code of codes) {
    if (digits.startsWith(code)) {
      const info = COUNTRY_PREFIXES[code]
      return {
        country: info.country,
        countryName: countryNameOf(info.country),
        flag: info.flag,
        callingCode: code,
        valid: digits.length >= 10 && digits.length <= 15,
        type: 'unknown',
        carrier: detectCarrier(phone)
      }
    }
  }
  return {
    country: null,
    countryName: 'Tidak dikenal',
    flag: '🌐',
    callingCode: null,
    valid: false,
    type: 'unknown',
    carrier: null
  }
}

/**
 * Deteksi region lengkap via libphonenumber-js (server = sumber kebenaran).
 * Selalu kembalikan bentuk { country, countryName, flag, callingCode, valid, type }.
 */
export function detectRegionFull(phone) {
  const fallback = detectRegion(phone)
  try {
    const parsed = parsePhoneNumber('+' + cleanPhone(phone))
    if (!parsed) return fallback
    const country = parsed.country || fallback.country
    const callingCode = parsed.countryCallingCode || fallback.callingCode
    const flag = (country && COUNTRY_PREFIXES[String(callingCode)]?.flag) || fallback.flag
    let type = 'unknown'
    try {
      const t = parsed.getType()
      if (t) type = String(t).toLowerCase()
    } catch {}
    return {
      country: country || null,
      countryName: countryNameOf(country),
      flag,
      callingCode: callingCode ? String(callingCode) : null,
      valid: parsed.isValid(),
      type,
      carrier: detectCarrier(phone)
    }
  } catch {
    return fallback
  }
}

/**
 * Validasi nomor (server & client, aturan sama).
 * Mengembalikan { ok, phone, error, region }.
 *  - ok:false bila kosong / ada huruf / terlalu pendek / terlalu panjang.
 */
export function validatePhone(input) {
  const raw = String(input ?? '')
  if (!raw.trim()) return { ok: false, phone: '', error: 'Nomor WhatsApp wajib diisi.' }
  if (/[a-zA-Z]/.test(raw)) {
    return { ok: false, phone: '', error: 'Nomor hanya boleh berisi angka (tanpa huruf).' }
  }
  const phone = normalizePhone(raw)
  if (!phone) {
    // Ada digit tapi tidak ada kode negara (mis. 89..., 99...) -> minta kode negara.
    if (cleanPhone(raw)) {
      return { ok: false, phone: '', error: 'Masukkan kode negara di depan nomor — contoh 62 (Indonesia), 60 (Malaysia), 1 (Amerika). Nomor Indonesia diawali 0 atau 62.' }
    }
    return { ok: false, phone: '', error: 'Nomor WhatsApp wajib diisi.' }
  }
  if (phone.length < 10) {
    return { ok: false, phone, error: 'Nomor terlalu pendek — panjang harus 10-15 digit (termasuk kode negara).' }
  }
  if (phone.length > 15) {
    return { ok: false, phone, error: 'Nomor terlalu panjang — maksimal 15 digit (termasuk kode negara).' }
  }
  return { ok: true, phone, error: '', region: detectRegionFull(phone) }
}

export default validatePhone
