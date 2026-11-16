// Проведённый возврат покупателя. Безнал не привязывает продажу как отгрузку и не двигает кассу.

import { crmNote } from './crm-note.js'

export const MAIN_STORE_NAME = 'Основной склад'
export const RETURN_STATE_NAME = 'Не для отправки'

const API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'

export function salesReturnBody({ demand, positions, card, store, state, attachDemand = true }) {
  const organization = slimMeta(demand?.organization?.meta)
  const agent = slimMeta(demand?.agent?.meta)
  const demandLink = attachDemand ? (slimMeta(demand?.meta) || demandMeta(demand?.id)) : null
  if (!organization || !agent || (attachDemand && !demandLink)) {
    throw badRequest(attachDemand
      ? 'У отгрузки нет организации или контрагента.'
      : 'У продажи нет организации или контрагента.')
  }
  const rows = returnPositions(positions, card?.lines, attachDemand ? 'отгрузке' : 'продаже')
  const body = {
    applicable: true,
    organization: { meta: organization },
    agent: { meta: agent },
    store: { meta: slimMeta(store?.meta) },
    state: { meta: slimMeta(state?.meta) },
    description: crmNote(card),
    positions: rows,
  }
  if (attachDemand) body.demand = { meta: demandLink }
  return body
}

export function returnPositions(positions, lines, place = 'отгрузке') {
  const pool = (positions || []).map((position) => ({
    position,
    left: Math.abs(Number(position?.quantity) || 0),
  }))
  const rows = []
  for (const line of lines || []) {
    let need = Number(line?.quantity) || 0
    if (!(need > 0)) continue
    const hits = pool.filter((item) => item.left > 0 && samePosition(item.position, line))
    if (!hits.length) throw badRequest(`В ${place} нет позиции «${line.name || line.code || 'товар'}».`)
    for (const hit of hits) {
      if (!(need > 0)) break
      const quantity = Math.min(hit.left, need)
      const row = returnPosition(hit.position, quantity)
      if (!row) throw badRequest(`В ${place} нет позиции «${line.name || line.code || 'товар'}».`)
      rows.push(row)
      hit.left -= quantity
      need -= quantity
    }
    if (need > 0.0001) throw badRequest(`В ${place} не хватает «${line.name || line.code || 'товар'}».`)
  }
  if (!rows.length) throw badRequest('В карточке нет позиций для возврата.')
  return rows
}

export async function createShipmentReturn(client, card, signal) {
  if (card?.document?.kind !== 'demand') {
    throw badRequest('В МойСклад пока проводится только возврат по отгрузке.')
  }
  return createSalesReturn(client, card, signal)
}

export async function createSalesReturn(client, card, signal) {
  const kind = card?.document?.kind
  if (kind !== 'demand' && kind !== 'retaildemand') {
    throw badRequest('В МойСклад пока проводится только возврат по отгрузке или продаже.')
  }
  if (card.moysklad?.id) return card
  const documentId = String(card.document?.id || '').trim()
  if (!documentId) throw badRequest(kind === 'demand' ? 'У карточки нет отгрузки.' : 'У карточки нет продажи.')
  const entity = kind === 'retaildemand' ? 'retaildemand' : 'demand'
  const source = await client.get(`/entity/${entity}/${documentId}`, { expand: 'agent,organization' }, signal)
  source.id = source.id || documentId
  const positions = await readPositions(client, entity, documentId, signal)
  const store = await findNamed(client, '/entity/store', MAIN_STORE_NAME, signal)
  if (!store) throw badRequest(`Не найден склад «${MAIN_STORE_NAME}».`)
  const state = await findReturnState(client, signal)
  if (!state) throw badRequest(`Не найден статус «${RETURN_STATE_NAME}».`)
  const created = await client.post('/entity/salesreturn', salesReturnBody({
    demand: source,
    positions,
    card,
    store,
    state,
    attachDemand: kind === 'demand',
  }), signal)
  const id = created?.id || ''
  return {
    ...card,
    status: 'confirmed',
    moysklad: {
      id,
      name: String(created?.name || ''),
      href: created?.meta?.uuidHref || (id ? `https://online.moysklad.ru/app/#salesreturn/edit?id=${id}` : ''),
    },
  }
}

async function readPositions(client, entity, id, signal) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 20; page += 1) {
    const data = await client.get(`/entity/${entity}/${id}/positions`, {
      expand: 'assortment',
      limit: 1000,
      offset,
    }, signal)
    const chunk = Array.isArray(data?.rows) ? data.rows : []
    rows.push(...chunk)
    const total = Number(data?.meta?.size ?? rows.length)
    if (chunk.length === 0 || rows.length >= total) return rows
    offset += chunk.length
  }
  return rows
}

export async function findNamed(client, path, name, signal) {
  try {
    const exact = await client.get(path, { filter: `name=${name}`, limit: 20 }, signal)
    const rows = Array.isArray(exact?.rows) ? exact.rows : []
    const found = rows.find((row) => fold(row?.name) === fold(name))
    if (found) return found
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (!/фильтрац|неизвестн/i.test(error?.message || '')) throw error
  }
  const listed = await client.get(path, { limit: 100 }, signal)
  return (listed?.rows || []).find((row) => fold(row?.name) === fold(name)) || null
}

async function findReturnState(client, signal) {
  const metadata = await client.get('/entity/salesreturn/metadata', {}, signal)
  return (metadata?.states || []).find((state) => fold(state?.name) === fold(RETURN_STATE_NAME)) || null
}

function returnPosition(position, quantity) {
  const assortment = slimMeta(position?.assortment?.meta)
  if (!assortment) return null
  const row = {
    quantity,
    price: Number(position?.price) || 0,
    discount: Number(position?.discount) || 0,
    vat: Number(position?.vat) || 0,
    assortment: { meta: assortment },
  }
  if (typeof position?.vatEnabled === 'boolean') row.vatEnabled = position.vatEnabled
  return row
}

function samePosition(position, line) {
  const href = slimHref(position?.assortment?.meta?.href)
  if (line?.assortmentHref && href && href === slimHref(line.assortmentHref)) return true
  const code = String(position?.assortment?.code || '')
  if (line?.code && code && line.code === code) return true
  const name = fold(position?.assortment?.name)
  return Boolean(name && name === fold(line?.name))
}

function demandMeta(id) {
  if (!id) return null
  return {
    href: `${API_ROOT}/entity/demand/${id}`,
    type: 'demand',
    mediaType: 'application/json',
  }
}

function slimMeta(meta) {
  if (!meta?.href) return null
  return {
    href: slimHref(meta.href),
    type: meta.type || '',
    mediaType: meta.mediaType || 'application/json',
  }
}

function slimHref(href) {
  return String(href || '').split('?')[0]
}

function fold(value) {
  return String(value ?? '')
    .replaceAll('ё', 'е')
    .replaceAll('Ё', 'е')
    .toLocaleLowerCase('ru')
    .replace(/\s+/g, ' ')
    .trim()
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}
