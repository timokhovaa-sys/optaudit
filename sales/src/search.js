import { attachReturns, retailSalesForOrders, retailWindow } from './returns.js'
// Клиент — объект с методом get(path, params, signal); паузы запросов делает он.
// Возвраты подключаются тем же списком источников: salesreturn и retailsalesreturn.

export const SALE_SOURCES = [
  { kind: 'customerorder', path: '/entity/customerorder', label: 'Заказ' },
  { kind: 'demand', path: '/entity/demand', label: 'Отгрузка' },
  { kind: 'retaildemand', path: '/entity/retaildemand', label: 'Продажа' },
]

const POSITION_SCAN_LIMIT = 40

export function monthBounds(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? '')
  if (!match) throw badRequest('Месяц укажите в формате ГГГГ-ММ')
  const year = Number(match[1])
  const monthIndex = Number(match[2])
  if (year < 2000 || year > 2100 || monthIndex < 1 || monthIndex > 12) {
    throw badRequest('Месяц вне допустимого диапазона')
  }
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
  const mm = String(monthIndex).padStart(2, '0')
  const dd = String(lastDay).padStart(2, '0')
  return {
    from: `${year}-${mm}-01 00:00:00`,
    to: `${year}-${mm}-${dd} 23:59:59`,
  }
}

export function foldName(value) {
  return String(value ?? '')
    .replaceAll('ё', 'е')
    .replaceAll('Ё', 'е')
    .toLocaleLowerCase('ru')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeQuery(body) {
  const month = String(body?.month || '').trim()
  monthBounds(month)
  const product = foldName(body?.product).slice(0, 200)
  const number = String(body?.number || '').trim().slice(0, 80)
  if (!product && !number) throw badRequest('Укажите товар или номер.')
  if (product && product.length < 2) throw badRequest('Введите хотя бы две буквы наименования товара.')
  return {
    month,
    product,
    number,
    postedOnly: true,
  }
}

export function saleFilter({ from, to, postedOnly, number }) {
  const parts = []
  if (from && to) parts.push(`moment>=${from}`, `moment<=${to}`)
  if (postedOnly) parts.push('applicable=true')
  if (number) parts.push(`name~${escapeFilter(number)}`)
  return parts.join(';')
}

export function productMatches(assortment, query) {
  const needle = foldName(query)
  if (!needle) return true
  const texts = assortmentTexts(assortment).map((text) => foldName(text))
  if (texts.some((text) => text.includes(needle))) return true
  const tokens = needle.split(/\s+/).filter((word) => word.length >= 2)
  if (tokens.length < 2) return false
  return tokens.every((token) => texts.some((text) => text.includes(token)))
}

function queryWords(text) {
  return String(text || '').split(/\s+/).filter((word) => foldName(word).length >= 2)
}

function anchorWord(text) {
  const words = queryWords(text)
  if (words.length < 2) return String(text || '').trim()
  return [...words].sort((left, right) => {
    const leftDigit = /\d/.test(left) ? 1 : 0
    const rightDigit = /\d/.test(right) ? 1 : 0
    if (leftDigit !== rightDigit) return rightDigit - leftDigit
    return right.length - left.length
  })[0]
}

const SUGGEST_FETCH = 40
const SUGGEST_LIMIT = 10

export async function suggestProducts(client, text, signal) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const needle = foldName(raw)
  if (needle.length < 2) return []
  const anchor = anchorWord(raw)
  const named = await assortmentRows(client, {
    filter: `archived=false;name~${escapeFilter(anchor)}`,
    limit: anchor === raw ? SUGGEST_FETCH : 100,
    order: 'name,asc',
  }, signal)
  let items = rankProductSuggestions(named, needle)
  if (items.length) return items
  if (anchor !== raw) {
    const phrase = await assortmentRows(client, {
      filter: `archived=false;name~${escapeFilter(raw)}`,
      limit: SUGGEST_FETCH,
      order: 'name,asc',
    }, signal)
    items = rankProductSuggestions(phrase, needle)
    if (items.length) return items
  }
  const found = await assortmentRows(client, {
    search: raw,
    filter: 'archived=false',
    limit: SUGGEST_FETCH,
  }, signal)
  return rankProductSuggestions(found, needle)
}

