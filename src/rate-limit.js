const DEFAULT_LIMIT = 45
const DEFAULT_INTERVAL_MS = 3000
const DEFAULT_PARALLEL = 2
const MIN_GAP_MS = 500

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}

function abortError() {
  const error = new Error('Остановлено')
  error.name = 'AbortError'
  return error
}

function headerNumber(headers, name) {
  const value = Number(headers?.get?.(name) ?? headers?.[name])
  return Number.isFinite(value) ? value : null
}

export function createRateLimiter({
  limit = DEFAULT_LIMIT,
  interval = DEFAULT_INTERVAL_MS,
  maxParallel = DEFAULT_PARALLEL,
} = {}) {
  let requestLimit = limit
  let intervalMs = interval
  let parallel = maxParallel
  let inFlight = 0
  let nextAt = 0
  let pauseUntil = 0
  let remaining = null
  let resetAt = 0
  const waiters = []
  let chain = Promise.resolve()

  function gap() {
    const base = intervalMs / Math.max(requestLimit, 1)
    const now = Date.now()
    const paced = remaining != null && remaining > 0 && resetAt > now
      ? Math.max(base, (resetAt - now) / remaining)
      : base
    return Math.max(MIN_GAP_MS, paced)
  }

  function readyAt() {
    let at = Math.max(pauseUntil, nextAt)
    if (remaining === 0 && resetAt > Date.now()) at = Math.max(at, resetAt)
    return at
  }

  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.then(() => {}, () => {})
    return run
  }

  function wake() {
    const next = waiters.shift()
    if (next) next()
  }

  async function acquire(signal) {
    return enqueue(async () => {
      if (signal?.aborted) throw abortError()
      while (inFlight >= parallel || Date.now() < readyAt()) {
        if (signal?.aborted) throw abortError()
        if (inFlight >= parallel) {
          await waitForSlot(signal)
          continue
        }
        await sleep(Math.max(0, readyAt() - Date.now()), signal)
      }
      inFlight += 1
      nextAt = Date.now() + gap()
      if (remaining != null) remaining = Math.max(0, remaining - 1)
    })
  }

  function waitForSlot(signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        const index = waiters.indexOf(finishOk)
        if (index >= 0) waiters.splice(index, 1)
        if (error) reject(error)
        else resolve()
      }
      const finishOk = () => finish()
      const onAbort = () => finish(abortError())
      waiters.push(finishOk)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (inFlight < parallel && Date.now() >= readyAt()) finishOk()
    })
  }

  function release() {
    inFlight = Math.max(0, inFlight - 1)
    wake()
  }

  function note(headers) {
    const nextLimit = headerNumber(headers, 'x-ratelimit-limit')
    const nextInterval = headerNumber(headers, 'x-lognex-retry-timeinterval')
    const left = headerNumber(headers, 'x-ratelimit-remaining')
    const reset = headerNumber(headers, 'x-lognex-reset')
    if (nextLimit != null && nextLimit > 0) requestLimit = nextLimit
    if (nextInterval != null && nextInterval > 0) intervalMs = nextInterval
    if (left != null) remaining = left
    if (reset != null && reset > 0) resetAt = Date.now() + reset
    if (left === 0 && reset != null && reset > 0) {
      pauseUntil = Math.max(pauseUntil, Date.now() + reset)
    }
  }

  function penalize(ms, { parallel: tooManyParallel = false } = {}) {
    const wait = Number.isFinite(ms) && ms > 0 ? ms : intervalMs
    pauseUntil = Math.max(pauseUntil, Date.now() + wait)
    remaining = 0
    resetAt = pauseUntil
    if (tooManyParallel) parallel = Math.max(1, parallel - 1)
  }

  function snapshot() {
    return {
      limit: requestLimit,
      interval: intervalMs,
      maxParallel: parallel,
      inFlight,
      remaining,
    }
  }

  return { acquire, release, note, penalize, snapshot }
}

export function retryDelay(headers, fallback = 1000) {
  const retry = headerNumber(headers, 'x-lognex-retry-after')
    ?? headerNumber(headers, 'x-lognex-reset')
    ?? fallback
  if (retry <= 0) return fallback
  return Math.min(retry, 120000)
}

export function isParallelLimit(response, body) {
  const auth = String(response?.headers?.get?.('x-lognex-auth') || '')
  if (auth.includes('1073') || auth.includes('429005')) return true
  return (body?.errors || []).some((error) => Number(error.code) === 1073)
}
