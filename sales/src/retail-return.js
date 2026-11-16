// Проведённый розничный возврат. Наличные в сумме документа, иначе МойСклад его не сохраняет.

import { crmNote } from './crm-note.js'
import { findNamed, MAIN_STORE_NAME, RETURN_STATE_NAME, returnPositions } from './shipment-return.js'

const API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'

export function retailReturnBody({ sale, positions, card, store, state }) {
  const organization = slimMeta(sale?.organization?.meta)
  const agent = slimMeta(sale?.agent?.meta)
  const saleLink = slimMeta(sale?.meta) || saleMeta(sale?.id)
  const warehouse = slimMeta(store?.meta)
  if (!organization || !agent || !saleLink) throw badRequest('У продажи нет организации или контрагента.')
  if (!warehouse) throw badRequest(`Не найден склад «${MAIN_STORE_NAME}».`)
  const rows = returnPositions(positions, card?.lines, 'продаже')
  const paid = rows.reduce((sum, row) => sum + lineSum(row), 0)
  const body = {
    applicable: true,
    organization: { meta: organization },
    agent: { meta: agent },
    demand: { meta: saleLink },
    store: { meta: warehouse },
    description: crmNote(card),
    cashSum: paid,
    noCashSum: 0,
    qrSum: 0,
    positions: rows,
  }
  const retailStore = slimMeta(sale?.retailStore?.meta)
  const retailShift = slimMeta(sale?.retailShift?.meta)
  const status = slimMeta(state?.meta)
  if (retailStore) body.retailStore = { meta: retailStore }
  if (retailShift) body.retailShift = { meta: retailShift }
  if (status) body.state = { meta: status }
  return body
}

export async function createRetailReturn(client, card, signal) {
  if (card?.document?.kind !== 'retaildemand') {
    throw badRequest('Розничный возврат проводится только по продаже.')
  }
  if (card.moysklad?.id) return card
  const saleId = String(card.document?.id || '').trim()
  if (!saleId) throw badRequest('У карточки нет продажи.')
  const sale = await client.get(`/entity/retaildemand/${saleId}`, {
    expand: 'agent,organization,retailStore,retailShift',
  }, signal)
  sale.id = sale.id || saleId
  const positions = await readPositions(client, saleId, signal)
  const store = await findNamed(client, '/entity/store', MAIN_STORE_NAME, signal)
  if (!store) throw badRequest(`Не найден склад «${MAIN_STORE_NAME}».`)
  const state = await findRetailState(client, signal)
  const created = await client.post('/entity/retailsalesreturn', retailReturnBody({
    sale,
    positions,
    card,
    store,
    state,
  }), signal)
  const id = created?.id || ''
  return {
    ...card,
    status: 'confirmed',
    moysklad: {
      id,
      name: String(created?.name || ''),
      href: created?.meta?.uuidHref || (id ? `https://online.moysklad.ru/app/#retailsalesreturn/edit?id=${id}` : ''),
    },
  }
}

async function readPositions(client, id, signal) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 20; page += 1) {
    const data = await client.get(`/entity/retaildemand/${id}/positions`, {
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

async function findRetailState(client, signal) {
  try {
    const metadata = await client.get('/entity/retailsalesreturn/metadata', {}, signal)
    return (metadata?.states || []).find((state) => fold(state?.name) === fold(RETURN_STATE_NAME)) || null
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

function lineSum(row) {
  const price = Number(row?.price) || 0
  const quantity = Number(row?.quantity) || 0
  const discount = Number(row?.discount) || 0
  return Math.round(price * quantity * (1 - discount / 100))
}

function saleMeta(id) {
  if (!id) return null
  return {
    href: `${API_ROOT}/entity/retaildemand/${id}`,
    type: 'retaildemand',
    mediaType: 'application/json',
  }
}

function slimMeta(meta) {
  if (!meta?.href) return null
  return {
    href: String(meta.href).split('?')[0],
    type: meta.type || '',
    mediaType: meta.mediaType || 'application/json',
  }
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