async function assortmentRows(client, params, signal) {
  try {
    const data = await client.get('/entity/assortment', params, signal)
    return Array.isArray(data?.rows) ? data.rows : []
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (/фильтрац|неизвестн/i.test(error?.message || '')) return []
    throw error
  }
}

export function rankProductSuggestions(rows, query) {
  const needle = foldName(query)
  if (needle.length < 2) return []
  const ranked = []
  for (const row of rows || []) {
    if (!row?.name || !productMatches(row, needle)) continue
    if (row.meta?.type === 'productfolder') continue
    ranked.push({ row, score: suggestionScore(row, needle) })
  }
  ranked.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score
    const leftName = foldName(left.row.name)
    const rightName = foldName(right.row.name)
    if (leftName.length !== rightName.length) return leftName.length - rightName.length
    return leftName.localeCompare(rightName, 'ru')
  })
  const seen = new Set()
  const items = []
  for (const item of ranked) {
    const name = String(item.row.name).trim()
    const article = String(item.row.article || item.row.assortment?.article || '').trim()
    const code = String(item.row.code || item.row.assortment?.code || '').trim()
    const key = `${foldName(name)}|${foldName(article)}|${foldName(code)}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ name, article, code })
    if (items.length === SUGGEST_LIMIT) break
  }
  return items
}

function suggestionScore(row, needle) {
  const texts = assortmentTexts(row).map((text) => foldName(text))
  const name = foldName(row.name)
  if (texts.some((text) => text === needle)) return 0
  if (name.startsWith(needle)) return 1
  const words = name.split(/[\s/]+/)
  if (words.some((word) => word.startsWith(needle))) return 2
  if (texts.some((text) => text.startsWith(needle))) return 3
  if (name.includes(needle)) return 4
  return 5
}

export async function searchSales({ client, month, product = '', number = '', postedOnly = true, signal, onProgress }) {
  const rawProduct = String(product || '').replace(/\s+/g, ' ').trim()
  const query = normalizeQuery({ month, product, number, postedOnly })
  const bounds = monthBounds(query.month)
  const paymentCache = new Map()
  const paymentOf = (document) => resolvePayment(client, document, signal, paymentCache)
  const found = query.product
    ? await searchByProduct(client, query, rawProduct, bounds, signal, onProgress, paymentOf)
    : await searchDocuments(client, query, bounds, signal, onProgress, paymentOf)
  found.sales.sort((left, right) => right.moment.localeCompare(left.moment) || right.name.localeCompare(left.name, 'ru'))
  return { ...query, sales: found.sales, notice: missingOrderNotice(found.missingOrders) }
}

const HISTORY_LABELS = {
  demand: 'Отгрузка',
  retaildemand: 'Продажа',
}

async function searchByProduct(client, query, rawProduct, bounds, signal, onProgress, paymentOf) {
  const items = await findAssortment(client, rawProduct, signal, onProgress)
  if (!items.length) return []
  const hrefs = items.map(entityHref).filter(Boolean)
  const filters = turnoverFilters(items)
  const history = filters.length
    ? await loadHistory(client, filters, bounds, query.number, signal, onProgress)
    : []
  const orders = await loadProductOrders(client, hrefs, query, bounds, signal, onProgress)
  const opened = await expandOrders(client, [...history, ...orders], bounds, signal, onProgress)
  if (!opened.documents.length) return { sales: [], missingOrders: opened.missingOrders }
  let priced = 0
  const sales = await mapPool(opened.documents, 2, async (document) => {
    document.payment = await paymentOf(document)
    const lines = await productLines(client, document, query.product, hrefs, signal)
    const view = productSaleView(document, lines)
    await attachReturns(client, view, document, signal)
    priced += 1
    onProgress?.({
      message: `Цена: ${priced} из ${opened.documents.length}`,
      loaded: priced,
      total: opened.documents.length,
    })
    return view
  })
  return {
    sales: sales.filter((sale) => Array.isArray(sale.lines) && sale.lines.length),
    missingOrders: opened.missingOrders,
  }
}

async function findAssortment(client, text, signal, onProgress) {
  onProgress?.({ message: 'Ищу товар', loaded: 0, total: 1 })
  const items = []
  const seen = new Set()
  for (const archived of [false, true]) {
    const anchor = anchorWord(text)
    const named = await fetchAll(client, '/entity/assortment', {
      filter: `archived=${archived};name~${escapeFilter(anchor)}`,
      order: 'name,asc',
    }, { signal, pageLimit: 100 })
    collectAssortment(named, text, seen, items)
    if (items.length) continue
    if (anchor !== String(text || '').trim()) {
      const phrase = await fetchAll(client, '/entity/assortment', {
        filter: `archived=${archived};name~${escapeFilter(text)}`,
        order: 'name,asc',
      }, { signal, pageLimit: 100 })
      collectAssortment(phrase, text, seen, items)
      if (items.length) continue
    }
    const found = await fetchAll(client, '/entity/assortment', {
      search: text,
      filter: `archived=${archived}`,
    }, { signal, pageLimit: 100 })
    collectAssortment(found, text, seen, items)
  }
  return items
}

function collectAssortment(rows, text, seen, items) {
  for (const row of rows) {
    if (!productMatches(row, text)) continue
    const href = entityHref(row)
    if (!href || seen.has(href)) continue
    seen.add(href)
    items.push(row)
  }
}

function turnoverFilters(items) {
  const filters = []
  const seen = new Set()
  for (const item of items) {
    const filter = turnoverFilter(item)
    if (!filter || seen.has(filter)) continue
    seen.add(filter)
    filters.push(filter)
  }
  return filters
}

function turnoverFilter(item) {
  const href = entityHref(item)
  const type = item?.meta?.type || hrefKind(href)
  if (type === 'variant') return `variant=${href}`
  if (type === 'consignment') {
    const parent = entityHref(item.assortment)
    return parent ? `product=${parent}` : ''
  }
  if (type === 'product') return `product=${href}`
  return ''
}

async function loadHistory(client, filters, bounds, number, signal, onProgress) {
  const rowsByKey = new Map()
  for (let index = 0; index < filters.length; index += 1) {
    const rows = await fetchAll(client, '/report/turnover/byoperations', {
      momentFrom: bounds.from,
      momentTo: bounds.to,
      filter: filters[index],
    }, {
      signal,
      pageLimit: 1000,
      onPage: ({ loaded, total }) => onProgress?.({
        message: filters.length > 1
          ? `История, товар ${index + 1} из ${filters.length}: ${loaded} из ${total}`
          : `История: ${loaded} из ${total}`,
        loaded,
        total,
      }),
    })
    for (const row of rows) {
      const view = historyDocument(row, number, bounds)
      if (!view) continue
      const key = `${view.kind}:${view.id}:${entityHref(row.assortment)}:${entityHref(row.store)}`
      if (rowsByKey.has(key)) continue
      rowsByKey.set(key, view)
    }
  }
  const documents = new Map()
  for (const view of rowsByKey.values()) {
    const key = `${view.kind}:${view.id}`
    const previous = documents.get(key)
    if (!previous) {
      documents.set(key, view)
      continue
    }
    previous.historyQuantity += view.historyQuantity
  }
  return [...documents.values()]
}

function historyDocument(row, number, bounds) {
  const operation = row?.operation
  const kind = operation?.meta?.type
  const label = HISTORY_LABELS[kind]
  if (!label) return null
  const id = idFromHref(operation.meta?.href)
  if (!id) return null
  const name = String(operation.name || '')
  if (number && !name.includes(number)) return null
  const moment = String(operation.moment || '').replace(/\.\d+$/, '')
  if (moment && (moment < bounds.from || moment > bounds.to)) return null
  const quantity = Math.abs(Number(row.quantity) || 0)
  if (!quantity) return null
  return {
    id,
    kind,
    label,
    name,
    moment,
    agent: { name: operation.agent?.name || '' },
    uuidHref: operation.meta?.uuidHref || '',
    applicable: true,
    historyQuantity: quantity,
    assortmentName: row.assortment?.name || '',
    assortmentArticle: row.assortment?.article || '',
    assortmentCode: row.assortment?.code || '',
  }
}

async function loadProductOrders(client, hrefs, query, bounds, signal, onProgress) {
  const source = SALE_SOURCES.find((item) => item.kind === 'customerorder')
  const batches = chunks(hrefs, 10)
  const documents = []
  const seen = new Set()
  for (let index = 0; index < batches.length; index += 1) {
    const rows = await fetchAll(client, source.path, {
      filter: productDocumentFilter({
        ...bounds,
        hrefs: batches[index],
        number: query.number,
      }),
      expand: 'agent,positions.assortment',
      order: 'moment,desc',
    }, {
      signal,
      pageLimit: 100,
      onPage: ({ loaded, total }) => onProgress?.({
        message: batches.length > 1
          ? `Заказ, часть ${index + 1}: ${loaded} из ${total}`
          : `Заказ: ${loaded} из ${total}`,
        loaded,
        total,
      }),
    })
    for (const row of rows) {
      if (!row?.id || seen.has(row.id)) continue
      seen.add(row.id)
      documents.push({ ...row, kind: source.kind, label: source.label })
    }
  }
  return documents
}

function productDocumentFilter({ from, to, hrefs, number }) {
  const parts = [`moment>=${from}`, `moment<=${to}`, 'applicable=true']
  for (const href of hrefs) parts.push(`assortment=${href}`)
  if (number) parts.push(`name~${escapeFilter(number)}`)
  return parts.join(';')
}

async function productLines(client, document, product, hrefs, signal) {
  let positions = expandedRows(document.positions)
  const size = Number(document.positions?.meta?.size ?? positions.length)
  let lines = matchingLines(positions, document, product, hrefs)
  const needsFetch = !lines.length && (size > positions.length || (document.historyQuantity && !document.positions))
  if (needsFetch) {
    positions = await fetchAll(
      client,
      `/entity/${document.kind}/${document.id}/positions`,
      { expand: 'assortment' },
      { signal },
    )
    lines = matchingLines(positions, document, product, hrefs)
  }
  if (!lines.length && document.historyQuantity) {
    return [{
      name: document.assortmentName || 'Товар',
      article: document.assortmentArticle || '',
      code: document.assortmentCode || '',
      quantity: document.historyQuantity,
      sum: null,
      price: null,
    }]
  }
  return lines
}

function matchingLines(positions, document, product, hrefs) {
  const known = new Set(hrefs || [])
  return positions
    .filter((position) => assortmentLinked(position.assortment, known) || productMatches(position.assortment, product))
    .map((position) => lineView(position, document))
}

function assortmentLinked(assortment, hrefs) {
  let node = assortment
  const seen = new Set()
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    const href = entityHref(node)
    if (href && hrefs.has(href)) return true
    node = node.assortment
  }
  return false
}

async function searchDocuments(client, query, bounds, signal, onProgress, paymentOf) {
  const documents = []
  const seen = new Set()
  const add = (row, source) => {
    if (!row?.id || seen.has(`${source.kind}:${row.id}`)) return
    seen.add(`${source.kind}:${row.id}`)
    documents.push({ ...row, kind: source.kind, label: source.label })
  }
  await collectByName(client, query, bounds, signal, onProgress, add)
  if (query.number && documents.length === 0) {
    onProgress?.({ message: 'Ищу номер', loaded: 0, total: 1 })
    await collectByName(client, query, null, signal, onProgress, add)
  }
  if (query.number && documents.length === 0) {
    await collectBySiteNumber(client, query.number, signal, onProgress, add)
  }
  const opened = await expandOrders(client, documents, bounds, signal, onProgress)
  if (opened.documents.length > POSITION_SCAN_LIMIT) {
    return {
      sales: await mapPool(opened.documents, 2, async (document) => {
        document.payment = await paymentOf(document)
        const view = saleView(document, null)
        await attachReturns(client, view, document, signal)
        return view
      }),
      missingOrders: opened.missingOrders,
    }
  }
  return {
    sales: await mapPool(opened.documents, 2, async (document) => {
      document.payment = await paymentOf(document)
      const positions = await fetchAll(
        client,
        `/entity/${document.kind}/${document.id}/positions`,
        { expand: 'assortment' },
        { signal },
      )
      const view = saleView(document, positions.map((position) => lineView(position, document)))
      await attachReturns(client, view, document, signal)
      return view
    }),
    missingOrders: opened.missingOrders,
  }
}

async function expandOrders(client, documents, bounds, signal, onProgress) {
  const orders = documents.filter((document) => document.kind === 'customerorder')
  const rest = documents.filter((document) => document.kind !== 'customerorder')
  const seen = new Set(rest.map((document) => `${document.kind}:${document.id}`))
  const linked = []
  const linkedOrders = new Set()
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index]
    onProgress?.({
      message: `Отгрузка заказа ${order.name || ''}`.trim(),
      loaded: index + 1,
      total: orders.length,
    })
    for (const shipment of await orderShipments(client, order, signal)) {
      const key = `${shipment.kind}:${shipment.id}`
      if (!shipment.id || seen.has(key)) continue
      seen.add(key)
      linked.push(shipment)
      linkedOrders.add(order.id)
    }
  }
  if (orders.length) {
    onProgress?.({ message: 'Продажи заказов', loaded: orders.length, total: orders.length })
    const ordersById = new Map(orders.map((order) => [order.id, order]))
    const sales = await retailSalesForOrders(client, orders, retailWindow(orders, bounds), signal)
    for (const sale of sales) {
      const key = `retaildemand:${sale.id}`
      if (!sale.id || seen.has(key)) continue
      seen.add(key)
      const orderId = sale.customerOrder?.id || idFromHref(sale.customerOrder?.meta?.href)
      if (orderId) linkedOrders.add(orderId)
      linked.push(shipmentView(sale, ordersById.get(orderId) || { id: orderId }, 'retaildemand', 'Продажа'))
    }
  }
  const missingOrders = orders
    .filter((order) => !linkedOrders.has(order.id))
    .map((order) => order.name || order.id)
  return { documents: [...rest, ...linked], missingOrders }
}

async function collectByName(client, query, bounds, signal, onProgress, add) {
  for (const source of SALE_SOURCES) {
    const rows = await fetchAll(client, source.path, {
      filter: saleFilter({ ...(bounds || {}), postedOnly: query.postedOnly, number: query.number }),
      expand: sourceExpand(source),
      order: 'moment,desc',
    }, {
      signal,
      onPage: ({ loaded, total }) => onProgress?.({
        message: `${source.label}: ${loaded} из ${total}`,
        loaded,
        total,
      }),
    })
    for (const row of rows) add(row, source)
  }
}

async function collectBySiteNumber(client, number, signal, onProgress, add) {
  onProgress?.({ message: 'Номер на сайте', loaded: 0, total: 1 })
  const needle = escapeFilter(number)
  for (const source of SALE_SOURCES) {
    const attributes = await siteOrderAttributes(client, source.kind, signal)
    for (const href of attributes) {
      const rows = await fetchFilter(client, source, `applicable=true;${href}~${needle}`, signal)
      for (const row of rows) add(row, source)
    }
    for (const field of ['description', 'externalCode']) {
      const rows = await fetchFilter(client, source, `applicable=true;${field}~${needle}`, signal)
      for (const row of rows) add(row, source)
    }
  }
}

async function siteOrderAttributes(client, kind, signal) {
  try {
    const metadata = await client.get(`/entity/${kind}/metadata`, {}, signal)
    return (metadata?.attributes || [])
      .filter((item) => isSiteOrderName(item?.name))
      .map((item) => entityHref(item))
      .filter(Boolean)
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return []
  }
}

async function fetchFilter(client, source, filter, signal) {
  try {
    return await fetchAll(client, source.path, {
      filter,
      expand: sourceExpand(source),
      order: 'moment,desc',
    }, { signal, pageLimit: 100 })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (/фильтрац|неизвестн/i.test(error?.message || '')) return []
    throw error
  }
}

function sourceExpand(source) {
  return source.kind === 'customerorder' ? 'agent' : 'agent,customerOrder,customerOrder.agent'
}

async function orderShipments(client, order, signal) {
  let refs = demandRefs(order)
  if (!refs) {
    const full = await client.get(`/entity/customerorder/${order.id}`, {}, signal)
    refs = demandRefs(full) || []
  }
  const demands = []
  for (const ref of refs) {
    const row = await readLinkedDocument(client, ref, signal)
    if (row) demands.push(row)
  }
  return demands.map((row) => shipmentView(row, order, row.kind, row.label))
}

async function readLinkedDocument(client, ref, signal) {
  const id = ref?.id || idFromHref(ref?.meta?.href || ref?.href)
  const preferred = linkedKind(ref)
  const kinds = preferred === 'retaildemand' ? ['retaildemand', 'demand'] : ['demand', 'retaildemand']
  if (!id) return null
  for (const kind of kinds) {
    try {
      const row = await client.get(`/entity/${kind}/${id}`, { expand: 'agent,customerOrder,customerOrder.agent' }, signal)
      if (!row?.id || row.applicable === false) return null
      return { ...row, kind, label: kind === 'retaildemand' ? 'Продажа' : 'Отгрузка' }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      if (error?.status === 404 || /не найден/i.test(error?.message || '')) continue
      throw error
    }
  }
  return null
}

function linkedKind(ref) {
  const type = ref?.meta?.type || ref?.type || ''
  if (type === 'demand' || type === 'retaildemand') return type
  const href = String(ref?.meta?.href || ref?.href || '')
  if (href.includes('/entity/retaildemand/')) return 'retaildemand'
  if (href.includes('/entity/demand/')) return 'demand'
  return 'demand'
}

function demandRefs(order) {
  if (Array.isArray(order?.demands)) return order.demands
  if (Array.isArray(order?.demands?.rows)) return order.demands.rows
  return null
}

function shipmentView(row, order, kind, label) {
  const linkedOrder = Number.isFinite(Number(row.customerOrder?.sum)) ? row.customerOrder : {
    id: order.id,
    name: order.name,
    moment: order.moment,
    sum: order.sum,
    payedSum: order.payedSum,
    demands: order.demands,
    meta: order.meta || { href: `https://api.moysklad.ru/api/remap/1.2/entity/customerorder/${order.id}`, type: 'customerorder' },
  }
  return { ...row, kind, label, customerOrder: linkedOrder }
}

