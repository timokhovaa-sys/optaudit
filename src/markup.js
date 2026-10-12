export function monthBounds(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? '')
  if (!match) {
    throw new Error('Месяц укажите в формате ГГГГ-ММ')
  }
  const year = Number(match[1])
  const monthIndex = Number(match[2])
  if (year < 2000 || year > 2100 || monthIndex < 1 || monthIndex > 12) {
    throw new Error('Месяц вне допустимого диапазона')
  }
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
  const mm = String(monthIndex).padStart(2, '0')
  const dd = String(lastDay).padStart(2, '0')
  return {
    from: `${year}-${mm}-01 00:00:00`,
    to: `${year}-${mm}-${dd} 23:59:59`,
  }
}

export function periodLabel(month) {
  const [year, monthIndex] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, monthIndex - 1, 1))
}

export function tagVariants(group) {
  const trimmed = group.trim()
  const lower = trimmed.toLocaleLowerCase('ru')
  const capital = lower
    ? lower.charAt(0).toLocaleUpperCase('ru') + lower.slice(1)
    : lower
  return [...new Set([trimmed, lower, capital].filter(Boolean))]
}

export const WHOLESALE_GROUP = 'оптовики'

export function assertGroupName(group) {
  const name = String(group ?? '').trim()
  if (!name) throw new Error('Укажите группу контрагентов')
  if (name.length > 80) throw new Error('Слишком длинное имя группы')
  if (/[;=]/.test(name)) throw new Error('Имя группы не должно содержать ; и =')
  return name
}

export function assertThreshold(value) {
  const threshold = Number(value)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1000) {
    throw new Error('Порог наценки должен быть числом от 0 до 1000')
  }
  return threshold
}

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundKopecks(value) {
  return Math.round(value)
}

function currencyRate(demand) {
  const rate = finite(demand.rate?.value, 1)
  return rate > 0 ? rate : 1
}

function lineAmounts(position, demand) {
  const base = finite(position.price) * finite(position.quantity) * (1 - finite(position.discount) / 100)
  const fx = currencyRate(demand)
  const sumMinor = roundKopecks(roundKopecks(base) * fx)
  return { netMinor: sumMinor, grossMinor: sumMinor }
}

export function momentKey(value) {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(String(value ?? '').trim())
  return match ? match[1] : ''
}

export function supplyDocumentPrices(document, positions) {
  const buckets = new Map()
  for (const position of positions || []) {
    const id = position?.assortment?.id || idFromHref(position?.assortment?.meta?.href)
    const quantity = finite(position?.quantity)
    const packQuantity = position?.pack?.quantity ? finite(position.pack.quantity, 1) || 1 : 1
    if (!id || !(quantity > 0) || !(packQuantity > 0)) continue
    const { netMinor } = lineAmounts(position, document)
    const bucket = buckets.get(id) || { sumMinor: 0, baseQty: 0 }
    bucket.sumMinor += netMinor
    bucket.baseQty += quantity * packQuantity
    buckets.set(id, bucket)
  }
  const prices = new Map()
  for (const [id, bucket] of buckets) {
    if (!(bucket.baseQty > 0) || bucket.sumMinor < 0) continue
    prices.set(id, Math.round(bucket.sumMinor / bucket.baseQty))
  }
  return prices
}

