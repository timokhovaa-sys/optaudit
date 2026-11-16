import assert from 'node:assert/strict'
import test from 'node:test'
import { cashPayoutBody, payoutComment, RETAIL_STORE_ID } from '../src/cash-payout.js'
import { confirmMessage, settleReturn } from '../src/confirm-return.js'

const store = {
  meta: {
    href: `https://api.moysklad.ru/api/remap/1.2/entity/retailstore/${RETAIL_STORE_ID}`,
    type: 'retailstore',
    mediaType: 'application/json',
  },
  organization: {
    meta: {
      href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/o1',
      type: 'organization',
      mediaType: 'application/json',
    },
  },
}

const shift = {
  meta: {
    href: 'https://api.moysklad.ru/api/remap/1.2/entity/retailshift/sh1',
    type: 'retailshift',
    mediaType: 'application/json',
  },
  retailStore: store,
  owner: {
    meta: {
      href: 'https://api.moysklad.ru/api/remap/1.2/entity/employee/e1',
      type: 'employee',
      mediaType: 'application/json',
    },
  },
}

test('the cash payout comment names the order, the return and CRM', () => {
  assert.equal(payoutComment({
    document: {
      kind: 'retaildemand',
      name: '04189',
      href: 'https://online.moysklad.ru/app/#retaildemand/edit?id=r1',
      orderName: '05386',
      orderHref: 'https://online.moysklad.ru/app/#customerorder/edit?id=o1',
    },
    moysklad: {
      name: '00021',
      href: 'https://online.moysklad.ru/app/#retailsalesreturn/edit?id=sr1',
    },
  }), [
    'Возврат через CRM.',
    'Заказ 05386',
    'https://online.moysklad.ru/app/#customerorder/edit?id=o1',
    'Продажа 04189',
    'https://online.moysklad.ru/app/#retaildemand/edit?id=r1',
    'Возврат 00021',
    'https://online.moysklad.ru/app/#retailsalesreturn/edit?id=sr1',
  ].join('\n'))
})

test('a cashless note is added to the CRM comment', () => {
  assert.match(payoutComment({
    compensationNote: 'перевод на карту',
    reasonLabel: 'Не подошло',
    document: { name: '04189', label: 'Продажа' },
  }), /Не подошло\nперевод на карту$/)
})

test('a cash payout is posted from the retail store shift', () => {
  const body = cashPayoutBody({
    card: { amount: 472, document: { orderName: '05386', name: '04189' } },
    store,
    shift,
    moment: '2026-11-15 21:25:00',
  })
  assert.equal(body.applicable, true)
  assert.equal(body.sum, 47200)
  assert.equal(body.description, [
    'Возврат через CRM.',
    'Заказ 05386',
    'Отгрузка 04189',
  ].join('\n'))
  assert.match(body.retailShift.meta.href, /\/retailshift\/sh1$/)
  assert.match(body.organization.meta.href, /\/organization\/o1$/)
  assert.match(body.agent.meta.href, /\/employee\/e1$/)
  assert.equal(body.agent.meta.type, 'employee')
})

test('cash from a retail sale posts only the return', async () => {
  const posts = []
  const client = payoutClient(posts)
  const saved = []
  const card = await settleReturn(client, retailCard(), { save: async (next) => saved.push(next) })
  assert.deepEqual(posts.map((item) => item.path), ['/entity/retailsalesreturn'])
  assert.equal(posts[0].body.applicable, true)
  assert.equal(posts[0].body.cashSum, 47200)
  assert.equal(posts[0].body.noCashSum, 0)
  assert.equal(posts[0].body.qrSum, 0)
  assert.match(posts[0].body.demand.meta.href, /\/retaildemand\/r1$/)
  assert.match(posts[0].body.store.meta.href, /\/store\/s1$/)
  assert.equal(posts[0].body.positions.length, 1)
  assert.match(posts[0].body.description, /Возврат через CRM/)
  assert.match(posts[0].body.description, /Продажа 04189/)
  assert.equal(card.moysklad.name, '00021')
  assert.equal(card.payout, undefined)
  assert.equal(saved.length, 1)
  assert.match(confirmMessage(card), /Возврат 00021/)
})