function missingOrderNotice(names) {
  const unique = [...new Set((names || []).filter(Boolean))]
  if (!unique.length) return ''
  if (unique.length === 1) return `По заказу ${unique[0]} нет отгрузки или продажи.`
  return `По заказам ${unique.join(', ')} нет отгрузки или продажи.`
}

const RETAIL_PAID_FIELDS = ['cashSum', 'noCashSum', 'qrSum', 'prepaymentCash', 'prepaymentNoCash', 'prepaymentQrSum']

export function paymentStatus(payedMinor, totalMinor, source) {
  const total = Number(totalMinor)
  if (!Number.isFinite(total)) return { status: 'unknown', source: source || 'order', payed: null, sum: null }
  const payed = Number(payedMinor)
  const paidMinor = Number.isFinite(payed) ? payed : 0
  let status = 'unpaid'
  if (paidMinor >= total) status = 'paid'
  else if (paidMinor > 0) status = 'partial'
  return {
    status,
    source: source || 'order',
    payed: minorToRub(paidMinor),
    sum: minorToRub(total),
  }
}

async function resolvePayment(client, document, signal, cache) {
  if (document.kind === 'customerorder') {
    const order = hasSum(document)
      ? document
      : await cachedOrder(client, document.id, signal, cache)
    return paymentStatus(order?.payedSum, order?.sum, 'order')
  }

  let source = document
  let order = source.customerOrder || null
  if (!order && !hasOwnPayment(source)) {
    source = await client.get(`/entity/${document.kind}/${document.id}`, { expand: 'customerOrder' }, signal)
    order = source?.customerOrder || null
  }
  if (order && !hasSum(order)) {
    const id = order.id || idFromHref(order.meta?.href)
    if (id) order = await cachedOrder(client, id, signal, cache)
  }
  if (order) document.customerOrder = order
  if (source && source !== document) {
    if (document.sum == null && source.sum != null) document.sum = source.sum
    for (const key of RETAIL_PAID_FIELDS) {
      if (document[key] == null && source[key] != null) document[key] = source[key]
    }
  }
  if (hasSum(order)) return paymentStatus(order.payedSum, order.sum, 'order')
  if (document.kind === 'retaildemand') return paymentStatus(retailPaidMinor(source), source?.sum, 'document')
  if (hasSum(source)) return paymentStatus(source.payedSum, source.sum, 'document')
  return paymentStatus(undefined, undefined, 'order')
}