function purchasePriceMinor(assortment) {
  const priced = typeof assortment?.buyPrice?.value === 'number' ? assortment : assortment?.assortment
  const value = priced?.buyPrice?.value
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function purchaseIds(assortment) {
  return new Set(assortmentIds(assortment))
}

export function assortmentRefs(assortment) {
  const refs = []
  for (const node of assortmentChain(assortment)) {
    const href = node?.meta?.href ? String(node.meta.href).split('?')[0] : ''
    const id = node?.id || idFromHref(href)
    if (id && href) refs.push({ id, href })
  }
  return refs
}

export function addSupplyPrices(timelines, moment, prices, onlyIds = null) {
  const key = momentKey(moment)
  if (!key) return
  for (const [id, unitMinor] of prices || []) {
    if (!id || (onlyIds && !onlyIds.has(id))) continue
    if (typeof unitMinor !== 'number' || !Number.isFinite(unitMinor) || unitMinor < 0) continue
    const list = timelines.get(id) || []
    if (list.some((row) => row.moment === key)) continue
    list.push({ moment: key, unitMinor })
    timelines.set(id, list)
  }
}

export function lastSupplyUnitMinor(timelines, assortment, cutoff) {
  const limit = momentKey(cutoff)
  if (!limit) return null
  for (const id of purchaseIds(assortment)) {
    const list = timelines.get(id)
    if (!list?.length) continue
    let best = null
    for (const row of list) {
      if (row.moment < limit && (best == null || row.moment > best.moment)) best = row
    }
    if (best) return best.unitMinor
  }
  return null
}

function assortmentIds(assortment) {
  const ids = []
  for (const node of assortmentChain(assortment)) {
    const id = node.id || idFromHref(node.meta?.href)
    if (id) ids.push(id)
  }
  return ids
}

function refreshLineMarkup(line) {
  if (!line.costKnown || line.costMinor == null || line.costMinor < 0) {
    line.markup = null
    return
  }
  if (line.costMinor > 0) {
    line.markup = ((line.saleMinor - line.costMinor) / line.costMinor) * 100
    return
  }
  line.markup = line.saleMinor === 0 ? 0 : null
}

export function documentNetMinor(document) {
  if (typeof document?.sum !== 'number') return null
  return roundKopecks(finite(document.sum) * currencyRate(document))
}

function reconcileSaleToDocument(demand, lines) {
  const documentNet = documentNetMinor(demand)
  if (documentNet == null || lines.length === 0) return
  const current = lines.reduce((sum, line) => sum + line.saleMinor, 0)
  const gap = documentNet - current
  if (gap === 0 || Math.abs(gap) > lines.length) return
  const host = lines.reduce((best, line) => (line.saleMinor > best.saleMinor ? line : best))
  host.saleMinor += gap
  refreshLineMarkup(host)
}

const EXCLUSIONS = [
  { name: 'фирменный ароматизатор bass-line', article: '2754' },
  { name: 'фирменная наклейка bass-line (белая)', article: '2755' },
]

function normalized(value) {
  return String(value ?? '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .trim()
    .toLocaleLowerCase('ru')
    .replace(/\s+/g, ' ')
}

export function isExcludedProduct(product) {
  const name = normalized(product?.name)
  const codes = [product?.article, product?.code].map(normalized).filter(Boolean)
  return EXCLUSIONS.some((item) => (item.name && name === item.name) || (item.article && codes.includes(item.article)))
}

function assortmentChain(assortment) {
  const nodes = []
  let node = assortment
  while (node && typeof node === 'object' && !nodes.includes(node)) {
    nodes.push(node)
    node = node.assortment || node.product
  }
  return nodes
}

export function lineEconomics(position, demand, options = {}) {
  const quantity = finite(position.quantity)
  const { netMinor, grossMinor } = lineAmounts(position, demand)
  const saleMinor = netMinor
  const packQuantity = position.pack?.quantity ? finite(position.pack.quantity, 1) || 1 : null
  const units = packQuantity ? quantity * packQuantity : quantity
  const cardPrice = purchasePriceMinor(position.assortment)
  const supplied = typeof options.unitPriceMinor === 'number' && Number.isFinite(options.unitPriceMinor)
    ? options.unitPriceMinor
    : null
  const purchase = options.cardFallback === false
    ? supplied
    : (options.unitPriceMinor == null ? cardPrice : options.unitPriceMinor)

  let costMinor = null
  let costKnown = false
  if (purchase != null) {
    costMinor = purchase * units
    costKnown = true
  }

  const markup =
    costKnown && costMinor > 0
      ? ((saleMinor - costMinor) / costMinor) * 100
      : costKnown && costMinor === 0 && saleMinor === 0
        ? 0
        : null

  const chain = assortmentChain(position.assortment)
  const name = chain.map((node) => node.name).find((value) => String(value ?? '').trim()) || 'Позиция'
  let article = ''
  for (const node of chain) {
    if (node.article) {
      article = node.article
      break
    }
    if (node.code) {
      article = node.code
      break
    }
  }
  return {
    name,
    article,
    assortmentIds: [...purchaseIds(position.assortment)],
    excluded: chain.some((node) => isExcludedProduct(node)),
    quantity,
    packQuantity,
    priceMinor: roundKopecks(finite(position.price) * currencyRate(demand)),
    buyMinor: purchase,
    saleMinor,
    grossMinor,
    costMinor: costKnown ? costMinor : null,
    markup,
    costKnown,
  }
}

export function isBelowThreshold(markup, threshold) {
  return typeof markup === 'number' && Number.isFinite(markup) && markup < threshold
}

export function averageMarkup(lines) {
  let saleMinor = 0
  let costMinor = 0
  for (const line of lines) {
    if (line.excluded) continue
    if (!line.costKnown || !(line.costMinor > 0)) continue
    saleMinor += line.saleMinor
    costMinor += line.costMinor
  }
  if (!(costMinor > 0)) return null
  return ((saleMinor - costMinor) / costMinor) * 100
}

export function monthTotals(lines) {
  let salesMinor = 0
  let profitMinor = 0
  for (const line of lines) {
    salesMinor += Number(line.saleMinor) || 0
    if (line.excluded) continue
    if (!line.costKnown || !(line.costMinor > 0)) continue
    profitMinor += line.saleMinor - line.costMinor
  }
  return { salesMinor, profitMinor }
}

export function missedProfit(lines, threshold) {
  let amountMinor = 0
  let positions = 0
  let saleMinor = 0
  let targetMinor = 0
  for (const line of lines) {
    if (line.excluded) continue
    if (!isBelowThreshold(line.markup, threshold)) continue
    if (!line.costKnown || !(line.costMinor > 0)) continue
    const target = roundKopecks((line.costMinor * (100 + threshold)) / 100)
    const gap = target - line.saleMinor
    if (gap <= 0) continue
    amountMinor += gap
    saleMinor += line.saleMinor
    targetMinor += target
    positions += 1
  }
  return { amountMinor, positions, saleMinor, targetMinor }
}

export function summarizeShipment(demand, positions, threshold, options = {}) {
  const lines = positions.map((position) => {
    if (typeof options.unitPriceOf !== 'function') return lineEconomics(position, demand, {})
    return lineEconomics(position, demand, {
      unitPriceMinor: options.unitPriceOf(position, demand),
      cardFallback: false,
    })
  })
  reconcileSaleToDocument(demand, lines)
  const known = lines.filter((line) => line.costKnown && line.costMinor != null)
  const counted = known.filter((line) => !line.excluded)
  const saleMinor = lines.reduce((sum, line) => sum + line.saleMinor, 0)
  const markupSale = counted.reduce((sum, line) => sum + line.saleMinor, 0)
  const costMinor = known.reduce((sum, line) => sum + line.costMinor, 0)
  const countedCost = counted.reduce((sum, line) => sum + line.costMinor, 0)
  let costStatus = 'ok'
  if (lines.length === 0 || known.length === 0) costStatus = 'none'
  else if (known.length !== lines.length) costStatus = 'partial'
  else if (costMinor === 0) costStatus = 'zero'

  let markup = null
  if (counted.length > 0 && countedCost > 0) {
    markup = ((markupSale - countedCost) / countedCost) * 100
  } else if (counted.length > 0 && countedCost === 0 && markupSale === 0) {
    markup = 0
  }

  const low = isBelowThreshold(markup, threshold)
  return { lines, saleMinor, costMinor, markup, costStatus, low }
}

export function minorToRub(value) {
  if (value == null || !Number.isFinite(value)) return null
  return Math.round(value) / 100
}

export function groupReport(shipments, threshold) {
  const lowOrderIds = new Set()
  const unlinked = []

  for (const shipment of shipments) {
    if (!isBelowThreshold(shipment.markup, threshold)) continue
    if (shipment.order?.id) lowOrderIds.add(shipment.order.id)
    else unlinked.push(shipment)
  }

  const byOrder = new Map()
  for (const shipment of shipments) {
    const orderId = shipment.order?.id
    if (!orderId || !lowOrderIds.has(orderId)) continue
    if (!byOrder.has(orderId)) {
      byOrder.set(orderId, {
        ...shipment.order,
        agent: shipment.agent,
        shipments: [],
      })
    }
    byOrder.get(orderId).shipments.push(shipment)
  }

  const orders = [...byOrder.values()].map((order) => {
    const markups = order.shipments
      .map((shipment) => shipment.markup)
      .filter((markup) => markup != null && Number.isFinite(markup))
    order.lowestMarkup = markups.length ? Math.min(...markups) : null
    order.saleExVat = Math.round(order.shipments.reduce((total, shipment) => {
      return total + Math.round((shipment.saleExVat ?? 0) * 100)
    }, 0)) / 100
    order.shipments.sort((a, b) => (a.markup ?? 9999) - (b.markup ?? 9999))
    order.priceCut = order.shipments.some((shipment) => shipment.priceCut)
    return order
  })

  orders.sort((a, b) => (a.lowestMarkup ?? 9999) - (b.lowestMarkup ?? 9999) || String(a.name).localeCompare(String(b.name), 'ru'))
  unlinked.sort((a, b) => (a.markup ?? 9999) - (b.markup ?? 9999))
  return { orders, unlinked }
}

export function idFromHref(href) {
  if (!href) return null
  const clean = href.split('?')[0].replace(/\/$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1) || null
}
