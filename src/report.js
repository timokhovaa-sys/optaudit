import { writeFileSync } from 'node:fs'
import { API_ROOT, MoySkladError, fetchAll } from './moysklad.js'
import { attachPriceCuts, priceCuts } from './price-cut.js'
import {
  assertGroupName,
  assertThreshold,
  averageMarkup,
  groupReport,
  monthTotals,
  idFromHref,
  minorToRub,
  missedProfit,
  monthBounds,
  periodLabel,
  summarizeShipment,
  tagVariants,
  addSupplyPrices,
  assortmentRefs,
  lastSupplyUnitMinor,
  momentKey,
  supplyDocumentPrices,
} from './markup.js'

function chunk(items, size) {
  const batches = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export function demandFilter({ from, to, postedOnly, agentHrefs, extra = [] }) {
  const parts = []
  if (from) parts.push(`moment>=${from}`)
  if (to) parts.push(`moment<=${to}`)
  if (postedOnly) parts.push('applicable=true')
  for (const href of agentHrefs || []) parts.push(`agent=${href}`)
  for (const part of extra) parts.push(part)
  return parts.join(';')
}

function hasTag(tags, group) {
  const wanted = group.trim().toLocaleLowerCase('ru')
  return (tags ?? []).some((tag) => String(tag).trim().toLocaleLowerCase('ru') === wanted)
}

async function loadCounterparties(client, group, signal, onProgress) {
  const found = new Map()
  const variants = tagVariants(group)
  let step = 0
  const steps = variants.length * 2
  for (const variant of variants) {
    for (const archived of [false, true]) {
      step += 1
      onProgress?.({
        message: `Ищу контрагентов с группой «${variant}»${archived ? ', включая архив' : ''}`,
        loaded: step,
        total: steps,
      })
      const filter = archived ? `tags=${variant};archived=true` : `tags=${variant}`
      const rows = await fetchAll(
        client,
        '/entity/counterparty',
        { filter, order: 'name' },
        {
          pageLimit: 1000,
          signal,
          onPage: ({ loaded, total }) => {
            onProgress?.({
              message: `Группа «${variant}»: ${loaded} из ${total}`,
              loaded,
              total,
            })
          },
        },
      )
      for (const row of rows) {
        if (!row.id || !hasTag(row.tags, group)) continue
        found.set(row.id, row)
      }
    }
  }
  return [...found.values()]
}

async function sampleTags(client, signal) {
  const counts = new Map()
  let offset = 0
  for (let page = 0; page < 8; page += 1) {
    const data = await client.get('/entity/counterparty', { limit: 100, offset, order: 'name' }, signal)
    const rows = data.rows ?? []
    for (const row of rows) {
      for (const tag of row.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    if (rows.length < 100) break
    offset += rows.length
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .slice(0, 24)
    .map(([name, count]) => ({ name, count }))
}

function presentPosition(line, threshold) {
  return {
    name: line.name,
    article: line.article,
    quantity: line.quantity,
    packQuantity: line.packQuantity,
    price: minorToRub(line.priceMinor),
    buy: minorToRub(line.buyMinor),
    sale: minorToRub(line.saleMinor),
    cost: minorToRub(line.costMinor),
    markup: line.markup,
    low: !line.excluded && line.markup != null && line.markup < threshold,
    excluded: Boolean(line.excluded),
    costKnown: line.costKnown,
    assortmentIds: line.assortmentIds || [],
  }
}

function presentShipment(demand, positions, threshold, agentsById, unitPriceOf) {
  const summary = summarizeShipment(demand, positions, threshold, { unitPriceOf })
  const agentId = demand.agent?.id || idFromHref(demand.agent?.meta?.href)
  const knownAgent = agentId ? agentsById.get(agentId) : null
  const orderId = demand.customerOrder?.id || idFromHref(demand.customerOrder?.meta?.href)
  const order = orderId
    ? {
        id: orderId,
        name: demand.customerOrder?.name || orderId.slice(0, 8),
        moment: demand.customerOrder?.moment || null,
        sum: minorToRub(demand.customerOrder?.sum),
        href: demand.customerOrder?.meta?.uuidHref || null,
      }
    : null
  const positionsView = summary.lines.map((line) => presentPosition(line, threshold))
  return {
    id: demand.id,
    name: demand.name || demand.id,
    moment: demand.moment,
    kind: demand.kind || 'demand',
    href: demand.meta?.uuidHref || null,
    applicable: demand.applicable !== false,
    documentSum: minorToRub(finiteRateSum(demand)),
    saleExVat: minorToRub(summary.saleMinor),
    cost: minorToRub(summary.costMinor),
    markup: summary.markup,
    low: summary.low,
    costStatus: summary.costStatus,
    lines: summary.lines,
    lowPositions: positionsView.filter((line) => line.low).length,
    agent: {
      id: agentId,
      name: knownAgent?.name || demand.agent?.name || 'Контрагент',
    },
    order,
    positions: positionsView,
  }
}

function finiteRateSum(demand) {
  const rate = Number(demand.rate?.value)
  const multiplier = Number.isFinite(rate) && rate > 0 ? rate : 1
  return Number(demand.sum ?? 0) * multiplier
}

const SALE_DOCUMENTS = [
  { kind: 'demand', path: '/entity/demand', title: 'Отгрузки' },
  { kind: 'retaildemand', path: '/entity/retaildemand', title: 'Продажи' },
]

async function loadDocuments(client, { kind, path, title, bounds, postedOnly, agents, signal, onProgress }) {
  const batches = chunk(agents, 12)
  const documents = []
  const seen = new Set()
  for (let index = 0; index < batches.length; index += 1) {
    const hrefs = batches[index].map((agent) => agent.meta?.href || `${API_ROOT}/entity/counterparty/${agent.id}`)
    onProgress?.({
      message: `${title} за период, часть ${index + 1} из ${batches.length}`,
      loaded: index,
      total: batches.length,
    })
    const rows = await fetchAll(
      client,
      path,
      {
        filter: demandFilter({
          from: bounds.from,
          to: bounds.to,
          postedOnly,
          agentHrefs: hrefs,
        }),
        expand: 'customerOrder,agent',
        order: 'moment,asc',
      },
      {
        pageLimit: 1000,
        signal,
        onPage: ({ loaded, total }) => {
          onProgress?.({
            message: `${title}, часть ${index + 1}: ${loaded} из ${total}`,
            loaded,
            total,
          })
        },
      },
    )
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue
      seen.add(row.id)
      documents.push({ ...row, kind })
    }
  }
  return documents
}

async function completeSupplyPositions(client, supply, signal) {
  const collection = supply?.positions
  const rows = Array.isArray(collection?.rows) ? collection.rows : []
  const size = Number(collection?.meta?.size ?? rows.length)
  if (Number.isFinite(size) && rows.length >= size) return rows
  if (!supply?.id) return rows
  return fetchAll(
    client,
    `/entity/supply/${supply.id}/positions`,
    { expand: 'assortment' },
    { pageLimit: 1000, signal },
  )
}

function uncoveredNeeds(needs, timelines) {
  return needs.filter((need) => lastSupplyUnitMinor(timelines, { id: need.chain[0].id }, need.cutoff) == null)
}

function supplyFilter(parts, postedOnly) {
  const filter = [...parts]
  if (postedOnly) filter.push('applicable=true')
  return filter.join(';')
}

async function readSupplyPage(client, supply, timelines, neededIds, signal) {
  const positions = await completeSupplyPositions(client, supply, signal)
  addSupplyPrices(timelines, supply.moment, supplyDocumentPrices(supply, positions), neededIds)
}

async function fetchLatestSupply(client, ref, cutoff, postedOnly, signal) {
  const data = await client.get('/entity/supply', {
    filter: supplyFilter([`moment<${cutoff}`, `assortment=${ref.href}`], postedOnly),
    order: 'moment,desc',
    expand: 'positions.assortment',
    limit: 1,
  }, signal)
  return Array.isArray(data?.rows) ? data.rows[0] || null : null
}

async function loadSupplyTimelines(client, loaded, postedOnly, onProgress, signal) {
  const timelines = new Map()
  const needs = []
  const seen = new Set()
  const neededIds = new Set()
  let upper = ''
  for (const { document, positions } of loaded) {
    const cutoff = momentKey(document.customerOrder?.moment || document.moment)
    if (!cutoff) continue
    if (cutoff > upper) upper = cutoff
    for (const position of positions || []) {
      const chain = assortmentRefs(position.assortment)
      if (chain.length === 0) continue
      for (const ref of chain) neededIds.add(ref.id)
      const key = `${chain[0].id}|${cutoff}`
      if (seen.has(key)) continue
      seen.add(key)
      needs.push({ cutoff, chain })
    }
  }
  if (!upper || needs.length === 0) return timelines

  const report = (scanned) => {
    const left = uncoveredNeeds(needs, timelines).length
    onProgress?.({
      message: `Приёмки до заказа: ${scanned} документов, цена есть у ${needs.length - left} из ${needs.length}`,
      loaded: needs.length - left,
      total: needs.length,
    })
  }

  let offset = 0
  const limit = 100
  let scanned = 0
  let reported = 0
  for (let page = 0; page < 500; page += 1) {
    const data = await client.get('/entity/supply', {
      filter: supplyFilter([`moment<=${upper}`], postedOnly),
      order: 'moment,desc',
      expand: 'positions.assortment',
      limit,
      offset,
    }, signal)
    const supplies = Array.isArray(data?.rows) ? data.rows : []
    const size = Number(data?.meta?.size)
    if (Number.isFinite(size) && size > 0) reported = size
    for (const supply of supplies) {
      await readSupplyPage(client, supply, timelines, neededIds, signal)
    }
    scanned += supplies.length
    const left = uncoveredNeeds(needs, timelines)
    report(scanned)
    const oldest = momentKey(supplies[supplies.length - 1]?.moment)
    const finished = supplies.length === 0 || supplies.length < limit || (reported > 0 && scanned >= reported)
    if (left.length === 0 || finished) return timelines
    if (left.length <= 12 && oldest && left.every((need) => oldest < need.cutoff)) {
      await mapPool(left, 2, async (need) => {
        for (const ref of need.chain) {
          if (lastSupplyUnitMinor(timelines, { id: ref.id }, need.cutoff) != null) return
          const supply = await fetchLatestSupply(client, ref, need.cutoff, postedOnly, signal)
          if (!supply) continue
          await readSupplyPage(client, supply, timelines, neededIds, signal)
          if (lastSupplyUnitMinor(timelines, { id: ref.id }, need.cutoff) != null) return
        }
      })
      report(scanned)
      return timelines
    }
    offset += supplies.length
  }
  throw new MoySkladError('Слишком большая выборка приёмок, запрос остановлен.', 413)
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  const width = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}

async function employeeRows(client, params, signal) {
  try {
    return await fetchAll(client, '/entity/employee', params, { pageLimit: 1000, signal })
  } catch (error) {
    if (error instanceof MoySkladError && error.status === 403) return []
    throw error
  }
}

async function loadEmployeeNames(client, signal) {
  const names = new Map()
  const rows = [
    ...await employeeRows(client, {}, signal),
    ...await employeeRows(client, { filter: 'archived=true' }, signal),
  ]
  for (const row of rows) {
    if (row?.uid && !names.has(row.uid)) names.set(row.uid, row.shortFio || row.name || row.uid)
  }
  return names
}

function shipmentEvents(shipment, eventsByKey) {
  const events = [...(eventsByKey.get(`${shipment.kind || 'demand'}:${shipment.id}`) || [])]
  if (shipment.order?.id) events.push(...(eventsByKey.get(`customerorder:${shipment.order.id}`) || []))
  return events
}

function rememberSample(samples, event) {
  if (event?.eventType !== 'update' || samples.length >= 8) return
  const blob = JSON.stringify(event.diff || {})
  const interesting = /price|positions|S200|27730|12230|12 230|позиц/i.test(blob)
  if (!interesting && samples.length >= 4) return
  samples.push({
    source: event.source || '',
    eventType: event.eventType || '',
    entityType: event.entityType || event.entity?.meta?.type || '',
    moment: event.moment || '',
    diffKeys: event.diff && typeof event.diff === 'object' ? Object.keys(event.diff) : [],
    context: Boolean(event.audit?.meta?.href || event.context?.meta?.href),
    positions: blob.length > 900 ? `${blob.slice(0, 900)}…` : blob,
  })
}

async function loadPriceCuts(client, shipments, progress, signal) {
  const targets = []
  const seen = new Set()
  for (const shipment of shipments) {
    if (!shipment.low) continue
    const key = `${shipment.kind || 'demand'}:${shipment.id}`
    if (!seen.has(key)) {
      seen.add(key)
      targets.push({ kind: shipment.kind || 'demand', id: shipment.id, key })
    }
    if (shipment.order?.id) {
      const orderKey = `customerorder:${shipment.order.id}`
      if (!seen.has(orderKey)) {
        seen.add(orderKey)
        targets.push({ kind: 'customerorder', id: shipment.order.id, key: orderKey })
      }
    }
  }
  if (targets.length === 0) {
    for (const shipment of shipments) {
      for (const line of shipment.positions || []) delete line.assortmentIds
    }
    return { denied: false }
  }

  const names = await loadEmployeeNames(client, signal)
  const eventsByKey = new Map()
  let done = 0
  let denied = 0
  await mapPool(targets, 2, async (target) => {
    try {
      eventsByKey.set(target.key, await fetchAll(
        client,
        `/entity/${target.kind}/${target.id}/audit`,
        {},
        { pageLimit: 100, signal },
      ))
    } catch (error) {
      if (error instanceof MoySkladError && error.status === 403) {
        denied += 1
        return
      }
      throw error
    }
    done += 1
    progress({
      message: `История цен: ${done} из ${targets.length}`,
      loaded: done,
      total: targets.length,
    })
  })

  for (const shipment of shipments) {
    if (!shipment.low) {
      for (const line of shipment.positions || []) delete line.assortmentIds
      continue
    }
    attachPriceCuts(shipment, priceCuts(shipmentEvents(shipment, eventsByKey), names))
  }
  let attached = 0
  const sources = new Set()
  const samples = []
  for (const events of eventsByKey.values()) {
    for (const event of events || []) {
      if (event?.source) sources.add(event.source)
      rememberSample(samples, event)
    }
  }
  for (const shipment of shipments) {
    attached += (shipment.positions || []).filter((line) => line.priceCut).length
  }
  const summary = {
    denied: targets.length > 0 && denied === targets.length,
    attached,
    sources: [...sources],
    samples,
  }
  if (attached === 0) {
    try {
      writeFileSync('data/audit-debug.json', JSON.stringify(summary, null, 2))
    } catch {
      // диагностика не должна срывать отчёт
    }
  }
  return summary
}

function auditMessage(audit) {
  if (audit?.denied) return 'История изменений недоступна, бейдж «снизили цену» не проставлен.'
  if ((audit?.attached || 0) > 0) return ''
  if (!audit?.sources?.length) return 'В истории документов нет событий, бейдж «снизили цену» не проставлен.'
  const fields = [...new Set((audit.samples || []).map((sample) => sample.diffKeys.join('+') || 'без полей'))].slice(0, 6)
  const types = [...new Set((audit.samples || []).map((sample) => sample.entityType).filter(Boolean))].slice(0, 6)
  const tail = [fields.join(', '), types.join(', ')].filter(Boolean).join(' · ')
  return tail ? `Снижение цены не разобрано. ${tail}.` : 'Снижение цены не разобрано.'
}

export async function refreshPriceCuts(client, report, signal) {
  const shipments = [
    ...(report.orders || []).flatMap((order) => order.shipments || []),
    ...(report.unlinked || []),
  ]
  const audit = await loadPriceCuts(client, shipments, () => {}, signal)
  for (const order of report.orders || []) {
    order.priceCut = (order.shipments || []).some((shipment) => shipment.priceCut)
  }
  report.auditNote = auditMessage(audit)
  return audit
}

const ORDER_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export function parseOrderLink(input) {
  const text = String(input ?? '').trim()
  if (!text) {
    throw Object.assign(new Error('Вставьте ссылку на заказ'), { statusCode: 400 })
  }
  const hashed = text.match(/#(customerorder|demand|retaildemand)\/edit\?id=([0-9a-f-]{36})/i)
  if (hashed) return { kind: hashed[1].toLowerCase(), id: hashed[2].toLowerCase() }
  const api = text.match(/\/entity\/(customerorder|demand|retaildemand)\/([0-9a-f-]{36})/i)
  if (api) return { kind: api[1].toLowerCase(), id: api[2].toLowerCase() }
  const bare = text.match(new RegExp(`^${ORDER_UUID.source}$`, 'i'))
  if (bare) return { kind: 'customerorder', id: bare[0].toLowerCase() }
  const id = text.match(ORDER_UUID)
  if (id && /customerorder|demand|retaildemand|moysklad/i.test(text)) {
    const kind = /retaildemand/i.test(text) ? 'retaildemand' : (/demand/i.test(text) ? 'demand' : 'customerorder')
    return { kind, id: id[0].toLowerCase() }
  }
  throw Object.assign(
    new Error('Нужна ссылка на заказ, отгрузку или продажу из МоегоСклада'),
    { statusCode: 400 },
  )
}

export function saleDocumentLinks(order, opened) {
  const links = []
  const seen = new Set()
  const add = (id, kind, prefetched) => {
    if (!id || seen.has(id)) return
    if (kind !== 'demand' && kind !== 'retaildemand') return
    seen.add(id)
    links.push({ id, kind, prefetched: prefetched || null })
  }
  const rows = Array.isArray(order?.demands)
    ? order.demands
    : (Array.isArray(order?.demands?.rows) ? order.demands.rows : [])
  for (const row of rows) {
    const href = row?.meta?.href || row?.href
    const type = row?.meta?.type || row?.type || 'demand'
    add(row?.id || idFromHref(href), type)
  }
  if (opened?.id) add(opened.id, opened.kind, opened)
  return links
}

function stampOrder(document, order) {
  document.customerOrder = {
    ...(document.customerOrder || {}),
    id: order.id,
    name: order.name,
    moment: order.moment,
    sum: order.sum,
    meta: order.meta,
  }
  return document
}

function assembleCheckedOrder(order, shipments) {
  const markups = shipments
    .map((shipment) => shipment.markup)
    .filter((markup) => markup != null && Number.isFinite(markup))
  return {
    id: order.id,
    name: order.name || order.id.slice(0, 8),
    moment: order.moment || null,
    sum: minorToRub(order.sum),
    href: order.meta?.uuidHref || null,
    agent: {
      id: order.agent?.id || shipments[0]?.agent?.id || null,
      name: order.agent?.name || shipments[0]?.agent?.name || 'Контрагент',
    },
    shipments: [...shipments].sort((a, b) => (a.markup ?? 9999) - (b.markup ?? 9999)),
    lowestMarkup: markups.length ? Math.min(...markups) : null,
    saleExVat: Math.round(shipments.reduce((total, shipment) => {
      return total + Math.round((shipment.saleExVat ?? 0) * 100)
    }, 0)) / 100,
    priceCut: shipments.some((shipment) => shipment.priceCut),
  }
}

function checkStats(shipments, threshold) {
  const lines = shipments.flatMap((shipment) => shipment.lines || [])
  const missed = missedProfit(lines, threshold)
  const money = monthTotals(lines)
  const positions = shipments.reduce((sum, shipment) => sum + (shipment.positions?.length || 0), 0)
  const lowPositions = shipments.reduce((sum, shipment) => sum + (shipment.lowPositions || 0), 0)
  return {
    documents: shipments.length,
    positions,
    lowPositions,
    lowDocuments: shipments.filter((shipment) => shipment.low).length,
    noCost: shipments.filter((shipment) => shipment.costStatus === 'none' || shipment.costStatus === 'zero').length,
    averageMarkup: averageMarkup(lines),
    sales: minorToRub(money.salesMinor) ?? 0,
    profit: minorToRub(money.profitMinor) ?? 0,
    missed: minorToRub(missed.amountMinor) ?? 0,
    missedPositions: missed.positions,
  }
}

export async function buildOrderCheck({ client, link, threshold, postedOnly = true, signal, onProgress }) {
  const limit = assertThreshold(threshold)
  const ref = parseOrderLink(link)
  const progress = (patch) => onProgress?.({ step: 'work', ...patch })

  progress({ message: 'Открываю документ' })
  const employee = await client.get('/context/employee', {}, signal)
  const account = { name: employee?.name || employee?.shortFio || '', uid: employee?.uid || '' }

  let order = null
  let loneDocument = null
  let opened = null
  if (ref.kind === 'customerorder') {
    order = await client.get(`/entity/customerorder/${ref.id}`, { expand: 'agent' }, signal)
  } else {
    const document = await client.get(`/entity/${ref.kind}/${ref.id}`, { expand: 'customerOrder,agent' }, signal)
    const orderId = document.customerOrder?.id || idFromHref(document.customerOrder?.meta?.href)
    if (orderId) {
      opened = { ...document, kind: ref.kind }
      order = await client.get(`/entity/customerorder/${orderId}`, { expand: 'agent' }, signal)
    } else {
      loneDocument = { ...document, kind: ref.kind }
    }
  }
  if (order && !order.id) {
    throw Object.assign(new Error('МойСклад не вернул заказ'), { statusCode: 502 })
  }

  const documents = []
  if (loneDocument) {
    documents.push(loneDocument)
  } else {
    const links = saleDocumentLinks(order, opened)
    progress({
      message: links.length ? `Отгрузки заказа: ${links.length}` : 'У заказа нет связанных отгрузок',
      loaded: 0,
      total: links.length,
    })
    let done = 0
    await mapPool(links, 2, async (link) => {
      const document = link.prefetched || await client.get(
        `/entity/${link.kind}/${link.id}`,
        { expand: 'customerOrder,agent' },
        signal,
      )
      done += 1
      progress({
        message: `Отгрузки заказа: ${done} из ${links.length}`,
        loaded: done,
        total: links.length,
      })
      if (postedOnly && document.applicable === false) return
      documents.push(stampOrder({ ...document, kind: link.kind }, order))
    })
  }

  let source = loneDocument ? 'document' : 'shipments'
  let loaded
  if (documents.length === 0) {
    source = 'order'
    progress({ message: 'Отгрузок нет, смотрю позиции заказа' })
    const positions = await fetchAll(
      client,
      `/entity/customerorder/${order.id}/positions`,
      { expand: 'assortment' },
      { pageLimit: 1000, signal },
    )
    loaded = [{
      document: stampOrder({ ...order, kind: 'customerorder' }, order),
      positions,
    }]
  } else {
    let done = 0
    loaded = await mapPool(documents, 2, async (document) => {
      const positions = await fetchAll(
        client,
        `/entity/${document.kind}/${document.id}/positions`,
        { expand: 'assortment' },
        { pageLimit: 1000, signal },
      )
      done += 1
      progress({
        message: `Позиции: ${done} из ${documents.length}`,
        loaded: done,
        total: documents.length,
      })
      return { document, positions }
    })
  }

  const agentsById = new Map()
  const agent = order?.agent || loneDocument?.agent
  if (agent?.id) agentsById.set(agent.id, agent)
  const timelines = await loadSupplyTimelines(client, loaded, postedOnly, progress, signal)
  const shipments = loaded.map(({ document, positions }) => presentShipment(
    document,
    positions,
    limit,
    agentsById,
    (position, demand) => lastSupplyUnitMinor(
      timelines,
      position.assortment,
      demand.customerOrder?.moment || demand.moment,
    ),
  ))
  const stats = checkStats(shipments, limit)
  const audit = await loadPriceCuts(client, shipments, progress, signal)
  for (const shipment of shipments) delete shipment.lines

  let note = source === 'order'
    ? (postedOnly
      ? 'Проведённых отгрузок и продаж нет. Показаны позиции заказа.'
      : 'Отгрузок и продаж нет. Показаны позиции заказа.')
    : (source === 'document' ? 'У документа нет заказа. Проверена только эта отгрузка или продажа.' : '')
  if (stats.positions === 0) note = [note, 'Позиций нет.'].filter(Boolean).join(' ')

  return {
    threshold: limit,
    postedOnly,
    account,
    source,
    note,
    auditNote: shipments.some((shipment) => shipment.low) ? auditMessage(audit) : '',
    stats,
    order: order ? assembleCheckedOrder(order, shipments) : null,
    shipment: order ? null : shipments[0] || null,
  }
}

export async function buildReport({ client, month, group, threshold, postedOnly = true, signal, onProgress }) {
  const groupName = assertGroupName(group)
  const limit = assertThreshold(threshold)
  const bounds = monthBounds(month)
  const progress = (patch) => onProgress?.({ step: 'work', ...patch })

  progress({ message: 'Проверяю доступ к МоемуСкладу' })
  const employee = await client.get('/context/employee', {}, signal)

  const agents = await loadCounterparties(client, groupName, signal, progress)
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]))

  if (agents.length === 0) {
    progress({ message: 'Группа не найдена, смотрю какие метки есть у контрагентов' })
    const suggestions = await sampleTags(client, signal)
    return emptyReport({
      month,
      group: groupName,
      threshold: limit,
      postedOnly,
      employee,
      emptyReason: 'group',
      suggestions,
    })
  }

  const documents = []
  for (const source of SALE_DOCUMENTS) {
    const rows = await loadDocuments(client, {
      ...source,
      bounds,
      postedOnly,
      agents,
      signal,
      onProgress: progress,
    })
    documents.push(...rows)
  }

  let done = 0
  const loaded = await mapPool(documents, 2, async (document) => {
    const positions = await fetchAll(
      client,
      `/entity/${document.kind}/${document.id}/positions`,
      { expand: 'assortment' },
      { pageLimit: 1000, signal },
    )
    done += 1
    progress({
      message: `Позиции: ${done} из ${documents.length}`,
      loaded: done,
      total: documents.length,
    })
    return { document, positions }
  })

  const timelines = await loadSupplyTimelines(client, loaded, postedOnly, progress, signal)
  const shipments = loaded.map(({ document, positions }) => presentShipment(
    document,
    positions,
    limit,
    agentsById,
    (position, demand) => lastSupplyUnitMinor(
      timelines,
      position.assortment,
      demand.customerOrder?.moment || demand.moment,
    ),
  ))

  const lines = shipments.flatMap((shipment) => shipment.lines)
  const missed = missedProfit(lines, limit)
  const monthMarkup = averageMarkup(lines)
  const money = monthTotals(lines)
  const audit = await loadPriceCuts(client, shipments, progress, signal)
  for (const shipment of shipments) delete shipment.lines
  const grouped = groupReport(shipments, limit)
  const noCost = shipments.filter((shipment) => shipment.costStatus === 'none' || shipment.costStatus === 'zero').length
  const lowShipments = shipments.filter((shipment) => shipment.low).length
  const share = documentShare(shipments)

  return {
    month,
    periodLabel: periodLabel(month),
    group: groupName,
    threshold: limit,
    postedOnly,
    account: { name: employee?.name || employee?.shortFio || '', uid: employee?.uid || '' },
    emptyReason: grouped.orders.length === 0 && grouped.unlinked.length === 0
      ? (documents.length === 0 ? 'shipments' : 'threshold')
      : null,
    suggestions: [],
    auditNote: auditMessage(audit),
    stats: {
      wholesalers: agents.length,
      shipments: shipments.length,
      lowShipments,
      orders: grouped.orders.length,
      unlinked: grouped.unlinked.length,
      noCost,
      averageMarkup: monthMarkup,
      sales: minorToRub(money.salesMinor) ?? 0,
      profit: minorToRub(money.profitMinor) ?? 0,
      share,
      missed: minorToRub(missed.amountMinor) ?? 0,
      missedPositions: missed.positions,
      missedSale: minorToRub(missed.saleMinor) ?? 0,
      missedTarget: minorToRub(missed.targetMinor) ?? 0,
    },
    orders: grouped.orders,
    unlinked: grouped.unlinked,
  }
}

export function documentShare(shipments) {
  const share = {
    demand: { ok: 0, low: 0, unknown: 0 },
    retaildemand: { ok: 0, low: 0, unknown: 0 },
  }
  for (const shipment of shipments) {
    const kind = shipment.kind === 'retaildemand' ? 'retaildemand' : 'demand'
    const bucket = shipment.low
      ? 'low'
      : (typeof shipment.markup === 'number' && Number.isFinite(shipment.markup) ? 'ok' : 'unknown')
    share[kind][bucket] += 1
  }
  return share
}

function emptyReport({ month, group, threshold, postedOnly, employee, emptyReason, suggestions }) {
  return {
    month,
    periodLabel: periodLabel(month),
    group,
    threshold,
    postedOnly,
    account: { name: employee?.name || employee?.shortFio || '', uid: employee?.uid || '' },
    emptyReason,
    suggestions,
    stats: {
      wholesalers: 0,
      shipments: 0,
      lowShipments: 0,
      orders: 0,
      unlinked: 0,
      noCost: 0,
      averageMarkup: null,
      sales: 0,
      profit: 0,
      share: documentShare([]),
      missed: 0,
      missedPositions: 0,
      missedSale: 0,
      missedTarget: 0,
    },
    orders: [],
    unlinked: [],
  }
}
