/**
 * browserDevice.js — Daftar profil perangkat WhatsApp (Perangkat Tertaut)
 *
 * Disalin polanya dari ReadSwEsm_V1 / name_perangkat_tertautan.js:
 *  - v1 default: Ubuntu + Chrome  (Browsers.ubuntu('Chrome'))
 *  - v12 SENGAJA DIKOSONGKAN: WhatsApp menolak pairing code untuk
 *    profil iPhone, jadi v12 tidak ada di daftar ini.
 *  - getBrowserDevice(cfg) memakai cfg.browserDevice.selected,
 *    default 'v1'. pairedBrowserKey default 'v1' (lihat config.json).
 */
import { Browsers } from '@whiskeysockets/baileys'

export const BROWSER_LIST = [
  { key: 'v1', label: 'Ubuntu + Chrome', value: Browsers.ubuntu('Chrome') },
  { key: 'v2', label: 'Windows + Chrome', value: Browsers.windows('Chrome') },
  { key: 'v3', label: 'MacOS + Chrome', value: Browsers.macOS('Chrome') },
  { key: 'v4', label: 'Ubuntu + Firefox', value: Browsers.ubuntu('Firefox') },
  { key: 'v5', label: 'Windows + Firefox', value: Browsers.windows('Firefox') },
  { key: 'v6', label: 'MacOS + Firefox', value: Browsers.macOS('Firefox') },
  { key: 'v7', label: 'Ubuntu + Safari', value: Browsers.ubuntu('Safari') },
  { key: 'v8', label: 'MacOS + Safari', value: Browsers.macOS('Safari') },
  { key: 'v9', label: 'Windows + Edge', value: Browsers.windows('Edge') },
  { key: 'v10', label: 'Ubuntu + Edge', value: Browsers.ubuntu('Edge') },
  { key: 'v11', label: 'Android + Chrome Mobile', value: Browsers.android('Chrome') },
  // v12 sengaja tidak digunakan: WhatsApp menolak pairing code untuk profil iPhone.
  { key: 'v13', label: 'Windows + Opera', value: Browsers.windows('Opera') },
  { key: 'v14', label: 'MacOS + Edge', value: Browsers.macOS('Edge') },
  { key: 'v15', label: 'Ubuntu + Opera', value: Browsers.ubuntu('Opera') },
  { key: 'v16', label: 'MacOS + Opera', value: Browsers.macOS('Opera') }
]

export function getBrowserDevice(cfg) {
  const selected = String(cfg?.browserDevice?.selected || 'v1').toLowerCase()
  const found = BROWSER_LIST.find((b) => b.key === selected)
  return found ? [...found.value] : [...BROWSER_LIST[0].value]
}

export function getBrowserLabel(cfg) {
  const selected = String(cfg?.browserDevice?.selected || 'v1').toLowerCase()
  const found = BROWSER_LIST.find((b) => b.key === selected)
  return found ? found.label : BROWSER_LIST[0].label
}

export default getBrowserDevice
