// Проверки перед возвратом. Документ в МойСклад отсюда не создаётся.

export const RETURN_WINDOW_DAYS = 20

export const RETURN_REASONS = [
  ['defect', 'Брак'],
  ['fit', 'Не подошло'],
  ['mistake', 'Ошибка в документе'],
  ['extra', 'Лишний товар'],
]

const API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'
const REASON_LABELS = new Map(RETURN_REASONS)

export function ageInDays(moment, today = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(moment || ''))
  if (!match) return null
  const documentDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const currentDate = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((currentDate - documentDate) / 86400000)
}

export function assessReturn({ kind, moment, payment, lines, returnedQty, returnedSumMinor, today }) {
  const ageDays = ageInDays(moment, today)
  const returnedSum = minorToRub(returnedSumMinor)
  const decorated = decorateLines(lines, returnedQty)
  const base = {
    returnable: false,
    block: 'unknown',
    windowDays: RETURN_WINDOW_DAYS,
    ageDays,
    paidRemaining: null,
    returnedSum,
    lines: decorated,
  }
  if (kind === 'customerorder') return finish(base, 'order', payment)
  if (payment?.status !== 'paid') {
    return finish(base, payment?.status === 'unknown' ? 'unknown' : 'payment', payment)
  }
  if (ageDays == null || ageDays > RETURN_WINDOW_DAYS) return finish(base, 'window', payment)
  const paid = Number(payment.payed)
  const remaining = Math.max(0, roundMoney((Number.isFinite(paid) ? paid : 0) - returnedSum))
  return finish({
    ...base,
    returnable: true,
    block: null,
    paidRemaining: remaining,
  }, null, payment)
}

export function judgeReturn({ state, lines, requested, reason }) {
  const returns = publicReturns(state)
  if (!REASON_LABELS.has(reason)) {
    return { ok: false, message: 'Укажите причину возврата.', returns, lines: state.lines }
  }
  if (!state.returnable) {
    return { ok: false, message: returns.message, returns, lines: state.lines }
  }
  const asks = Array.isArray(requested) ? requested.filter((item) => Number(item?.quantity) > 0) : []
  if (!asks.length) {
    return { ok: false, message: 'Выберите позиции к возврату.', returns, lines: state.lines }
  }
  let amount = 0
  for (const ask of asks) {
    const line = (lines || state.lines || []).find((item) => sameLine(item, ask))
    if (!line) {
      return { ok: false, message: 'Этой позиции нет в документе.', returns, lines: state.lines }
    }
    const quantity = Number(ask.quantity)
    if (quantity > Number(line.available) + 0.0001) {
      const reserved = Number(line.reserved) > 0
      const available = Math.max(0, Number(line.available) || 0)
      return {
        ok: false,
        message: reserved
          ? available > 0
            ? `В карточке возврата уже есть эта позиция. Доступно ${formatQty(available)}.`
            : 'Эта позиция уже есть в карточке возврата.'
          : 'Количество больше остатка к возврату.',
        returns,
        lines: state.lines,
      }
    }
    const unit = Number(line.price)
    const full = Number(line.quantity) > 0 && quantity === Number(line.quantity) ? Number(line.sum) : null
    amount += Number.isFinite(full) ? full : roundMoney((Number.isFinite(unit) ? unit : 0) * quantity)
  }
  amount = roundMoney(amount)
  if (amount > Number(state.paidRemaining) + 0.001) {
    return {
      ok: false,
      message: `Сумма больше остатка оплаты. Доступно ${formatMoney(state.paidRemaining)}.`,
      returns,
      lines: state.lines,
    }
  }
  return {
    ok: true,
    message: 'Проверки пройдены. Возврат пока не создаём.',
    returns,
    lines: state.lines,
  }
}

export async function attachReturns(client, sale, document, signal) {
  const empty = new Map()
  let state = assessReturn({
    kind: sale.kind,
    moment: sale.moment,
    payment: sale.payment,
    lines: sale.lines || [],
    returnedQty: empty,
    returnedSumMinor: 0,
  })
  if (state.returnable && Array.isArray(sale.lines)) {
    const history = await loadReturned(client, document, signal)
    state = assessReturn({
      kind: sale.kind,
      moment: sale.moment,
      payment: sale.payment,
      lines: sale.lines,
      returnedQty: history.qty,
      returnedSumMinor: history.sumMinor,
    })
  }
  sale.returns = publicReturns(state)
  if (Array.isArray(sale.lines)) sale.lines = state.lines
}

export async function reviewReturn({ client, document, lines, requested, reason, signal, today, pending }) {
  const history = document.payment?.status === 'paid'
    ? await loadReturned(client, document, signal)
    : { qty: new Map(), sumMinor: 0 }
  const state = assessReturn({
    kind: document.kind,
    moment: document.moment,
    payment: document.payment,
    lines,
    returnedQty: history.qty,
    returnedSumMinor: history.sumMinor,
    today,
  })
  const reserved = reservePending(state.lines, pending)
  const pendingSum = Number(pending?.sum) || 0
  const paidRemaining = state.paidRemaining == null
    ? null
    : Math.max(0, roundMoney(state.paidRemaining - pendingSum))
  const next = {
    ...state,
    lines: reserved,
    paidRemaining,
    returnedSum: roundMoney((state.returnedSum || 0) + pendingSum),
  }
  return judgeReturn({ state: next, lines: reserved, requested, reason })
}

