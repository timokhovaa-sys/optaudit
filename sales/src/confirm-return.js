import { createCashPayout } from './cash-payout.js'
import { createRetailReturn } from './retail-return.js'
import { createSalesReturn, createShipmentReturn } from './shipment-return.js'

export async function settleReturn(client, card, { save, signal } = {}) {
  let current = card
  const kind = current?.document?.kind
  const cashless = current?.compensation === 'cashless'
  if (kind === 'demand') {
    const posted = await createShipmentReturn(client, current, signal)
    if (posted !== current) {
      current = posted
      if (save) await save(current)
    }
  } else if (kind === 'retaildemand' && cashless) {
    const posted = await createSalesReturn(client, current, signal)
    if (posted !== current) {
      current = posted
      if (save) await save(current)
    }
  } else if (kind === 'retaildemand' && current?.compensation === 'cash') {
    const posted = await createRetailReturn(client, current, signal)
    if (posted !== current) {
      current = posted
      if (save) await save(current)
    }
  } else {
    throw badRequest('В МойСклад пока проводится только возврат по отгрузке.')
  }
  if (kind === 'demand' && current.compensation === 'cash') {
    const paid = await createCashPayout(client, current, signal)
    if (paid !== current) {
      current = paid
      if (save) await save(current)
    }
  }
  return current
}

export function confirmMessage(card) {
  const parts = []
  if (card?.moysklad?.name) parts.push(`Возврат ${card.moysklad.name} проведён на Основной склад.`)
  if (card?.payout?.name) parts.push(`Выплата ${card.payout.name} проведена из точки продаж.`)
  return parts.join(' ') || 'Возврат покупателя проведён.'
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}