function hasSum(entity) {
  return entity != null && Number.isFinite(Number(entity.sum))
}

function hasOwnPayment(document) {
  if (!hasSum(document)) return false
  if (document.kind === 'retaildemand') return true
  return document.payedSum != null || document.customerOrder == null
}

function retailPaidMinor(document) {
  return RETAIL_PAID_FIELDS.reduce((sum, key) => sum + (Number(document?.[key]) || 0), 0)
}

async function cachedOrder(client, id, signal, cache) {
  if (!id) return null
  if (cache.has(id)) return cache.get(id)
  const order = await client.get(`/entity/customerorder/${id}`, {}, signal)
  cache.set(id, order)
  return order
}

function productSaleView(document, lines) {
  const priced = (lines || []).filter((line) => line.sum != null && line.quantity)
  const amount = priced.reduce((sum, line) => sum + line.sum, 0)
  const view = saleView(document, lines)
  view.sum = priced.length ? Math.round(amount * 100) / 100 : null
  view.price = priced.length === 1 ? priced[0].price : null
  view.quantity = priced.reduce((sum, line) => sum + line.quantity, 0) || document.historyQuantity || 0
  return view
}

function saleView(document, lines) {
  const buyer = buyerDetails(document)
  return {
    id: document.id,
    kind: document.kind,
    label: document.label,
    name: String(document.name || ''),
    moment: String(document.moment || ''),
    agent: document.agent?.name || 'Без контрагента',
    sum: documentSumRub(document),
    href: documentHref(document),
    applicable: document.applicable !== false,
    positionsCount: Number(document.positions?.meta?.size ?? lines?.length ?? 0) || 0,
    payment: document.payment || { status: 'unknown', source: 'order', payed: null, sum: null },
    phone: buyer.phone,
    email: buyer.email,
    siteOrder: buyer.siteOrder,
    paymentType: buyer.payment,
    lines,
  }
}