test('cash from a shipment posts the return first and does not pay twice', async () => {
  const posts = []
  const client = payoutClient(posts, {
    async get(path) {
      if (path === '/entity/demand/d1') {
        return {
          id: 'd1',
          meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand', mediaType: 'application/json' },
          organization: store.organization,
          agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/c1', type: 'counterparty', mediaType: 'application/json' } },
        }
      }
      if (path === '/entity/demand/d1/positions') {
        return {
          rows: [{
            quantity: 1,
            price: 47200,
            vat: 5,
            vatEnabled: true,
            assortment: { name: 'Смола', code: '1', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1', type: 'product', mediaType: 'application/json' } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/store') {
        return { rows: [{ name: 'Основной склад', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/store/s1', type: 'store', mediaType: 'application/json' } }] }
      }
      if (path === '/entity/salesreturn/metadata') {
        return { states: [{ name: 'Не для отправки', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/salesreturn/metadata/states/st1', type: 'state', mediaType: 'application/json' } }] }
      }
      return payoutReads(path)
    },
  })
  const card = {
    compensation: 'cash',
    amount: 472,
    reasonLabel: 'Не подошло',
    document: { kind: 'demand', id: 'd1', name: '06108', orderName: '05386' },
    lines: [{ name: 'Смола', code: '1', quantity: 1, assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1' }],
  }
  const saved = await settleReturn(client, card)
  assert.deepEqual(posts.map((item) => item.path), ['/entity/salesreturn', '/entity/retaildrawercashout'])
  assert.match(posts[1].body.description, /Возврат через CRM/)
  assert.match(posts[1].body.description, /Заказ 05386/)
  assert.match(posts[1].body.description, /Отгрузка 06108/)
  assert.match(posts[1].body.description, /Возврат 00021/)
  const again = []
  await settleReturn(payoutClient(again), saved)
  assert.equal(again.length, 0)
})

test('cashless posts only the customer return and never the drawer', async () => {
  for (const kind of ['demand', 'retaildemand']) {
    const posts = []
    const card = await settleReturn(payoutClient(posts), cashlessCard(kind))
    assert.deepEqual(posts.map((item) => item.path), ['/entity/salesreturn'])
    assert.equal(posts[0].body.applicable, true)
    assert.equal(posts[0].body.cashSum, undefined)
    assert.equal(posts[0].body.noCashSum, undefined)
    assert.equal(posts[0].body.qrSum, undefined)
    assert.equal(posts[0].body.retailStore, undefined)
    assert.equal(posts[0].body.retailShift, undefined)
    assert.equal(card.payout, undefined)
    assert.match(card.moysklad.href, /#salesreturn\/edit/)
    if (kind === 'demand') assert.match(posts[0].body.demand.meta.href, /\/demand\/d1$/)
    else assert.equal(posts[0].body.demand, undefined)
    const again = []
    await settleReturn(payoutClient(again), card)
    assert.equal(again.length, 0)
  }
})

function cashlessCard(kind) {
  const retail = kind === 'retaildemand'
  return {
    compensation: 'cashless',
    compensationNote: 'перевод на карту',
    amount: 472,
    reasonLabel: 'Не подошло',
    document: {
      kind,
      id: retail ? 'r1' : 'd1',
      name: retail ? '04189' : '06108',
      label: retail ? 'Продажа' : 'Отгрузка',
      orderName: '05386',
    },
    lines: [{ name: 'Смола', code: '1', quantity: 1, assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1' }],
  }
}

function retailCard() {
  return {
    compensation: 'cash',
    amount: 472,
    reasonLabel: 'Не подошло',
    document: { kind: 'retaildemand', id: 'r1', name: '04189', orderName: '05386' },
    lines: [{ name: 'Смола', code: '1', quantity: 1, assortmentHref: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1' }],
  }
}

function payoutReads(path) {
  if (path === `/entity/retailstore/${RETAIL_STORE_ID}`) return store
  if (path === '/entity/retailshift') return { rows: [shift] }
  if (path === '/entity/retaildrawercashout') return { rows: [] }
  if (path === '/entity/demand/d1') {
    return {
      id: 'd1',
      meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand', mediaType: 'application/json' },
      organization: store.organization,
      agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/c1', type: 'counterparty', mediaType: 'application/json' } },
    }
  }
  if (path === '/entity/demand/d1/positions' || path === '/entity/retaildemand/r1/positions') {
    return {
      rows: [{
        quantity: 1,
        price: 47200,
        vat: 5,
        vatEnabled: true,
        assortment: { name: 'Смола', code: '1', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1', type: 'product', mediaType: 'application/json' } },
      }],
      meta: { size: 1 },
    }
  }
  if (path === '/entity/salesreturn/metadata') {
    return { states: [{ name: 'Не для отправки', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/salesreturn/metadata/states/st1', type: 'state', mediaType: 'application/json' } }] }
  }
  if (path === '/entity/retaildemand/r1') {
    return {
      id: 'r1',
      meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/retaildemand/r1', type: 'retaildemand', mediaType: 'application/json' },
      organization: store.organization,
      agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/c1', type: 'counterparty', mediaType: 'application/json' } },
      retailStore: store,
      retailShift: shift,
    }
  }
  if (path === '/entity/store') {
    return { rows: [{ name: 'Основной склад', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/store/s1', type: 'store', mediaType: 'application/json' } }] }
  }
  if (path === '/entity/retailsalesreturn/metadata') {
    return { states: [{ name: 'Не для отправки', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/retailsalesreturn/metadata/states/st1', type: 'state', mediaType: 'application/json' } }] }
  }
  throw new Error(path)
}

function payoutClient(posts, extra = {}) {
  return {
    async get(path) {
      if (extra.get) return extra.get(path)
      return payoutReads(path)
    },
    async post(path, body) {
      posts.push({ path, body })
      if (path === '/entity/retaildrawercashout') {
        return { id: 'pay1', name: '00044', meta: { uuidHref: 'https://online.moysklad.ru/app/#retaildrawercashout/edit?id=pay1' } }
      }
      return { id: 'sr1', name: '00021', meta: { uuidHref: 'https://online.moysklad.ru/app/#salesreturn/edit?id=sr1' } }
    },
  }
}
