import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../src/store.js'

test('the last report for a month replaces the previous one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-store-'))
  const store = openStore(join(dir, 'reports.sqlite'))
  try {
    store.save({ month: '2026-09', group: 'оптовики', stats: { orders: 1 } }, '2026-09-30T12:00:00.000Z')
    store.save({ month: '2026-10', group: 'оптовики', stats: { orders: 2 } }, '2026-10-01T12:00:00.000Z')
    store.save({ month: '2026-10', group: 'оптовики', stats: { orders: 4 } }, '2026-10-09T13:00:00.000Z')

    assert.equal(store.get('2026-09').report.stats.orders, 1)
    assert.equal(store.get('2026-10').savedAt, '2026-10-09T13:00:00.000Z')
    assert.equal(store.get('2026-10').report.stats.orders, 4)
    assert.equal(store.get('2026-11'), null)
    assert.equal(store.get('../secret'), null)

    store.save({
      month: '2025-03',
      stats: { sales: 10, profit: 2, averageMarkup: 18.5, missed: 1 },
    }, '2025-03-31T12:00:00.000Z')
    const year = store.list('2026')
    assert.deepEqual(year.map((row) => row.month), ['2026-09', '2026-10'])
    assert.equal(year[0].sales, null)
    const past = store.list('2025')
    assert.equal(past.length, 1)
    assert.equal(past[0].sales, 10)
    assert.equal(past[0].profit, 2)
    assert.equal(past[0].averageMarkup, 18.5)
    assert.equal(past[0].missed, 1)
    assert.deepEqual(store.list('nope'), [])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