export function buyerDetails(document) {
  const order = document?.customerOrder && typeof document.customerOrder === 'object' ? document.customerOrder : {}
  const agents = [document?.agent, order.agent]
  const phone = formatPhone(firstFilled(
    agents.map((agent) => agent?.phone),
    attributeValue(document, order, isPhoneName),
    labeled(descriptionOf(document, order), /(?:телефон|phone)\s*[:\-]\s*([+\d][\d\s()\-]{6,})/i),
  ))
  const email = cleanEmail(firstFilled(
    agents.map((agent) => agent?.email),
    attributeValue(document, order, isEmailName),
    labeled(descriptionOf(document, order), /(?:e-?mail|почта)\s*[:\-]\s*([^\s,;]+@[^\s,;]+)/i),
  ))
  const siteOrder = cleanSiteOrder(firstFilled(
    attributeValue(document, order, isSiteOrderName),
    labeled(descriptionOf(document, order), /(?:номер\s+заказа\s+на\s+сайте|заказ\s+на\s+сайте|номер\s+на\s+сайте)\s*[:\-]\s*([^\s,;\n]+)/i),
  ), document, order)
  const payment = firstFilled(
    attributeValue(document, order, isPaymentName),
    labeled(descriptionOf(document, order), /(?:способ|тип|вид)\s+оплаты\s*[:\-]\s*([^\n,;]+)/i),
    paymentFromSums(document),
  )
  return { phone, email, siteOrder, payment }
}

