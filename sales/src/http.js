import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReturnCard } from './cards.js'
import { openReturnStore } from './card-store.js'
import { loadPayment, saleLines, searchSales, suggestProducts } from './search.js'
import { pendingReservations, reservePending, reviewReturn } from './returns.js'
import { returnDocumentHtml, slotLabel } from './return-document.js'
import { confirmMessage, settleReturn } from './confirm-return.js'
import { compensationLabel, readReturnPhoto, removeReturnPhotos, saveReturnPhotos } from './return-files.js'

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const returnStore = openReturnStore(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'returns.sqlite'))
const returnFiles = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'return-files')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const files = new Map([
  ['/sales', 'index.html'],
  ['/sales/', 'index.html'],
  ['/sales/index.html', 'index.html'],
  ['/sales/styles.css', 'styles.css'],
  ['/sales/app.js', 'app.js'],
])

export async function handleSales(req, res, url, { createClient }) {
  if (req.method === 'GET' && url.pathname === '/sales/api/status') {
    sendJson(res, 200, { hasToken: Boolean(process.env.MOYSKLAD_TOKEN?.trim()) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/sales/api/search') {
    await searchRequest(req, res, createClient)
    return
  }

  if (req.method === 'POST' && url.pathname === '/sales/api/suggest') {
    await suggestRequest(req, res, createClient)
    return
  }

  if (req.method === 'GET' && url.pathname === '/sales/api/returns') {
    sendJson(res, 200, { cards: returnStore.list() })
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/sales/api/returns/') && url.pathname.endsWith('/document')) {
    const id = decodeURIComponent(url.pathname.slice('/sales/api/returns/'.length, -'/document'.length))
    await returnDocumentRequest(res, id)
    return
  }

  if (req.method === 'GET' && /\/sales\/api\/returns\/[^/]+\/files\/[^/]+$/.test(url.pathname)) {
    const match = /^\/sales\/api\/returns\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname)
    await returnFileRequest(res, decodeURIComponent(match[1]), decodeURIComponent(match[2]))
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/sales/api/returns/') && url.pathname.endsWith('/confirm')) {
    const id = decodeURIComponent(url.pathname.slice('/sales/api/returns/'.length, -'/confirm'.length))
    await confirmReturnRequest(req, res, createClient, id)
    return
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/sales/api/returns/')) {
    const id = decodeURIComponent(url.pathname.slice('/sales/api/returns/'.length))
    if (!/^[0-9a-zA-Z-]{1,80}$/.test(id)) {
      sendJson(res, 400, { message: 'Некорректная карточка' })
      return
    }
    if (!returnStore.remove(id)) {
      sendJson(res, 404, { message: 'Карточка не найдена' })
      return
    }
    await removeReturnPhotos(returnFiles, id)
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && url.pathname === '/sales/api/return-check') {
    await returnCheckRequest(req, res, createClient)
    return
  }

  if (req.method === 'GET' && files.has(url.pathname)) {
    await serveFile(res, files.get(url.pathname))
    return
  }

  sendJson(res, 404, { message: 'Не найдено' })
}

async function searchRequest(req, res, createClient) {
  const body = await readBody(req)
  const token = resolveToken(body.token)
  const controller = new AbortController()
  const stop = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.on('aborted', () => controller.abort())
  res.on('close', stop)

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  const write = (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
  }

  try {
    const result = await searchSales({
      client: createClient(token),
      month: body.month,
      product: body.product,
      number: body.number,
      postedOnly: body.postedOnly !== false,
      signal: controller.signal,
      onProgress: (progress) => write({ type: 'progress', ...progress }),
    })
    applyStoredReservations(result.sales)
    write({ type: 'result', result })
    console.log(`sales ${result.month} rows=${result.sales.length}`)
  } catch (error) {
    if (error?.name === 'AbortError') return
    write({ type: 'error', message: error?.message || 'Не удалось найти продажи' })
    console.error(error?.message || error)
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function applyStoredReservations(sales) {
  const cards = returnStore.list()
  for (const sale of sales || []) {
    const pending = pendingReservations(cards, sale)
    if (!pending.qty.size && !pending.sum) continue
    sale.lines = reservePending(sale.lines, pending)
    if (!sale.returns) continue
    if (sale.returns.paidRemaining != null) {
      sale.returns.paidRemaining = Math.max(0, Math.round((sale.returns.paidRemaining - pending.sum) * 100) / 100)
    }
    sale.returns.returnedSum = Math.round(((Number(sale.returns.returnedSum) || 0) + pending.sum) * 100) / 100
  }
}

async function suggestRequest(req, res, createClient) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  req.on('aborted', stop)
  res.on('close', stop)
  try {
    const body = await readBody(req)
    const items = await suggestProducts(createClient(resolveToken(body.token)), body.q, controller.signal)
    if (!res.writableEnded) sendJson(res, 200, { items })
  } catch (error) {
    if (error?.name === 'AbortError' || res.writableEnded) return
    sendJson(res, error.statusCode || 500, { message: error?.message || 'Не удалось найти товары' })
  }
}

async function confirmReturnRequest(req, res, createClient, id) {
  try {
    if (!/^[0-9a-zA-Z-]{1,80}$/.test(id)) {
      sendJson(res, 400, { message: 'Некорректная карточка' })
      return
    }
    const card = returnStore.get(id)
    if (!card) {
      sendJson(res, 404, { message: 'Карточка не найдена' })
      return
    }
    const body = await readBody(req)
    const client = createClient(resolveToken(body.token))
    const saved = await settleReturn(client, card, {
      save: async (next) => {
        if (!returnStore.update(next)) {
          throw Object.assign(new Error('Документ создан, но карточку не удалось обновить.'), { statusCode: 500 })
        }
      },
    })
    sendJson(res, 200, {
      ok: true,
      card: saved,
      message: confirmMessage(saved),
    })
  } catch (error) {
    sendJson(res, error.statusCode || 500, { message: error.message || 'Не удалось провести возврат' })
  }
}

async function returnCheckRequest(req, res, createClient) {
  try {
    const body = await readBody(req)
    const kind = body.kind
    const id = String(body.id || '').trim()
    if (!id || (kind !== 'demand' && kind !== 'retaildemand')) {
      sendJson(res, 200, { ok: false, message: 'Возврат только по отгрузке или продаже.' })
      return
    }
    if (!compensationLabel(body.compensation)) {
      sendJson(res, 200, { ok: false, message: 'Выберите компенсацию: наличные или безнал.' })
      return
    }
    const compensationNote = body.compensation === 'cashless' ? String(body.compensationNote || '').trim() : ''
    if (body.compensation === 'cashless' && !compensationNote) {
      sendJson(res, 200, { ok: false, message: 'Укажите способ возврата и реквизиты.' })
      return
    }
    const client = createClient(resolveToken(body.token))
    const document = await client.get(`/entity/${kind}/${id}`, {
      expand: 'agent,customerOrder,customerOrder.agent',
    })
    document.kind = kind
    document.id = document.id || id
    document.payment = await loadPayment(client, document)
    const positions = await readPositions(client, kind, document.id)
    const lines = saleLines(document, positions)
    const pending = pendingReservations(returnStore.list(), document)
    const result = await reviewReturn({
      client,
      document,
      lines,
      requested: body.lines,
      reason: body.reason,
      pending,
    })
    if (result.ok) {
      const card = buildReturnCard({
        document,
        lines,
        requested: body.lines,
        reason: body.reason,
        compensation: body.compensation,
        compensationNote,
      })
      card.photos = await saveReturnPhotos(returnFiles, card.id, body.photos)
      result.card = returnStore.save(card)
      result.lines = reservePending(result.lines, pendingReservations(returnStore.list(), document))
      delete result.message
    }
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, error.statusCode || 500, { message: error.message || 'Не удалось проверить возврат' })
  }
}

async function readPositions(client, kind, id) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 20; page += 1) {
    const data = await client.get(`/entity/${kind}/${id}/positions`, {
      expand: 'assortment',
      limit: 1000,
      offset,
    })
    const chunk = Array.isArray(data?.rows) ? data.rows : []
    rows.push(...chunk)
    const total = Number(data?.meta?.size ?? rows.length)
    if (chunk.length === 0 || rows.length >= total) return rows
    offset += chunk.length
  }
  return rows
}

