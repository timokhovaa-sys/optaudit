import assert from 'node:assert/strict'
import test from 'node:test'
import { attachPriceCuts, matchPriceCut, priceCuts } from '../src/price-cut.js'

const names = new Map([['shelest@company', 'Шелест В.']])

const screenRow = (price) => `НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом); 1,00; пара; 1,00; ${price}; 5; 0,00`

test('a manual price cut from the audit history is kept', () => {
  const cuts = priceCuts([
    {
      eventType: 'update',
      source: 'posapi',
      uid: 'shelest@company',
      moment: '2026-10-03 16:16:00',
      diff: {
        positions: {
          oldValue: screenRow('27 730,00'),
          newValue: screenRow('12 230,00'),
        },
        sum: { oldValue: 43992, newValue: 28492 },
      },
    },
    {
      eventType: 'update',
      source: 'scriptor',
      uid: 'shelest@company',
      moment: '2026-10-03 18:00:00',
      diff: { positions: { oldValue: screenRow('12 230,00'), newValue: screenRow('1 000,00') } },
    },
    {
      eventType: 'update',
      source: 'app',
      supportAccess: true,
      uid: 'shelest@company',
      moment: '2026-10-03 19:00:00',
      diff: { positions: { oldValue: screenRow('12 230,00'), newValue: screenRow('500,00') } },
    },
    {
      eventType: 'update',
      source: 'jsonapi',
      uid: 'smirnov@company',
      moment: '2026-10-03 15:04:00',
      diff: { positions: { oldValue: screenRow('27 730,00'), newValue: screenRow('1,00') } },
    },
  ], names)

  assert.equal(cuts.length, 1)
  assert.equal(cuts[0].by, 'Шелест В.')
  assert.equal(cuts[0].oldPriceMinor, 2773000)
  assert.equal(cuts[0].newPriceMinor, 1223000)

  const pos = priceCuts([{
    eventType: 'update',
    source: 'posap-1.0',
    uid: 'shelest@company',
    moment: '2026-10-03 16:16:00',
    diff: { positions: { oldValue: screenRow('27 730,00'), newValue: screenRow('12 230,00') } },
  }], names)
  assert.equal(pos.length, 1)
  assert.equal(pos[0].by, 'Шелест В.')
})

test('structured position prices are kopecks and a higher price is not a cut', () => {
  const product = {
    meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/abc' },
    name: 'Динамик',
  }
  const cuts = priceCuts([
    {
      eventType: 'update',
      source: 'app',
      uid: 'shelest@company',
      moment: '2026-10-01 10:00:00',
      diff: {
        positions: {
          oldValue: [{ assortment: product, price: 1000000, discount: 0 }],
          newValue: [{ assortment: product, price: 1200000, discount: 0 }],
        },
      },
    },
    {
      eventType: 'update',
      source: 'app',
      uid: 'shelest@company',
      moment: '2026-10-02 10:00:00',
      diff: {
        positions: {
          oldValue: [{ assortment: product, price: 1200000, discount: 0 }],
          newValue: [{ assortment: product, price: 1200000, discount: 15 }],
        },
      },
    },
  ], names)

  assert.equal(cuts.length, 1)
  assert.equal(cuts[0].assortmentId, 'abc')
  assert.equal(cuts[0].oldDiscount, 0)
  assert.equal(cuts[0].newDiscount, 15)
})

test('audit positions are pairs and the price is in rubles', () => {
  const product = {
    meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/abc' },
    name: 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)',
  }
  const cuts = priceCuts([{
    eventType: 'update',
    source: 'posapi',
    entityType: 'customerorder',
    uid: 'shelest@company',
    moment: '2026-10-03 16:16:00',
    diff: {
      sum: { oldValue: 43992, newValue: 28492 },
      positions: [{
        oldValue: { assortment: product, quantity: 1, uom: 'шт', reserve: 0, price: 27730, vat: 5, discount: 0 },
        newValue: { assortment: product, quantity: 1, uom: 'шт', reserve: 0, price: 12230, vat: 5, discount: 0 },
      }, {
        newValue: { assortment: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/added' }, name: 'Новый' }, price: 1000, discount: 0 },
      }],
    },
  }], names)

  assert.equal(cuts.length, 1)
  assert.equal(cuts[0].oldPriceMinor, 2773000)
  assert.equal(cuts[0].newPriceMinor, 1223000)
  assert.equal(cuts[0].assortmentId, 'abc')
})

test('a position event carries the price on its own diff', () => {
  const cuts = priceCuts([{
    eventType: 'update',
    source: 'posapi',
    entityType: 'customerorderposition',
    name: 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)',
    uid: 'shelest@company',
    moment: '2026-10-03 16:16:00',
    diff: { price: { oldValue: 2773000, newValue: 1223000 } },
  }, {
    eventType: 'update',
    source: 'posapi',
    entityType: 'customerorder',
    name: '04688',
    uid: 'shelest@company',
    moment: '2026-10-03 16:16:00',
    diff: { state: { oldValue: 'new', newValue: 'posted' } },
  }, {
    eventType: 'update',
    source: 'app',
    uid: 'shelest@company',
    moment: '2026-10-03 16:20:00',
    diff: {
      positions: {
        updated: [{
          name: 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)',
          price: { oldValue: 1223000, newValue: 1000000 },
        }],
      },
    },
  }], names)

  assert.equal(cuts.length, 2)
  assert.equal(cuts[0].name, 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)')
  assert.equal(cuts[0].oldPriceMinor, 2773000)
  assert.equal(cuts[0].newPriceMinor, 1223000)
  assert.equal(cuts[1].newPriceMinor, 1000000)
})

test('the badge is attached only to a low line of the same product', () => {
  const shipment = {
    positions: [
      { name: 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)', low: true, assortmentIds: ['abc'] },
      { name: 'Автомат 16А', low: true, assortmentIds: ['other'] },
      { name: 'НЧ/СЧ динамики Helix Ci5 S200FM-S2 (2 Ом)', low: false, assortmentIds: ['abc'] },
    ],
  }
  attachPriceCuts(shipment, priceCuts([{
    eventType: 'update',
    source: 'app',
    uid: 'shelest@company',
    moment: '2026-10-03 16:16:00',
    diff: {
      positions: {
        oldValue: screenRow('27 730,00'),
        newValue: screenRow('12 230,00'),
      },
    },
  }], names))

  assert.equal(shipment.priceCut, true)
  assert.equal(shipment.positions[0].priceCut.by, 'Шелест В.')
  assert.equal(shipment.positions[0].priceCut.oldPrice, 27730)
  assert.equal(shipment.positions[0].priceCut.newPrice, 12230)
  assert.equal(shipment.positions[1].priceCut, undefined)
  assert.equal(shipment.positions[2].priceCut, undefined)
  assert.equal(shipment.positions[0].assortmentIds, undefined)
  assert.equal(matchPriceCut({ name: 'Другой', low: true, assortmentIds: [] }, []), null)
})
