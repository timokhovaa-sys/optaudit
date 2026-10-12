import { idFromHref, minorToRub } from './markup.js'

const AUTOMATED_SOURCES = new Set([
  'scriptor',
  'jsonapi',
  'remap-1.0',
  'remap-1.1',
  'remap-1.2',
  'restapi',
  'import',
  'import1c',
  'importediclient1c',
  'connectors',
  'evotor',
  'copy',
  'bulkcreate',
  'registration',
  'loginlogout',
  'emailsend',
  'export',
  'exportediclient1c',
  'clearrecyclebin',
  'combine',
  'print',
])

function normalizeName(value) {
  return String(value ?? '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/\s+/g, ' ')
}

function parseRuNumber(value) {
  const text = String(value ?? '').replace(/\s/g, '').replace(',', '.')
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function moneyMinor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string') {
    const rubles = parseRuNumber(value)
    return rubles == null ? null : Math.round(rubles * 100)
  }
  if (value && typeof value === 'object' && typeof value.value === 'number') return Math.round(value.value)
  return null
}

function isChange(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && ('oldValue' in value || 'newValue' in value))
}

function effectiveMinor(priceMinor, discount) {
  if (priceMinor == null) return null
  return priceMinor * (1 - (Number(discount) || 0) / 100)
}

function parseDisplayRow(row) {
  const parts = String(row).split(';').map((part) => part.trim()).filter((part, index, all) => part || index < all.length)
  if (parts.length < 7) return null
  const tail = parts.slice(-6)
  const priceMinor = moneyMinor(tail[3])
  if (priceMinor == null) return null
  return {
    name: parts.slice(0, -6).join('; '),
    assortmentId: null,
    priceMinor,
    discount: parseRuNumber(tail[5]) || 0,
  }
}

function toMinor(value, scale) {
  if (scale === 'rubles' && typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100)
  return moneyMinor(value)
}

function asPosition(value, scale = 'minor') {
  if (typeof value === 'string') return parseDisplayRow(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const assortment = value.assortment && typeof value.assortment === 'object' ? value.assortment : null
  const name = assortment?.name || value.name || ''
  const assortmentId = assortment?.id || idFromHref(assortment?.meta?.href) || null
  const priceField = value.price
  const discountField = value.discount
  if (isChange(priceField) || isChange(discountField)) {
    const oldPrice = toMinor(isChange(priceField) ? priceField.oldValue : priceField, scale)
    const newPrice = toMinor(isChange(priceField) ? priceField.newValue : priceField, scale)
    return {
      name,
      assortmentId,
      oldPriceMinor: oldPrice,
      newPriceMinor: newPrice ?? oldPrice,
      oldDiscount: Number(isChange(discountField) ? discountField.oldValue : discountField) || 0,
      newDiscount: Number(isChange(discountField) ? discountField.newValue : discountField) || 0,
      inline: true,
    }
  }
  const priceMinor = toMinor(priceField, scale)
  if (priceMinor == null) return null
  return {
    name,
    assortmentId,
    priceMinor,
    discount: Number(discountField) || 0,
  }
}

function isPositionPair(row) {
  return Boolean(row && typeof row === 'object' && !Array.isArray(row) && ('oldValue' in row || 'newValue' in row))
}

function listRows(value) {
  if (Array.isArray(value)) return value.map(asPosition).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/\r?\n/).map((row) => row.trim()).filter(Boolean).map(parseDisplayRow).filter(Boolean)
  }
  const one = asPosition(value)
  return one ? [one] : []
}

function sameProduct(left, right) {
  if (left.assortmentId && right.assortmentId && left.assortmentId === right.assortmentId) return true
  const leftName = normalizeName(left.name)
  const rightName = normalizeName(right.name)
  return Boolean(leftName) && leftName === rightName
}

function cutFrom(oldItem, newItem) {
  const oldPriceMinor = oldItem.oldPriceMinor ?? oldItem.priceMinor
  const newPriceMinor = newItem.newPriceMinor ?? newItem.priceMinor
  const oldDiscount = oldItem.oldDiscount ?? oldItem.discount ?? 0
  const newDiscount = newItem.newDiscount ?? newItem.discount ?? 0
  const before = effectiveMinor(oldPriceMinor, oldDiscount)
  const after = effectiveMinor(newPriceMinor, newDiscount)
  if (before == null || after == null || !(after < before - 0.5)) return null
  return {
    name: newItem.name || oldItem.name || '',
    assortmentId: newItem.assortmentId || oldItem.assortmentId || null,
    oldPriceMinor,
    newPriceMinor,
    oldDiscount,
    newDiscount,
  }
}

function positionField(diff) {
  if (!diff || typeof diff !== 'object') return null
  if (diff.positions) return diff.positions
  if (diff.attributeName === 'positions') return { oldValue: diff.oldValue, newValue: diff.newValue }
  return null
}

