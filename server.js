import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WHOLESALE_GROUP } from './src/markup.js'
import { createClient } from './src/moysklad.js'
import { buildOrderCheck, buildReport, refreshPriceCuts } from './src/report.js'
import { openStore } from './src/store.js'

const root = dirname(fileURLToPath(import.meta.url))
const publicDir = join(root, 'public')
const store = openStore(join(root, 'data', 'reports.sqlite'))

loadDotEnv(join(root, '.env'))

const port = Number(process.env.PORT) || 4173
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function loadDotEnv(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64_000) {
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

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = normalize(join(publicDir, relative))
  const rootWithSep = publicDir.endsWith(sep) ? publicDir : publicDir + sep
  if (filePath !== publicDir && !filePath.startsWith(rootWithSep)) {
    sendJson(res, 403, { message: 'Запрещено' })
    return
  }
  try {
    const data = await readFile(filePath)
    const type = types[extname(filePath)] || 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    })
    res.end(data)
  } catch {
    sendJson(res, 404, { message: 'Не найдено' })
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, { hasToken: Boolean(process.env.MOYSKLAD_TOKEN?.trim()) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/reports/price-cuts') {
      const body = await readBody(req)
      const token = resolveToken(body.token)
      const month = String(body.month || '')
      const saved = store.get(month)
      if (!saved) {
        sendJson(res, 404, { message: 'Нет сохранённой проверки' })
        return
      }
      const summary = await refreshPriceCuts(createClient(token), saved.report)
      store.save(saved.report, saved.savedAt)
      sendJson(res, 200, summary)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/order-check') {
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

      const started = Date.now()
      try {
        const check = await buildOrderCheck({
          client: createClient(token),
          link: body.link,
          threshold: body.threshold ?? 18,
          postedOnly: body.postedOnly !== false,
          signal: controller.signal,
          onProgress: (progress) => write({ type: 'progress', ...progress }),
        })
        write({ type: 'result', check, elapsedMs: Date.now() - started })
        console.log(
          `order-check ${check.order?.name || check.shipment?.name || ''} source=${check.source} low=${check.stats.lowDocuments}`,
        )
      } catch (error) {
        if (error?.name === 'AbortError') return
        write({ type: 'error', message: error?.message || 'Не удалось проверить заказ' })
        console.error(error?.message || error)
      } finally {
        if (!res.writableEnded) res.end()
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/report') {
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

      const started = Date.now()
      try {
        const client = createClient(token)
        const report = await buildReport({
          client,
          month: body.month,
          group: WHOLESALE_GROUP,
          threshold: body.threshold ?? 18,
          postedOnly: body.postedOnly !== false,
          signal: controller.signal,
          onProgress: (progress) => write({ type: 'progress', ...progress }),
        })
        const saved = report.emptyReason === 'group' ? null : store.save(report)
        write({ type: 'result', report, elapsedMs: Date.now() - started, savedAt: saved?.savedAt ?? null })
        console.log(
          `report ${report.month} «${report.group}» orders=${report.stats.orders} low=${report.stats.lowShipments} shipments=${report.stats.shipments}`,
        )
      } catch (error) {
        if (error?.name === 'AbortError') return
        write({ type: 'error', message: error?.message || 'Не удалось собрать отчёт' })
        console.error(error?.message || error)
      } finally {
        if (!res.writableEnded) res.end()
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/reports') {
      const year = url.searchParams.get('year')
      if (!/^\d{4}$/.test(year || '')) {
        sendJson(res, 400, { message: 'Год укажите в формате ГГГГ' })
        return
      }
      sendJson(res, 200, { year: Number(year), months: store.list(year) })
      return
    }

    const savedMatch = req.method === 'GET' && /^\/api\/reports\/(\d{4}-\d{2})$/.exec(url.pathname)
    if (savedMatch) {
      const saved = store.get(savedMatch[1])
      if (!saved) {
        sendJson(res, 404, { message: 'Нет сохранённой проверки' })
        return
      }
      sendJson(res, 200, saved)
      return
    }

    if (req.method === 'GET') {
      await serveStatic(req, res, decodeURIComponent(url.pathname))
      return
    }

    sendJson(res, 405, { message: 'Метод не поддерживается' })
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    sendJson(res, error.statusCode || 500, { message: error.message || 'Ошибка сервера' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}`)
})
