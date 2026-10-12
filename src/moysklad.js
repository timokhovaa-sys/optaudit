import { createRateLimiter, isParallelLimit, retryDelay } from './rate-limit.js'

export const API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'

export class MoySkladError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'MoySkladError'
    this.status = status
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Остановлено')
    error.name = 'AbortError'
    throw error
  }
}

export function authHeader(token) {
  const trimmed = String(token ?? '').trim()
  if (!trimmed) throw new MoySkladError('Не указан токен МоегоСклада', 401)
  if (trimmed.includes(':')) {
    return `Basic ${Buffer.from(trimmed, 'utf8').toString('base64')}`
  }
  return `Bearer ${trimmed}`
}

async function errorMessage(response) {
  if (response.status === 401) {
    return 'Неверный токен или логин. В МоёмСкладе токен создаётся в Настройки → Токены. Можно также ввести логин:пароль.'
  }
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const text = body?.errors
    ?.map((error) => error.error_message || error.error)
    .filter(Boolean)
    .join('; ')
  if (response.status === 403) return text || 'Недостаточно прав для этого запроса.'
  if (response.status === 415) return 'МойСклад отклонил кодировку ответа.'
  return text || `Ошибка МоегоСклада (${response.status})`
}

function buildUrl(path, params) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
  return `${API_ROOT}${path}${query ? `?${query}` : ''}`
}

export function createClient(token) {
  const authorization = authHeader(token)
  const limiter = createRateLimiter()

  async function send(path, params, signal) {
    const url = buildUrl(path, params)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal)
      await limiter.acquire(signal)
      let response
      try {
        response = await fetch(url, {
          headers: {
            Authorization: authorization,
            Accept: 'application/json;charset=utf-8',
          },
          signal,
        })
        limiter.note(response.headers)
        if (response.status === 429 || response.status === 503) {
          const body = await readJson(response)
          limiter.penalize(Math.max(retryDelay(response.headers), 3000), { parallel: isParallelLimit(response, body) })
          continue
        }
      } finally {
        limiter.release()
      }
      if (!response.ok) {
        throw new MoySkladError(await errorMessage(response), response.status)
      }
      return response.json()
    }
    throw new MoySkladError('МойСклад временно ограничивает запросы. Повторите через минуту.', 429)
  }

  return {
    async get(path, params = {}, signal) {
      return send(path, params, signal)
    },
  }
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function fetchAll(client, path, params, { pageLimit = 100, signal, onPage } = {}) {
  const rows = []
  let offset = 0
  for (let page = 0; page < 500; page += 1) {
    const data = await client.get(path, { ...params, limit: pageLimit, offset }, signal)
    const chunk = Array.isArray(data.rows) ? data.rows : []
    rows.push(...chunk)
    const total = Number(data.meta?.size ?? rows.length)
    onPage?.({ loaded: rows.length, total })
    if (chunk.length === 0 || rows.length >= total) return rows
    offset += chunk.length
  }
  throw new MoySkladError('Слишком большая выборка, запрос остановлен.', 413)
}