function firstFilled(...groups) {
  for (const group of groups) {
    const values = Array.isArray(group) ? group : [group]
    for (const value of values) {
      const text = String(value ?? '').trim()
      if (text) return text
    }
  }
  return ''
}

function descriptionOf(document, order) {
  return [document?.description, order?.description].filter(Boolean).join('\n')
}

function attributeValue(document, order, matchName) {
  for (const source of [document, order]) {
    for (const attribute of source?.attributes || []) {
      if (!matchName(attribute?.name)) continue
      const text = attributeText(attribute)
      if (text) return text
    }
  }
  return ''
}

function attributeText(attribute) {
  const value = attribute?.value
  if (value == null || value === false) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (typeof value === 'object') return String(value.name || '').trim()
  return ''
}

function isPhoneName(name) {
  const text = foldName(name)
  return text === 'телефон' || text === 'phone' || text.includes('телефон')
}

function isEmailName(name) {
  const text = foldName(name)
  return text === 'email' || text === 'e-mail' || text.includes('почт') || text.includes('email') || text.includes('e-mail')
}

function isSiteOrderName(name) {
  const text = foldName(name)
  return text.includes('сайт') && (text.includes('номер') || text.includes('заказ'))
}

function isPaymentName(name) {
  const text = foldName(name)
  return text === 'способ оплаты' || text === 'тип оплаты' || text === 'вид оплаты'
}

