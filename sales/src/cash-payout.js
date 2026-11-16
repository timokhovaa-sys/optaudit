// Выплата из точки продаж, если компенсация наличными.

import { payoutComment } from './crm-note.js'

export { payoutComment }

export const RETAIL_STORE_ID = '13f40d43-50c6-11ea-0a80-06820016fd27'

export function cashPayoutBody({ card, store, shift, agent, moment }) {
  const organization = slimMeta(store?.organization?.meta) || slimMeta(shift?.organization?.meta)
  const retailShift = slimMeta(shift?.meta)
  const employee = employeeMeta(agent) || employeeMeta(shift?.owner)
  const sum = Math.round(Number(card?.amount) * 100)
  if (!organization) throw badRequest('У точки продаж нет организации.')
  if (!retailShift) throw badRequest('У точки продаж нет смены для выплаты.')
  if (!employee) throw badRequest('Не найден сотрудник для выплаты.')
  if (!(sum > 0)) throw badRequest('Сумма выплаты должна быть больше нуля.')
  return {
    applicable: true,
    moment,
    organization: { meta: organization },
    agent: { meta: employee },
    retailShift: { meta: retailShift },
    sum,
    description: payoutComment(card),
  }
}

export async function createCashPayout(client, card, signal, now = new Date()) {
  if (card?.compensation !== 'cash') return card
  if (card.payout?.id) return card
  const kind = card?.document?.kind
  if (kind !== 'demand' && kind !== 'retaildemand') {
    throw badRequest('Выплата только по отгрузке или продаже.')
  }
  const store = await client.get(`/entity/retailstore/${RETAIL_STORE_ID}`, { expand: 'organization' }, signal)
  if (!store?.meta?.href) throw badRequest('Не найдена точка продаж.')
  const existing = await findExistingPayout(client, card, signal)
  if (existing?.id) return payoutCard(card, existing)
  const shift = await findRetailShift(client, store, signal)
  if (!shift) throw badRequest('У точки продаж нет смены для выплаты.')
  const agent = await payoutAgent(client, card, shift, signal)
  const created = await client.post('/entity/retaildrawercashout', cashPayoutBody({
    card,
    store,
    shift,
    agent,
    moment: momentStamp(now),
  }), signal)
  return payoutCard(card, created)
}

function payoutCard(card, created) {
  const id = created?.id || ''
  return {
    ...card,
    status: 'confirmed',
    payout: {
      id,
      name: String(created?.name || ''),
      href: created?.meta?.uuidHref || (id ? `https://online.moysklad.ru/app/#retaildrawercashout/edit?id=${id}` : ''),
    },
  }
}

async function findExistingPayout(client, card, signal) {
  const name = String(card?.document?.name || '').trim()
  const order = String(card?.document?.orderName || '').trim()
  const needle = name || order
  if (!needle) return null
  let data
  try {
    data = await client.get('/entity/retaildrawercashout', {
      filter: `description~${needle}`,
      limit: 20,
      order: 'moment,desc',
    }, signal)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (!/фильтрац|неизвестн/i.test(error?.message || '')) throw error
    return null
  }
  const sum = Math.round(Number(card?.amount) * 100)
  return (data?.rows || []).find((row) => {
    const text = String(row?.description || '')
    if (!text.includes('Возврат через CRM')) return false
    if (name && !text.includes(name)) return false
    if (order && !text.includes(`Заказ ${order}`)) return false
    if (sum > 0 && Number(row?.sum) && Number(row.sum) !== sum) return false
    return true
  }) || null
}

async function findRetailShift(client, store, signal) {
  const href = slimHref(store?.meta?.href)
  let data
  try {
    data = await client.get('/entity/retailshift', {
      filter: `retailStore=${href}`,
      order: 'moment,desc',
      limit: 20,
      expand: 'owner',
    }, signal)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (!/фильтрац|неизвестн/i.test(error?.message || '')) throw error
    data = await client.get('/entity/retailshift', { order: 'moment,desc', limit: 50 }, signal)
  }
  const rows = (Array.isArray(data?.rows) ? data.rows : []).filter((row) => {
    const shiftStore = slimHref(row?.retailStore?.meta?.href)
    return !shiftStore || shiftStore === href || shiftStore.endsWith(`/${RETAIL_STORE_ID}`)
  })
  const pool = rows.length ? rows : (data?.rows || [])
  return pool.find((row) => !row?.closeDate) || pool[0] || null
}

async function payoutAgent(client, card, shift, signal) {
  const fromShift = employeeMeta(shift?.owner)
  if (fromShift) return { meta: fromShift }
  const kind = card?.document?.kind
  const id = String(card?.document?.id || '').trim()
  if (id && (kind === 'demand' || kind === 'retaildemand')) {
    const document = await client.get(`/entity/${kind}/${id}`, { expand: 'owner' }, signal)
    const fromDocument = employeeMeta(document?.owner)
    if (fromDocument) return { meta: fromDocument }
  }
  const listed = await client.get('/entity/employee', { filter: 'archived=false', limit: 1 }, signal)
  const fromList = employeeMeta(listed?.rows?.[0])
  if (fromList) return { meta: fromList }
  throw badRequest('Не найден сотрудник для выплаты.')
}

function momentStamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function employeeMeta(entity) {
  const meta = slimMeta(entity?.meta)
  if (!meta) return null
  if (meta.type === 'employee' || /\/entity\/employee\//.test(meta.href)) {
    return { ...meta, type: 'employee' }
  }
  return null
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

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}
