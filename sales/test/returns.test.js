import assert from 'node:assert/strict'
import test from 'node:test'
import { assessReturn, judgeReturn, pendingReservations, reviewReturn } from '../src/returns.js'

const today = new Date(2026, 10, 12)
const href = 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1'

test('return stays inside 20 days and rejects an order', () => {
  const fresh = assessReturn({
    kind: 'demand',
    moment: '2026-10-23 12:00:00',
    payment: { status: 'paid', source: 'order', payed: 100, sum: 100 },
    lines: [{ quantity: 1, price: 100, sum: 100, assortmentHref: href }],
    returnedQty: new Map(),
    returnedSumMinor: 0,
    today,
  })
  assert.equal(fresh.returnable, true)
  assert.equal(fresh.ageDays, 20)
  assert.equal(fresh.windowDays, 20)

  const old = assessReturn({
    kind: 'demand',
    moment: '2026-10-22 12:00:00',
    payment: { status: 'paid', source: 'order', payed: 100, sum: 100 },
    lines: [],
    returnedQty: new Map(),
    returnedSumMinor: 0,
    today,
  })
  assert.equal(old.returnable, false)
  assert.equal(old.block, 'window')

  const order = assessReturn({
    kind: 'customerorder',
    moment: '2026-11-12 12:00:00',
    payment: { status: 'paid', source: 'order', payed: 100, sum: 100 },
    lines: [{ quantity: 1, price: 100, sum: 100 }],
    returnedQty: new Map(),
    returnedSumMinor: 0,
    today,
  })
  assert.equal(order.returnable, false)
  assert.equal(order.block, 'order')
})

test('already returned quantity and the paid remainder limit the next return', async () => {
  const document = {
    id: 'd1',
    kind: 'demand',
    moment: '2026-11-12 10:00:00',
    payment: { status: 'paid', source: 'document', payed: 512, sum: 512 },
  }
  const lines = [{
    name: 'Кабель',
    code: '1',
    quantity: 8,
    price: 64,
    sum: 512,
    assortmentHref: href,
  }]
  const client = {
    async get(path, params) {
      if (params?.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/salesreturn') {
        return {
          rows: [{
            id: 'back1',
            sum: 6400,
            positions: {
              meta: { size: 1 },
              rows: [{ quantity: 1, assortment: { code: '1', meta: { href } } }],
            },
          }],
          meta: { size: 1 },
        }
      }
      throw new Error(path)
    },
  }
  const denied = await reviewReturn({
    client,
    document,
    lines,
    requested: [{ assortmentHref: href, quantity: 8 }],
    reason: 'defect',
    today,
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.lines[0].available, 7)
  assert.match(denied.message, /остатка/)

  const tooMuchMoney = await reviewReturn({
    client,
    document: { ...document, payment: { status: 'paid', source: 'document', payed: 100, sum: 512 } },
    lines,
    requested: [{ assortmentHref: href, quantity: 2 }],
    reason: 'defect',
    today,
  })
  assert.equal(tooMuchMoney.ok, false)
  assert.match(tooMuchMoney.message, /остатка оплаты/)

  const allowed = await reviewReturn({
    client,
    document,
    lines,
    requested: [{ assortmentHref: href, quantity: 1 }],
    reason: 'defect',
    today,
  })
  assert.equal(allowed.ok, true)
  assert.equal(judgeReturn({
    state: assessReturn({
      kind: 'demand',
      moment: document.moment,
      payment: document.payment,
      lines,
      returnedQty: new Map(),
      returnedSumMinor: 0,
      today,
    }),
    lines,
    requested: [{ assortmentHref: href, quantity: 1 }],
    reason: '',
  }).ok, false)
})

test('a saved return card blocks the same position', async () => {
  const document = {
    id: 'r1',
    kind: 'retaildemand',
    moment: '2026-11-12 15:13:00',
    payment: { status: 'paid', source: 'order', payed: 7311, sum: 7311 },
  }
  const lines = [
    { name: 'Коаксиальная акустика Oris FT-652', code: '32506862', quantity: 1, price: 3021, sum: 3021, assortmentHref: href },
    { name: 'Oris FT-165', code: '32506577', quantity: 1, price: 4290, sum: 4290, assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p2' },
  ]
  const cards = [{
    status: 'new',
    amount: 3021,
    reason: 'fit',
    document: { kind: 'retaildemand', id: 'r1' },
    lines: [{ code: '32506862', quantity: 1, sum: 3021 }],
  }]
  const client = {
    async get(path) {
      if (path === '/entity/retailsalesreturn' || path === '/entity/salesreturn') return { rows: [], meta: { size: 0 } }
      throw new Error(path)
    },
  }
  const duplicate = await reviewReturn({
    client,
    document,
    lines,
    requested: [{ code: '32506862', quantity: 1 }],
    reason: 'extra',
    today,
    pending: pendingReservations(cards, document),
  })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.message, /карточке возврата/)
  assert.equal(duplicate.lines[0].available, 0)

  const other = await reviewReturn({
    client,
    document,
    lines,
    requested: [{ code: '32506577', quantity: 1 }],
    reason: 'extra',
    today,
    pending: pendingReservations(cards, document),
  })
  assert.equal(other.ok, true)
  assert.equal(other.lines[1].available, 1)
})