async function returnFileRequest(res, cardId, fileId) {
  const card = returnStore.get(cardId)
  const known = card?.photos?.some((photo) => photo.id === fileId)
  const data = known ? await readReturnPhoto(returnFiles, cardId, fileId) : null
  if (!data) {
    sendJson(res, 404, { message: 'Фото не найдено' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

async function returnDocumentRequest(res, id) {
  if (!/^[0-9a-zA-Z-]{1,80}$/.test(id)) {
    sendJson(res, 400, { message: 'Некорректная карточка' })
    return
  }
  const card = returnStore.get(id)
  if (!card) {
    sendJson(res, 404, { message: 'Карточка не найдена' })
    return
  }
  const images = []
  for (const photo of card.photos || []) {
    const data = await readReturnPhoto(returnFiles, id, photo.id)
    if (!data) continue
    images.push({
      slot: photo.slot,
      label: slotLabel(photo.slot),
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    })
  }
  const html = returnDocumentHtml(card, images)
  const name = String(card.document?.name || 'vozvrat').replace(/[^\w.-]+/g, '')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="vozvrat-${name || 'document'}.html"`,
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

async function serveFile(res, name) {
  const filePath = normalize(join(publicDir, name))
  const rootWithSep = publicDir.endsWith(sep) ? publicDir : publicDir + sep
  if (filePath !== publicDir && !filePath.startsWith(rootWithSep)) {
    sendJson(res, 403, { message: 'Запрещено' })
    return
  }
  const data = await readFile(filePath)
  res.writeHead(200, {
    'Content-Type': types[extname(filePath)] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function resolveToken(bodyToken) {
  const fromBody = typeof bodyToken === 'string' ? bodyToken.trim() : ''
  if (fromBody) return fromBody
  const fromEnv = process.env.MOYSKLAD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  throw Object.assign(
    new Error('Укажите токен МоегоСклада в поле на странице или в файле .env (MOYSKLAD_TOKEN).'),
    { statusCode: 400 },
  )
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 12_000_000) {
        reject(Object.assign(new Error('Слишком большой запрос'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}
