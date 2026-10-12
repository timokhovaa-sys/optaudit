import assert from 'node:assert/strict'
import test from 'node:test'
import { createRateLimiter, isParallelLimit, retryDelay } from '../src/rate-limit.js'

test('requests are spaced across the rate-limit window', async () => {
  const limiter = createRateLimiter({ limit: 4, interval: 200, maxParallel: 4 })
  const starts = []
  await Promise.all(Array.from({ length: 4 }, async () => {
    await limiter.acquire()
    starts.push(Date.now())
    limiter.release()
  }))
  starts.sort((a, b) => a - b)
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 40, `gap ${starts[index] - starts[index - 1]}`)
  }
})

test('a penalty holds the next request until the reset time', async () => {
  const limiter = createRateLimiter({ limit: 10, interval: 100, maxParallel: 2 })
  limiter.penalize(150)
  const started = Date.now()
  await limiter.acquire()
  limiter.release()
  assert.ok(Date.now() - started >= 130)
})

test('only one request runs when the parallel cap is 1', async () => {
  const limiter = createRateLimiter({ limit: 100, interval: 100, maxParallel: 1 })
  await limiter.acquire()
  let second = false
  const pending = limiter.acquire().then(() => {
    second = true
    limiter.release()
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(second, false)
  limiter.release()
  await pending
  assert.equal(second, true)
})

test('response headers replace the request budget', () => {
  const limiter = createRateLimiter()
  limiter.note(new Headers({
    'X-RateLimit-Limit': '45',
    'X-Lognex-Retry-TimeInterval': '3000',
    'X-RateLimit-Remaining': '20',
    'X-Lognex-Reset': '1000',
  }))
  assert.deepEqual(limiter.snapshot(), {
    limit: 45,
    interval: 3000,
    maxParallel: 2,
    inFlight: 0,
    remaining: 20,
  })
})

test('headers do not schedule requests faster than the minimum gap', async () => {
  const limiter = createRateLimiter()
  limiter.note(new Headers({
    'X-RateLimit-Limit': '45',
    'X-Lognex-Retry-TimeInterval': '3000',
    'X-RateLimit-Remaining': '40',
    'X-Lognex-Reset': '3000',
  }))
  const starts = []
  await Promise.all([0, 1].map(async () => {
    await limiter.acquire()
    starts.push(Date.now())
    limiter.release()
  }))
  starts.sort((a, b) => a - b)
  assert.ok(starts[1] - starts[0] >= 450, `gap ${starts[1] - starts[0]}`)
})

test('parallel overload is recognized and lowers the cap', () => {
  const limiter = createRateLimiter({ maxParallel: 4 })
  const response = {
    headers: new Headers({ 'X-Lognex-Auth': '429005' }),
  }
  assert.equal(isParallelLimit(response, null), true)
  assert.equal(isParallelLimit({ headers: new Headers() }, { errors: [{ code: 1073 }] }), true)
  limiter.penalize(0, { parallel: true })
  assert.equal(limiter.snapshot().maxParallel, 3)
  assert.equal(retryDelay(new Headers({ 'X-Lognex-Retry-After': '2500' })), 2500)
})
