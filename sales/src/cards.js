import { buyerDetails } from './search.js'
import { RETURN_REASONS } from './returns.js'
import { compensationLabel } from './return-files.js'

const REASON_LABELS = new Map(RETURN_REASONS)

export function buildReturnCard({ document, lines, requested, reason, compensation = '', compensationNote = '', photos = [], id, createdAt }) {
  const buyer = buyerDetails(document)
  const chosen = []
  let amount = 0
  for (const ask of Array.isArray(requested) ? requested : []) {
    const quantity = Number(ask?.quantity)
    if (!(quantity > 0)) continue
    const line = (lines || []).find((item) => sameLine(item, ask))
    if (!line) continue
    const shipped = Number(line.quantity) || 0
    const full = shipped > 0 && quantity === shipped ? Number(line.sum) : null
    const unit = Number(line.price)
    const sum = Number.isFinite(full) ? full : roundMoney((Number.isFinite(unit) ? unit : 0) * quantity)
    amount += sum
    chosen.push({
      name: line.name || 'Товар',
      article: line.article || '',
      code: line.code || '',
      assortmentHref: line.assortmentHref || '',
      shipped,
      quantity,
      price: Number.isFinite(unit) ? unit : null,
      sum: roundMoney(sum),
    })
  }
  const order = document?.customerOrder && typeof document.customerOrder === 'object' ? document.customerOrder : {}
  return {
    id: id || crypto.randomUUID(),
    createdAt: createdAt || new Date().toISOString(),
    status: 'new',
    reason,
    reasonLabel: REASON_LABELS.get(reason) || '',
    compensation,
    compensationLabel: compensationLabel(compensation),
    compensationNote: compensation === 'cashless' ? String(compensationNote || '').trim().slice(0, 2000) : '',
    photos: (photos || []).map((photo) => ({
      id: photo.id,
      slot: photo.slot,
      name: photo.name || '',
    })),
    amount: roundMoney(amount),
    document: {
      kind: document?.kind || '',
      id: document?.id || '',
      name: String(document?.name || ''),
      label: document?.kind === 'retaildemand' ? 'Продажа' : 'Отгрузка',
      moment: String(document?.moment || ''),
      href: documentHref(document),
      sum: rub(document?.sum, document?.rate),
      agent: document?.agent?.name || 'Без контрагента',
      phone: buyer.phone,
      email: buyer.email,
      siteOrder: buyer.siteOrder,
      paymentType: buyer.payment,
      payment: document?.payment || null,
      orderName: String(order.name || ''),
      orderHref: String(order.meta?.uuidHref || (order.id ? `https://online.moysklad.ru/app/#customerorder/edit?id=${order.id}` : '')),
    },
    lines: chosen,
  }
}

function sameLine(line, requested) {
  if (requested?.assortmentHref && line?.assortmentHref === requested.assortmentHref) return true
  return Boolean(requested?.code && line?.code && requested.code === line.code)
}

function documentHref(document) {
  if (document?.uuidHref) return String(document.uuidHref)
  if (!document?.id || !document?.kind) return ''
  return `https://online.moysklad.ru/app/#${document.kind}/edit?id=${document.id}`
}

function rub(minor, rate) {
  const sum = Number(minor)
  if (!Number.isFinite(sum)) return null
  const fx = Number(rate?.value)
  const factor = Number.isFinite(fx) && fx > 0 ? fx : 1
  return Math.round(Math.round(sum * factor)) / 100
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}
