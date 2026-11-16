import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PHOTO_SLOTS = [
  ['mounts', 'Крепления'],
  ['overview', 'Общий план с упаковкой'],
  ['terminals', 'Терминалы'],
]

export const COMPENSATION = [
  ['cash', 'Наличные'],
  ['cashless', 'Безнал'],
]

const SLOT_NAMES = new Set(PHOTO_SLOTS.map(([code]) => code))
const MAX_PHOTOS = 12
const MAX_BYTES = 1_500_000

export function compensationLabel(code) {
  return COMPENSATION.find(([value]) => value === code)?.[1] || ''
}

export function decodeReturnImage(data) {
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(data || ''))
  if (!match) return null
  const buffer = Buffer.from(match[1].replace(/\s/g, ''), 'base64')
  if (buffer.length < 32 || buffer.length > MAX_BYTES) return null
  return buffer
}

export async function saveReturnPhotos(root, cardId, photos) {
  if (!/^[0-9a-zA-Z-]{1,80}$/.test(cardId)) return []
  const saved = []
  for (const photo of (Array.isArray(photos) ? photos : []).slice(0, MAX_PHOTOS)) {
    if (!SLOT_NAMES.has(photo?.slot)) continue
    const buffer = decodeReturnImage(photo.data)
    if (!buffer) continue
    const id = crypto.randomUUID()
    const folder = join(root, cardId)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${id}.jpg`), buffer)
    saved.push({
      id,
      slot: photo.slot,
      name: String(photo.name || '').replace(/[^\w.\- ()а-яА-ЯёЁ]+/gu, '').slice(0, 80),
    })
  }
  return saved
}

export async function readReturnPhoto(root, cardId, fileId) {
  if (!/^[0-9a-zA-Z-]{1,80}$/.test(cardId) || !/^[0-9a-zA-Z-]{1,80}$/.test(fileId)) return null
  try {
    return await readFile(join(root, cardId, `${fileId}.jpg`))
  } catch {
    return null
  }
}

export async function removeReturnPhotos(root, cardId) {
  if (!/^[0-9a-zA-Z-]{1,80}$/.test(cardId)) return
  await rm(join(root, cardId), { recursive: true, force: true })
}