function labeled(text, pattern) {
  const match = String(text || '').match(pattern)
  return match?.[1]?.trim() || ''
}

function formatPhone(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const digits = text.replace(/\D/g, '')
  const local = digits.length === 11 && (digits[0] === '7' || digits[0] === '8')
    ? digits.slice(1)
    : (digits.length === 10 ? digits : '')
  if (!local) return text
  return `+7 ${local.slice(0, 3)} ${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`
}

function cleanEmail(value) {
  const text = String(value || '').trim()
  return text.includes('@') ? text : ''
}

function cleanSiteOrder(value, document, order) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text === String(document?.name || '').trim()) return ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return ''
  if (text === String(order?.externalCode || '').trim() && text.length > 24) return ''
  return text
}

function paymentFromSums(document) {
  const parts = []
  if (paidMinor(document?.cashSum) > 0 || paidMinor(document?.prepaymentCash) > 0) parts.push('Наличные')
  if (paidMinor(document?.noCashSum) > 0 || paidMinor(document?.prepaymentNoCash) > 0) parts.push('Карта')
  if (paidMinor(document?.qrSum) > 0 || paidMinor(document?.prepaymentQrSum) > 0) parts.push('QR')
  return parts.join(' и ')
}

function paidMinor(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function lineView(position, document) {
  const assortment = position?.assortment || {}
  const quantity = Number(position?.quantity) || 0
  const sum = minorToRub(lineSumMinor(position, document))
  return {
    name: assortment.name || 'Товар',
    article: assortment.article || '',
    code: assortment.code || '',
    quantity,
    sum,
    price: sum == null ? null : (quantity ? Math.round((sum / quantity) * 100) / 100 : sum),
    assortmentHref: entityHref(assortment),
  }
}

export function saleLines(document, positions) {
  return (positions || []).map((position) => lineView(position, document))
}

export async function loadPayment(client, document, signal) {
  return resolvePayment(client, document, signal, new Map())
}

function assortmentTexts(assortment) {
  const texts = []
  const seen = new Set()
  let node = assortment
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    if (node.name) texts.push(node.name)
    if (node.article) texts.push(node.article)
    if (node.code) texts.push(node.code)
    node = node.assortment
  }
  return texts
}

