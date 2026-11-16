import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildReturnCard } from '../src/cards.js'
import { openReturnStore } from '../src/card-store.js'

test('a return card keeps the order, the buyer and the chosen lines', () => {
  const card = buildReturnCard({
    id: 'card-1',
    createdAt: '2026-11-12T20:00:00.000Z',
    reason: 'defect',
    document: {
      id: 'r1',
      kind: 'retaildemand',
      name: '04159',
      moment: '2026-11-12 19:49:00',
      sum: 598500,
      agent: { name: 'Роман', phone: '89500314400', email: 'roman@example.com' },
      customerOrder: {
        name: '05347',
        attributes: [{ name: 'Номер заказа на сайте', value: '1011760' }],
      },
      noCashSum: 598500,
      payment: { status: 'paid', source: 'order', payed: 5985, sum: 5985 },
    },
    lines: [{
      name: 'СЧ динамики',
      code: '32508139',
      quantity: 1,
      price: 5985,
      sum: 5985,
      assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1',
    }],
    requested: [{ assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1', quantity: 1 }],
  })
  assert.equal(card.status, 'new')
  assert.equal(card.reasonLabel, 'Брак')
  assert.equal(card.amount, 5985)
  assert.equal(card.document.agent, 'Роман')
  assert.equal(card.document.phone, '+7 950 031-44-00')
  assert.equal(card.document.email, 'roman@example.com')
  assert.equal(card.document.siteOrder, '1011760')
  assert.equal(card.document.orderName, '05347')
  assert.equal(card.document.label, 'Продажа')
  assert.equal(card.lines[0].quantity, 1)
  assert.equal(card.lines[0].sum, 5985)
  assert.equal(card.compensationNote, '')
})

test('a cashless return keeps the payout note and a cash return does not', () => {
  const document = { id: 'r1', kind: 'demand', name: '06108', agent: { name: 'ИП' } }
  const lines = [{ name: 'Изолента', code: '1', quantity: 1, price: 70, sum: 70 }]
  const requested = [{ code: '1', quantity: 1 }]
  const cashless = buildReturnCard({
    document,
    lines,
    requested,
    reason: 'extra',
    compensation: 'cashless',
    compensationNote: '  перевод на карту  ',
  })
  assert.equal(cashless.compensationNote, 'перевод на карту')
  const cash = buildReturnCard({
    document,
    lines,
    requested,
    reason: 'extra',
    compensation: 'cash',
    compensationNote: 'перевод на карту',
  })
  assert.equal(cash.compensationNote, '')
})

test('return cards stay in the local store and come back newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'returns-'))
  const store = openReturnStore(join(dir, 'returns.sqlite'))
  store.save({ id: 'a', createdAt: '2026-11-12T10:00:00.000Z', amount: 1 })
  store.save({ id: 'b', createdAt: '2026-11-12T11:00:00.000Z', amount: 2 })
  assert.deepEqual(store.list().map((card) => card.id), ['b', 'a'])
  assert.equal(store.remove('a'), true)
  assert.equal(store.remove('a'), false)
  assert.deepEqual(store.list().map((card) => card.id), ['b'])
  assert.equal(store.update({ id: 'b', createdAt: '2026-11-12T11:00:00.000Z', status: 'confirmed' }), true)
  assert.equal(store.get('b').status, 'confirmed')
  assert.equal(store.get('missing'), null)
  store.close()
})
