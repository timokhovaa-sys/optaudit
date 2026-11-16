import assert from 'node:assert/strict'
import test from 'node:test'
import { pendingReservations } from '../src/returns.js'
import { createShipmentReturn, salesReturnBody } from '../src/shipment-return.js'

const productHref = 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1'

function card() {
  return {
    id: 'card-1',
    status: 'new',
    reasonLabel: 'Лишний товар',
    document: { kind: 'demand', id: 'd1', name: '06108' },
    lines: [{ name: 'Изолента Aura ZTC-P120B', code: '32506557', quantity: 1, assortmentHref: productHref }],
  }
}

test('a shipment return is posted to the main store and is not for dispatch', async () => {
  const posts = []
  const client = {
    async get(path) {
      if (path === '/entity/demand/d1') {
        return {
          id: 'd1',
          meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand', mediaType: 'application/json' },
          organization: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/o1', type: 'organization', mediaType: 'application/json' } },
          agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/c1', type: 'counterparty', mediaType: 'application/json' } },
        }
      }
      if (path === '/entity/demand/d1/positions') {
        return {
          rows: [
            {
              quantity: 4,
              price: 7000,
              discount: 0,
              vat: 5,
              vatEnabled: true,
              assortment: { name: 'Изолента Aura ZTC-P120B', code: '32506557', meta: { href: productHref, type: 'product', mediaType: 'application/json' } },
            },
            {
              quantity: 8,
              price: 20100,
              vat: 5,
              assortment: { name: 'Другая', code: '32507040', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p2', type: 'product', mediaType: 'application/json' } },
            },
          ],
          meta: { size: 2 },
        }
      }
      if (path === '/entity/store') {
        return {
          rows: [{ name: 'Основной склад', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/store/s1', type: 'store', mediaType: 'application/json' } }],
        }
      }
      if (path === '/entity/salesreturn/metadata') {
        return {
          states: [{ name: 'Не для отправки', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/salesreturn/metadata/states/st1', type: 'state', mediaType: 'application/json' } }],
        }
      }
      throw new Error(path)
    },
    async post(path, body) {
      posts.push({ path, body })
      return { id: 'sr1', name: '00021', meta: { uuidHref: 'https://online.moysklad.ru/app/#salesreturn/edit?id=sr1' } }
    },
  }
  const saved = await createShipmentReturn(client, card())
  assert.equal(posts.length, 1)
  assert.equal(posts[0].path, '/entity/salesreturn')
  const body = posts[0].body
  assert.equal(body.applicable, true)
  assert.match(body.description, /Возврат через CRM/)
  assert.match(body.description, /Отгрузка 06108/)
  assert.match(body.description, /Лишний товар/)
  assert.match(body.store.meta.href, /\/store\/s1$/)
  assert.match(body.state.meta.href, /\/states\/st1$/)
  assert.match(body.demand.meta.href, /\/demand\/d1$/)
  assert.equal(body.positions.length, 1)
  assert.equal(body.positions[0].quantity, 1)
  assert.equal(body.positions[0].price, 7000)
  assert.equal(body.positions[0].vat, 5)
  assert.equal(body.positions[0].vatEnabled, true)
  assert.equal(saved.status, 'confirmed')
  assert.equal(saved.moysklad.name, '00021')
  assert.equal(saved.moysklad.href, 'https://online.moysklad.ru/app/#salesreturn/edit?id=sr1')
})

test('a confirmed card and a retail sale are not posted again', async () => {
  const client = {
    async get() {
      throw new Error('get')
    },
    async post() {
      throw new Error('post')
    },
  }
  const done = { ...card(), status: 'confirmed', moysklad: { id: 'sr1', name: '00021', href: 'https://example.test/return' } }
  assert.equal(await createShipmentReturn(client, done), done)
  await assert.rejects(() => createShipmentReturn(client, { ...card(), document: { kind: 'retaildemand', id: 'r1' } }), /отгрузке/)
  const reserved = pendingReservations([done], { kind: 'demand', id: 'd1' })
  assert.equal(reserved.sum, 0)
  assert.equal(reserved.qty.size, 0)
})

test('the return keeps only the chosen shipment lines', () => {
  const body = salesReturnBody({
    demand: {
      id: 'd1',
      meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand' },
      organization: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/o1', type: 'organization' } },
      agent: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/c1', type: 'counterparty' } },
    },
    positions: [{
      quantity: 1,
      price: 8300,
      vat: 0,
      assortment: { code: '32509793', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p9', type: 'product' } },
    }],
    card: { reasonLabel: 'Брак', lines: [{ code: '32509793', quantity: 1 }] },
    store: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/store/s1', type: 'store' } },
    state: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/salesreturn/metadata/states/st1', type: 'state' } },
  })
  assert.equal(body.positions[0].price, 8300)
  assert.equal(body.applicable, true)
})