function documentSumRub(document) {
  const sum = Number(document?.sum)
  if (!Number.isFinite(sum)) return null
  const rate = Number(document?.rate?.value)
  const fx = Number.isFinite(rate) && rate > 0 ? rate : 1
  return minorToRub(Math.round(sum * fx))
}

function lineSumMinor(position, document) {
  const price = Number(position?.price) || 0
  const quantity = Number(position?.quantity) || 0
  const discount = Number(position?.discount) || 0
  const base = Math.round(price * quantity * (1 - discount / 100))
  const rate = Number(document?.rate?.value)
  const fx = Number.isFinite(rate) && rate > 0 ? rate : 1
  return Math.round(base * fx)
}

function minorToRub(value) {
  if (!Number.isFinite(value)) return null
  return Math.round(value) / 100
}

function expandedRows(collection) {
  if (Array.isArray(collection)) return collection
  if (Array.isArray(collection?.rows)) return collection.rows
  return []
}

function entityHref(row) {
  const href = row?.meta?.href
  return href ? String(href).split('?')[0] : ''
}

function hrefKind(href) {
  const match = /\/entity\/([^/]+)\//.exec(String(href || ''))
  return match?.[1] || ''
}

function idFromHref(href) {
  const clean = String(href || '').split('?')[0].replace(/\/$/, '')
  if (!clean) return ''
  return clean.split('/').pop() || ''
}

function chunks(items, size) {
  const parts = []
  for (let index = 0; index < items.length; index += size) parts.push(items.slice(index, index + size))
  return parts
}

function documentHref(document) {
  if (document.uuidHref) return String(document.uuidHref)
  if (!document.id) return ''
  return `https://online.moysklad.ru/app/#${document.kind}/edit?id=${document.id}`
}

function escapeFilter(value) {
  return String(value).replace(/[\\;=]/g, (char) => `\\${char}`)
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

async function fetchAll(client, path, params, { signal, onPage, pageLimit = 1000 } = {}) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 500; page += 1) {
    const data = await client.get(path, { ...params, limit: pageLimit, offset }, signal)
    const chunk = Array.isArray(data?.rows) ? data.rows : []
    rows.push(...chunk)
    const total = Number(data?.meta?.size ?? rows.length)
    onPage?.({ loaded: rows.length, total })
    if (chunk.length === 0 || rows.length >= total) return rows
    offset += chunk.length
  }
  throw Object.assign(new Error('Слишком большая выборка, запрос остановлен.'), { statusCode: 413 })
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index], index)
    }
  }
  const width = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}