export function pendingReservations(cards, document) {
  const qty = new Map()
  let sum = 0
  const kind = document?.kind
  const id = document?.id
  for (const card of cards || []) {
    if (!card?.document || card.document.kind !== kind || card.document.id !== id) continue
    if (card.status === 'confirmed') continue
    sum = roundMoney(sum + (Number(card.amount) || 0))
    for (const line of card.lines || []) {
      const quantity = Number(line.quantity) || 0
      if (!(quantity > 0)) continue
      if (line.assortmentHref) addQty(qty, `href:${line.assortmentHref}`, quantity)
      if (line.code) addQty(qty, `code:${line.code}`, quantity)
    }
  }
  return { qty, sum }
}

export function reservePending(lines, pending) {
  return (lines || []).map((line) => {
    const reserved = takenQty(pending?.qty, line)
    const returned = Number(line.returned) || 0
    const shipped = Math.max(0, Number(line.quantity) || 0)
    const available = Math.max(0, roundQty(shipped - returned - reserved))
    return { ...line, reserved, available }
  })
}

function addQty(qty, key, quantity) {
  qty.set(key, (qty.get(key) || 0) + quantity)
}

function takenQty(qtyMap, line) {
  if (!qtyMap) return 0
  const byHref = line?.assortmentHref ? Number(qtyMap.get(`href:${line.assortmentHref}`)) || 0 : 0
  const byCode = line?.code ? Number(qtyMap.get(`code:${line.code}`)) || 0 : 0
  return Math.max(byHref, byCode)
}

function finish(state, block, payment) {
  const next = { ...state, block, returnable: block == null }
  next.message = returnBlockMessage(next, payment)
  return next
}

function publicReturns(state) {
  return {
    returnable: state.returnable,
    block: state.block,
    message: state.message || returnBlockMessage(state),
    windowDays: state.windowDays,
    ageDays: state.ageDays,
    paidRemaining: state.paidRemaining,
    returnedSum: state.returnedSum,
  }
}

export function returnBlockMessage(state, payment) {
  if (state?.block === 'order') return 'Возврат только по отгрузке или продаже.'
  if (state?.block === 'window') return `Срок возврата истёк. Можно в течение ${state.windowDays} дней.`
  if (state?.block === 'payment') {
    const documentPaid = payment?.source === 'document'
    if (payment?.status === 'partial') {
      return documentPaid
        ? 'Документ оплачен не полностью. Возврат недоступен.'
        : 'Заказ оплачен не полностью. Возврат недоступен.'
    }
    return documentPaid
      ? 'Документ не оплачен. Возврат недоступен.'
      : 'Заказ не оплачен. Возврат недоступен.'
  }
  if (state?.block === 'unknown' || state?.block) return 'Оплату заказа не удалось проверить. Возврат недоступен.'
  return ''
}

function decorateLines(lines, qtyMap) {
  return (lines || []).map((line) => {
    const shipped = Math.max(0, Number(line.quantity) || 0)
    const returned = returnedQty(qtyMap, line)
    return {
      ...line,
      returned,
      available: Math.max(0, roundQty(shipped - returned)),
    }
  })
}

function returnedQty(qtyMap, line) {
  if (!qtyMap) return 0
  if (line?.assortmentHref && qtyMap.has(`href:${line.assortmentHref}`)) return qtyMap.get(`href:${line.assortmentHref}`)
  if (line?.code && qtyMap.has(`code:${line.code}`)) return qtyMap.get(`code:${line.code}`)
  return 0
}

function sameLine(line, requested) {
  if (requested?.assortmentHref && line?.assortmentHref === requested.assortmentHref) return true
  return Boolean(requested?.code && line?.code && requested.code === line.code)
}