function pricesMatch(line, cut) {
  const shown = Number(line?.price)
  if (!Number.isFinite(shown)) return false
  const asKopecks = Math.round(shown * 100)
  return Math.abs(asKopecks - cut.newPriceMinor) <= 1 || Math.abs(shown - cut.newPriceMinor) <= 0.01
}

function updatedCuts(positions) {
  const rows = []
  if (Array.isArray(positions?.updated)) rows.push(...positions.updated)
  if (Array.isArray(positions?.changed)) rows.push(...positions.changed)
  return rows.map(asPosition).filter((item) => item?.inline).map((item) => cutFrom(item, item)).filter(Boolean)
}

function positionName(event) {
  const type = `${event?.entityType || ''} ${event?.entity?.meta?.type || ''}`.toLowerCase()
  if (!type.includes('position')) return ''
  return event?.name || ''
}

function cutsFromPriceFields(event) {
  const diff = event?.diff
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return []
  if (!isChange(diff.price) && !isChange(diff.discount)) return []
  const item = asPosition({
    name: positionName(event),
    price: diff.price,
    discount: diff.discount,
  })
  if (!item?.inline) return []
  const cut = cutFrom(item, item)
  return cut ? [cut] : []
}

function cutsFromEvent(event) {
  const nested = cutsInDiff(event?.diff)
  if (nested.length) return nested
  return cutsFromPriceFields(event)
}

export function isManualUpdate(event) {
  if (event?.eventType !== 'update' || event.supportAccess) return false
  if (event.source && AUTOMATED_SOURCES.has(event.source)) return false
  return true
}

function cutsInDiff(diff) {
  const positions = positionField(diff)
  if (!positions) return []
  if (Array.isArray(positions)) {
    const cuts = []
    for (const row of positions) {
      if (isPositionPair(row)) {
        const oldItem = row.oldValue == null ? null : asPosition(row.oldValue, 'rubles')
        const newItem = row.newValue == null ? null : asPosition(row.newValue, 'rubles')
        if (!oldItem || !newItem || oldItem.inline || newItem.inline) continue
        const cut = cutFrom(oldItem, newItem)
        if (cut) cuts.push(cut)
        continue
      }
      const item = asPosition(row)
      if (item?.inline) {
        const cut = cutFrom(item, item)
        if (cut) cuts.push(cut)
      }
    }
    return cuts
  }
  const changed = updatedCuts(positions)
  if (changed.length) return changed
  const older = listRows(positions.oldValue)
  const newer = listRows(positions.newValue)
  const used = new Set()
  const cuts = []
  for (const oldItem of older) {
    if (oldItem.inline) {
      const cut = cutFrom(oldItem, oldItem)
      if (cut) cuts.push(cut)
      continue
    }
    let index = newer.findIndex((item, itemIndex) => !used.has(itemIndex) && sameProduct(oldItem, item))
    if (index < 0 && older.length === newer.length) {
      index = newer.findIndex((item, itemIndex) => !used.has(itemIndex) && !item.inline)
    }
    if (index < 0) continue
    used.add(index)
    const cut = cutFrom(oldItem, newer[index])
    if (cut) cuts.push(cut)
  }
  return cuts
}

function employeeLabel(uid, names) {
  const known = names?.get?.(uid)
  if (known) return known
  const login = String(uid ?? '').split('@')[0]
  return login || 'Сотрудник'
}

export function priceCuts(events, names = new Map()) {
  const cuts = []
  for (const event of events || []) {
    if (!isManualUpdate(event)) continue
    for (const cut of cutsFromEvent(event)) {
      cuts.push({
        ...cut,
        by: employeeLabel(event.uid, names),
        moment: event.moment || '',
      })
    }
  }
  cuts.sort((left, right) => String(left.moment).localeCompare(String(right.moment)))
  return cuts
}

export function matchPriceCut(line, cuts) {
  const name = normalizeName(line?.name)
  const ids = new Set(line?.assortmentIds || [])
  const found = (cuts || []).filter((cut) => {
    if (cut.assortmentId && ids.has(cut.assortmentId)) return true
    const cutName = normalizeName(cut.name)
    if (name && cutName && cutName === name) return true
    return !cutName && pricesMatch(line, cut)
  })
  if (!found.length) return null
  const first = found[0]
  const last = found[found.length - 1]
  const priceCut = {
    by: last.by,
    moment: last.moment,
    oldPrice: minorToRub(first.oldPriceMinor),
    newPrice: minorToRub(last.newPriceMinor),
  }
  if (first.oldDiscount !== last.newDiscount) {
    priceCut.oldDiscount = first.oldDiscount
    priceCut.newDiscount = last.newDiscount
  }
  return priceCut
}

export function attachPriceCuts(shipment, cuts) {
  for (const line of shipment.positions || []) {
    if (!line.low || line.excluded) continue
    const priceCut = matchPriceCut(line, cuts)
    if (priceCut) line.priceCut = priceCut
  }
  shipment.priceCut = (shipment.positions || []).some((line) => line.priceCut)
  for (const line of shipment.positions || []) delete line.assortmentIds
}