async function loadReturned(client, document, signal) {
  const targets = new Map()
  const add = (kind, id) => {
    if (kind && id) targets.set(`${kind}:${id}`, { kind, id })
  }
  add(document.kind, document.id)
  const orderId = document.customerOrder?.id || idFromHref(document.customerOrder?.meta?.href)
  if (orderId && document.payment?.source === 'order') {
    let refs = demandRefs(document.customerOrder)
    if (!refs) {
      const order = await client.get(`/entity/customerorder/${orderId}`, {}, signal)
      refs = demandRefs(order) || []
    }
    for (const row of refs) {
      const id = row?.id || idFromHref(row?.meta?.href || row?.href)
      const kind = linkedKind(row) === 'retaildemand' || (id === document.id && document.kind === 'retaildemand')
        ? 'retaildemand'
        : 'demand'
      add(kind, id)
    }
    const sales = await retailSalesForOrders(
      client,
      [{ id: orderId, moment: document.customerOrder?.moment || document.moment }],
      retailWindow(
        [{ moment: document.customerOrder?.moment || document.moment }],
        {
          from: shiftMoment(document.customerOrder?.moment || document.moment, -1),
          to: shiftMoment(document.customerOrder?.moment || document.moment, 45),
        },
      ),
      signal,
    )
    for (const row of sales) add('retaildemand', row?.id)
  }
  const qty = new Map()
  let sumMinor = 0
  for (const target of targets.values()) {
    const rows = await returnsOf(client, target, signal)
    for (const row of rows) {
      sumMinor += Number(row?.sum) || 0
      let positions = expandedRows(row?.positions)
      const size = Number(row?.positions?.meta?.size ?? positions.length)
      if (size > positions.length && row?.id) {
        const returnKind = target.kind === 'retaildemand' ? 'retailsalesreturn' : 'salesreturn'
        positions = await fetchAll(client, `/entity/${returnKind}/${row.id}/positions`, {
          expand: 'assortment',
        }, { signal })
      }
      for (const position of positions) addPositionQty(qty, position)
    }
  }
  return { qty, sumMinor }
}

async function returnsOf(client, target, signal) {
  const retail = target.kind === 'retaildemand'
  const path = retail ? '/entity/retailsalesreturn' : '/entity/salesreturn'
  const field = retail ? 'retailDemand' : 'demand'
  try {
    return await fetchAll(client, path, {
      filter: `${field}=${entityUrl(target.kind, target.id)};applicable=true`,
      expand: 'positions.assortment',
    }, { signal, pageLimit: 100 })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (/неизвестное поле фильтрации/i.test(error?.message || '')) return []
    throw error
  }
}

function addPositionQty(qty, position) {
  const quantity = Math.abs(Number(position?.quantity) || 0)
  if (!quantity) return
  const href = entityHref(position?.assortment)
  const code = position?.assortment?.code || ''
  if (href) qty.set(`href:${href}`, (qty.get(`href:${href}`) || 0) + quantity)
  if (code) qty.set(`code:${code}`, (qty.get(`code:${code}`) || 0) + quantity)
}

function entityUrl(kind, id) {
  return `${API_ROOT}/entity/${kind}/${id}`
}

function entityHref(row) {
  const href = row?.meta?.href
  return href ? String(href).split('?')[0] : ''
}

function linkedKind(row) {
  const type = row?.meta?.type || row?.type || ''
  if (type === 'demand' || type === 'retaildemand') return type
  const href = String(row?.meta?.href || row?.href || '')
  if (href.includes('/entity/retaildemand/')) return 'retaildemand'
  if (href.includes('/entity/demand/')) return 'demand'
  return 'demand'
}

export async function retailSalesForOrders(client, orders, bounds, signal) {
  const ids = new Set((orders || []).map((order) => order?.id).filter(Boolean))
  if (!ids.size || !bounds?.from || !bounds?.to) return []
  const rows = await fetchAll(client, '/entity/retaildemand', {
    filter: `moment>=${bounds.from};moment<=${bounds.to};applicable=true`,
    expand: 'agent,customerOrder,customerOrder.agent',
    order: 'moment,desc',
  }, { signal, pageLimit: 1000 })
  return rows.filter((row) => row?.id && ids.has(row.customerOrder?.id || idFromHref(row.customerOrder?.meta?.href)))
}

export function retailWindow(orders, bounds) {
  let from = bounds?.from || ''
  let to = bounds?.to || ''
  for (const order of orders || []) {
    const start = shiftMoment(order?.moment, -1)
    const end = shiftMoment(order?.moment, 45)
    if (start && (!from || start < from)) from = start
    if (end && (!to || end > to)) to = end
  }
  return { from, to }
}

export function shiftMoment(moment, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(moment || ''))
  if (!match) return ''
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day} ${days < 0 ? '00:00:00' : '23:59:59'}`
}

function demandRefs(order) {
  if (Array.isArray(order?.demands)) return order.demands
  if (Array.isArray(order?.demands?.rows)) return order.demands.rows
  return null
}

function idFromHref(href) {
  const clean = String(href || '').split('?')[0].replace(/\/$/, '')
  if (!clean) return ''
  return clean.split('/').pop() || ''
}

function expandedRows(collection) {
  if (Array.isArray(collection)) return collection
  if (Array.isArray(collection?.rows)) return collection.rows
  return []
}

function minorToRub(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return roundMoney(number / 100)
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}

function roundQty(value) {
  return Math.round(Number(value) * 1000) / 1000
}

function formatMoney(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0,00'
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)
}

function formatQty(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(Number(value) || 0)
}

async function fetchAll(client, path, params, { signal, pageLimit = 1000 } = {}) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 20; page += 1) {
    const data = await client.get(path, { ...params, limit: pageLimit, offset }, signal)
    const chunk = Array.isArray(data?.rows) ? data.rows : []
    rows.push(...chunk)
    const total = Number(data?.meta?.size ?? rows.length)
    if (chunk.length === 0 || rows.length >= total) return rows
    offset += chunk.length
  }
  return rows
}
