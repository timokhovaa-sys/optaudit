import assert from 'node:assert/strict'
import test from 'node:test'
import { buyerDetails, foldName, monthBounds, normalizeQuery, paymentStatus, productMatches, rankProductSuggestions, saleFilter, searchSales, suggestProducts } from '../src/search.js'

test('buyer line keeps a phone, mail, site order and payment only when they are filled', () => {
  const filled = buyerDetails({
    name: '04159',
    agent: { name: 'Роман', phone: '89001234567', email: 'roman@example.com' },
    noCashSum: 598500,
    customerOrder: {
      name: '05347',
      externalCode: 'f052f844-deb8-11f1-0a80-040a0064620f',
      attributes: [
        { name: 'Номер заказа на сайте', value: 'A-100' },
        { name: 'Способ оплаты', value: { name: 'Картой онлайн' } },
      ],
    },
  })
  assert.equal(filled.phone, '+7 900 123-45-67')
  assert.equal(filled.email, 'roman@example.com')
  assert.equal(filled.siteOrder, 'A-100')
  assert.equal(filled.payment, 'Картой онлайн')

  const empty = buyerDetails({
    name: '04159',
    agent: { name: 'Роман' },
    externalCode: 'f052f844-deb8-11f1-0a80-040a0064620f',
  })
  assert.equal(empty.phone, '')
  assert.equal(empty.email, '')
  assert.equal(empty.siteOrder, '')
  assert.equal(empty.payment, '')
  assert.equal(buyerDetails({ cashSum: 1000, qrSum: 500 }).payment, 'Наличные и QR')
})

test('sales month bounds cover February in a leap year', () => {
  assert.deepEqual(monthBounds('2024-02'), {
    from: '2024-02-01 00:00:00',
    to: '2024-02-29 23:59:59',
  })
})

test('sales query keeps a month and rejects a one-letter product', () => {
  assert.deepEqual(normalizeQuery({ month: '2026-10', product: '  Ёлка  ', number: ' 12 ', postedOnly: false }), {
    month: '2026-10',
    product: 'елка',
    number: '12',
    postedOnly: true,
  })
  assert.throws(() => normalizeQuery({ month: '' }), /ГГГГ-ММ/)
  assert.throws(() => normalizeQuery({ month: '2026-10', product: 'а' }), /две буквы/)
  assert.throws(() => normalizeQuery({ month: '2026-10', product: '  ', number: '  ' }), /товар или номер/)
})

test('sales filter escapes the document number', () => {
  const filter = saleFilter({
    from: '2026-10-01 00:00:00',
    to: '2026-10-31 23:59:59',
    postedOnly: true,
    number: 'a=b;c',
  })
  assert.equal(filter, 'moment>=2026-10-01 00:00:00;moment<=2026-10-31 23:59:59;applicable=true;name~a\\=b\\;c')
})

test('product match uses the nested card and ignores case', () => {
  const assortment = { name: 'Серия', assortment: { name: 'Кабель Ёлка', article: 'BL-1', code: '100' } }
  assert.equal(productMatches(assortment, 'елка'), true)
  assert.equal(productMatches(assortment, 'bl-1'), true)
  assert.equal(productMatches(assortment, 'нет'), false)
  assert.equal(productMatches({ name: 'Коаксиальная акустика Oris FT-652' }, '652 oris'), true)
  assert.equal(productMatches({ name: '2x-компонентная акустика Oris FT-165 Fighter' }, '652 oris'), false)
})

test('product search uses the card history and the line price', async () => {
  const calls = []
  const productHref = 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1'
  const demandHref = 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1'
  const client = {
    async get(path, params) {
      calls.push({ path, params })
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/assortment') {
        if (String(params.filter).includes('archived=true')) return { rows: [], meta: { size: 0 } }
        return {
          rows: [{
            name: 'Кабель',
            article: 'K-1',
            meta: { href: productHref, type: 'product' },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/report/turnover/byoperations') {
        return {
          rows: [
            {
              assortment: { name: 'Кабель', meta: { href: productHref, type: 'product' } },
              store: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/store/s1' } },
              operation: {
                meta: {
                  href: demandHref,
                  type: 'demand',
                  uuidHref: 'https://online.moysklad.ru/app/#demand/edit?id=d1',
                },
                name: '0007',
                moment: '2026-10-02 10:00:00.000',
                agent: { name: 'Иванов' },
              },
              quantity: -2,
              sum: 842000,
              cost: 842000,
            },
            {
              operation: {
                meta: {
                  href: 'https://api.moysklad.ru/api/remap/1.2/entity/supply/sup1',
                  type: 'supply',
                },
                name: '01509',
                moment: '2026-10-03 10:00:00.000',
                agent: { name: 'Поставщик' },
              },
              quantity: 4,
              sum: 3368000,
            },
          ],
          meta: { size: 2 },
        }
      }
      if (path === '/entity/customerorder') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/demand/d1') {
        return {
          sum: 21800,
          customerOrder: {
            id: 'o9',
            payedSum: 21800,
            sum: 21800,
            meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/o9', type: 'customerorder' },
          },
        }
      }
      if (path === '/entity/demand/d1/positions') {
        return {
          rows: [
            {
              quantity: 2,
              price: 10000,
              discount: 0,
              assortment: { name: 'Кабель', article: 'K-1', meta: { href: productHref } },
            },
            { quantity: 1, price: 1800, discount: 0, assortment: { name: 'Наклейка' } },
          ],
          meta: { size: 2 },
        }
      }
      throw new Error(path)
    },
  }
  const result = await searchSales({
    client,
    month: '2026-10',
    product: 'кабель',
    number: '0007',
  })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Отгрузка')
  assert.equal(result.sales[0].name, '0007')
  assert.equal(result.sales[0].agent, 'Иванов')
  assert.equal(result.sales[0].quantity, 2)
  assert.equal(result.sales[0].price, 100)
  assert.equal(result.sales[0].sum, 200)
  assert.equal(result.sales[0].lines.length, 1)
  assert.equal(result.sales[0].lines[0].sum, 200)
  assert.equal(result.sales[0].payment.status, 'paid')
  const reportCall = calls.find((call) => call.path === '/report/turnover/byoperations')
  assert.equal(reportCall.params.momentFrom, '2026-10-01 00:00:00')
  assert.equal(reportCall.params.momentTo, '2026-10-31 23:59:59')
  assert.equal(reportCall.params.filter, `product=${productHref}`)
  assert.equal(calls.some((call) => call.path === '/entity/demand'), false)
  assert.equal(calls.some((call) => call.path === '/entity/demand/d1/positions'), true)
})

test('product search opens the order shipment and uses its line price', async () => {
  const productHref = 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1'
  const client = {
    async get(path, params) {
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/assortment') {
        if (String(params.filter).includes('archived=true')) return { rows: [], meta: { size: 0 } }
        return { rows: [{ name: 'Кабель', meta: { href: productHref, type: 'product' } }], meta: { size: 1 } }
      }
      if (path === '/report/turnover/byoperations') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/customerorder') {
        return {
          rows: [{
            id: 'o1',
            name: '04160',
            moment: '2026-11-12 19:49:00',
            sum: 3275400,
            agent: { name: 'Роман' },
            demands: [{
              meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand' },
            }],
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/demand/d1') {
        return {
          id: 'd1',
          name: '01827',
          moment: '2026-11-12 19:50:00',
          sum: 993600,
          applicable: true,
          agent: { name: 'Роман' },
          positions: {
            meta: { size: 1 },
            rows: [{
              quantity: 1,
              price: 993600,
              discount: 0,
              assortment: { name: 'Кабель', meta: { href: productHref } },
            }],
          },
        }
      }
      if (path === '/entity/retaildemand') return { rows: [], meta: { size: 0 } }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-11', product: 'кабель' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Отгрузка')
  assert.equal(result.sales[0].name, '01827')
  assert.equal(result.sales[0].price, 9936)
  assert.equal(result.sales[0].sum, 9936)
  assert.equal(result.sales[0].payment.status, 'unpaid')
})

test('payment status follows the linked order and a retail receipt', () => {
  assert.equal(paymentStatus(50000, 50000, 'order').status, 'paid')
  assert.equal(paymentStatus(0, 3275400, 'order').status, 'unpaid')
  assert.equal(paymentStatus(1000, 3275400, 'order').status, 'partial')
  assert.equal(paymentStatus(undefined, undefined).status, 'unknown')
})

test('shipment payment comes from the order, retail payment from the receipt', async () => {
  const calls = []
  const client = {
    async get(path, params) {
      calls.push(path)
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/customerorder') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/demand') {
        return {
          rows: [{
            id: 'd1',
            name: '01827',
            moment: '2026-11-02 10:00:00',
            sum: 1349000,
            payedSum: 1349000,
            agent: { name: 'Пикар' },
            customerOrder: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/o2', type: 'customerorder' } },
            positions: { meta: { size: 1 } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/customerorder/o2') return { payedSum: 1000000, sum: 1349000 }
      if (path === '/entity/retaildemand') {
        return {
          rows: [{
            id: 'r1',
            name: '04160',
            moment: '2026-11-12 19:49:00',
            sum: 3275400,
            cashSum: 3275400,
            agent: { name: 'Роман' },
            positions: { meta: { size: 1 } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/retaildemand/r1/positions' || path === '/entity/demand/d1/positions') {
        return { rows: [{ quantity: 1, price: 100, discount: 0, assortment: { name: 'Кабель' } }], meta: { size: 1 } }
      }
      if (path === '/entity/retailsalesreturn' || path === '/entity/salesreturn') return { rows: [], meta: { size: 0 } }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-11', number: '0' })
  const shipment = result.sales.find((sale) => sale.kind === 'demand')
  const sale = result.sales.find((row) => row.kind === 'retaildemand')
  assert.equal(shipment.payment.status, 'partial')
  assert.equal(shipment.payment.source, 'order')
  assert.equal(sale.payment.status, 'paid')
  assert.equal(sale.payment.source, 'document')
  assert.equal(calls.includes('/entity/customerorder/o2'), true)
  assert.equal(calls.includes('/entity/retaildemand/r1'), false)
})

test('search includes a posted customer order', async () => {
  const order = {
    id: 'o1',
    name: '04160',
    moment: '2026-11-12 19:49:00',
    sum: 3275400,
    agent: { name: 'Иванов' },
    positions: { meta: { size: 1 } },
    demands: [{
      meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand' },
    }],
  }
  const client = {
    async get(path, params) {
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/customerorder') return { rows: [order], meta: { size: 1 } }
      if (path === '/entity/demand' || path === '/entity/retaildemand') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/demand/d1') {
        return {
          id: 'd1',
          name: '01800',
          moment: '2026-11-12 20:10:00',
          sum: 3275400,
          applicable: true,
          agent: { name: 'Иванов' },
          positions: { meta: { size: 1 }, rows: [] },
        }
      }
      if (path === '/entity/demand/d1/positions') {
        return {
          rows: [{ quantity: 1, price: 3275400, discount: 0, assortment: { name: 'Кабель' } }],
          meta: { size: 1 },
        }
      }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-11', number: '04160' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Отгрузка')
  assert.equal(result.sales[0].name, '01800')
  assert.equal(result.sales[0].sum, 32754)
  assert.equal(result.sales[0].href, 'https://online.moysklad.ru/app/#demand/edit?id=d1')
  assert.equal(result.notice, '')
})

test('order number opens a retail sale when the shipment link is missing', async () => {
  const missing = Object.assign(
    new Error("Объект с типом 'demand' и идентификатором 'f052' не найден"),
    { status: 404 },
  )
  const client = {
    async get(path, params) {
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/customerorder') {
        return {
          rows: [{
            id: 'o1',
            name: '05347',
            moment: '2026-11-12 19:33:00',
            sum: 598500,
            demands: [{
              meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/f052', type: 'demand' },
            }],
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/demand' || path === '/entity/retaildemand') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/demand/f052') throw missing
      if (path === '/entity/retaildemand/f052') {
        return {
          id: 'f052',
          name: '04160',
          moment: '2026-11-12 19:40:00',
          sum: 598500,
          applicable: true,
          positions: { meta: { size: 1 } },
        }
      }
      if (path === '/entity/retaildemand/f052/positions') {
        return {
          rows: [{ quantity: 1, price: 598500, discount: 0, assortment: { name: 'Динамик' } }],
          meta: { size: 1 },
        }
      }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-11', number: '05347' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Продажа')
  assert.equal(result.sales[0].name, '04160')
  assert.equal(result.sales[0].sum, 5985)
  assert.equal(result.notice, '')
})

test('an unposted shipment stays hidden and the order opens its posted retail sale', async () => {
  const calls = []
  const client = {
    async get(path, params) {
      calls.push({ path, filter: params.filter })
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      if (path === '/entity/customerorder') {
        return {
          rows: [{
            id: 'o1',
            name: '05347',
            moment: '2026-11-12 19:33:00',
            sum: 598500,
            payedSum: 598500,
            demands: [{
              meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand' },
            }],
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/demand') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/demand/d1') {
        return {
          id: 'd1',
          name: '01800',
          moment: '2026-11-12 19:35:00',
          sum: 598500,
          applicable: false,
        }
      }
      if (path === '/entity/retaildemand') {
        const filter = String(params.filter || '')
        if (filter.includes('customerOrder=')) throw new Error('customerOrder filter')
        if (filter.includes('name~')) return { rows: [], meta: { size: 0 } }
        return {
          rows: [{
            id: 'r1',
            name: '00999',
            moment: '2026-11-12 19:40:00',
            sum: 598500,
            applicable: true,
            customerOrder: {
              meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/o1', type: 'customerorder' },
            },
            positions: { meta: { size: 1 } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/retaildemand/r1/positions') {
        return {
          rows: [{ quantity: 1, price: 598500, discount: 0, assortment: { name: 'Динамик' } }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/salesreturn' || path === '/entity/retailsalesreturn') {
        return { rows: [], meta: { size: 0 } }
      }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-11', number: '05347' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Продажа')
  assert.equal(result.sales[0].name, '00999')
  assert.equal(result.sales[0].sum, 5985)
  assert.equal(result.sales[0].payment.status, 'paid')
  const retailReturn = calls.find((call) => call.path === '/entity/retailsalesreturn')
  assert.match(retailReturn.filter, /(?:^|;)retailDemand=/)
  assert.doesNotMatch(retailReturn.filter, /(?:^|;)demand=/)
  assert.equal(calls.some((call) => String(call.filter || '').includes('customerOrder=')), false)
})

test('a sale number from another month still opens that sale', async () => {
  const client = {
    async get(path, params) {
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      const filter = String(params.filter || '')
      if (path === '/entity/customerorder' || path === '/entity/demand') return { rows: [], meta: { size: 0 } }
      if (path === '/entity/retaildemand') {
        if (filter.includes('moment')) return { rows: [], meta: { size: 0 } }
        return {
          rows: [{
            id: 'r1',
            name: '04164',
            moment: '2026-11-01 12:00:00',
            sum: 10000,
            applicable: true,
            agent: { name: 'Роман' },
            positions: { meta: { size: 1 } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/retaildemand/r1/positions') {
        return {
          rows: [{ quantity: 1, price: 10000, discount: 0, assortment: { name: 'Кабель' } }],
          meta: { size: 1 },
        }
      }
      throw new Error(path)
    },
  }
  const result = await searchSales({ client, month: '2026-12', number: '04164' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Продажа')
  assert.equal(result.sales[0].name, '04164')
})

test('a site order number opens the posted sale and hides the order', async () => {
  const siteHref = 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/site'
  const client = {
    async get(path, params) {
      if (params.offset > 0) return { rows: [], meta: { size: 0 } }
      const filter = String(params.filter || '')
      if (path === '/entity/customerorder/metadata') {
        return {
          attributes: [{ name: 'Номер заказа на сайте', meta: { href: siteHref, type: 'attributemetadata' } }],
        }
      }
      if (path === '/entity/demand/metadata' || path === '/entity/retaildemand/metadata') return { attributes: [] }
      if (path === '/entity/customerorder') {
        if (!filter.includes(siteHref)) return { rows: [], meta: { size: 0 } }
        return {
          rows: [{
            id: 'o1',
            name: '05347',
            moment: '2026-11-12 19:33:00',
            sum: 598500,
            payedSum: 598500,
            demands: [{ meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/d1', type: 'demand' } }],
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/demand' || path === '/entity/demand/d1') {
        if (path === '/entity/demand/d1') {
          return { id: 'd1', name: '01800', applicable: false, moment: '2026-11-12 19:35:00', sum: 598500 }
        }
        return { rows: [], meta: { size: 0 } }
      }
      if (path === '/entity/retaildemand') {
        if (filter.includes('name~') || filter.includes('description~') || filter.includes('externalCode~')) {
          return { rows: [], meta: { size: 0 } }
        }
        return {
          rows: [{
            id: 'r1',
            name: '04164',
            moment: '2026-11-12 19:40:00',
            sum: 598500,
            applicable: true,
            customerOrder: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/o1' } },
            positions: { meta: { size: 1 } },
          }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/retaildemand/r1/positions') {
        return {
          rows: [{ quantity: 1, price: 598500, discount: 0, assortment: { name: 'Динамик' } }],
          meta: { size: 1 },
        }
      }
      if (path === '/entity/salesreturn' || path === '/entity/retailsalesreturn') return { rows: [], meta: { size: 0 } }
      throw new Error(`${path} ${filter}`)
    },
  }
  const result = await searchSales({ client, month: '2026-12', number: '1011760' })
  assert.equal(result.sales.length, 1)
  assert.equal(result.sales[0].label, 'Продажа')
  assert.equal(result.sales[0].name, '04164')
})

test('product suggestions keep the ten closest matches', () => {
  const rows = [
    { name: 'Другой товар', article: 'ZZ', code: '9', meta: { type: 'product' } },
    { name: 'Коаксиальная акустика Oris FT-652', article: 'OR-652', code: '32506862', meta: { type: 'product' } },
    { name: 'Oris', article: 'OR', code: '1', meta: { type: 'product' } },
    { name: 'Oris FT-165', article: 'OR-165', code: '32506577', meta: { type: 'product' } },
  ]
  for (let index = 0; index < 12; index += 1) {
    rows.push({ name: `Oris запас ${index}`, article: `A${index}`, code: String(index), meta: { type: 'product' } })
  }
  rows.push({ name: 'Папка', meta: { type: 'productfolder' } })
  const items = rankProductSuggestions(rows, 'oris')
  assert.equal(items.length, 10)
  assert.equal(items[0].name, 'Oris')
  assert.equal(items[1].name, 'Oris FT-165')
  assert.equal(items.some((item) => item.name === 'Другой товар'), false)
  assert.equal(items.some((item) => item.name === 'Папка'), false)
  const byCode = rankProductSuggestions(rows, '32506862')
  assert.equal(byCode[0].name, 'Коаксиальная акустика Oris FT-652')
  assert.equal(byCode[0].code, '32506862')
})

test('a partial name is found inside the product title', async () => {
  let calls = 0
  const client = {
    async get(path, params) {
      calls += 1
      assert.equal(path, '/entity/assortment')
      assert.equal(params.limit, 100)
      assert.equal(params.filter, 'archived=false;name~Oris')
      assert.equal(params.search, undefined)
      return {
        rows: [
          { name: 'Коаксиальная акустика Oris FT-652', article: 'OR-652', code: '32506862', meta: { type: 'product' } },
          { name: '2x-компонентная акустика Oris FT-165 Fighter', article: 'OR-165', code: '32506577', meta: { type: 'product' } },
        ],
      }
    },
  }
  assert.deepEqual(await suggestProducts(client, ' о '), [])
  assert.equal(calls, 0)
  const items = await suggestProducts(client, ' Oris FT ')
  assert.equal(calls, 1)
  assert.deepEqual(items.map((item) => item.code), ['32506862', '32506577'])
})

test('a code suggestion uses the word index when the title has no such text', async () => {
  const client = {
    async get(path, params) {
      assert.equal(path, '/entity/assortment')
      if (String(params.filter).includes('name~')) return { rows: [] }
      assert.equal(params.search, '32506862')
      return {
        rows: [{ name: 'Коаксиальная акустика Oris FT-652', article: 'OR-652', code: '32506862', meta: { type: 'product' } }],
      }
    },
  }
  const items = await suggestProducts(client, '32506862')
  assert.equal(items[0].name, 'Коаксиальная акустика Oris FT-652')
})

test('words in another order still find the same product', async () => {
  const client = {
    async get(path, params) {
      assert.equal(path, '/entity/assortment')
      assert.equal(params.filter, 'archived=false;name~652')
      assert.equal(params.limit, 100)
      return {
        rows: [
          { name: 'Коаксиальная акустика Oris FT-652', article: 'OR-652', code: '32506862', meta: { type: 'product' } },
          { name: '2x-компонентная акустика Oris FT-165 Fighter', article: 'OR-165', code: '32506577', meta: { type: 'product' } },
        ],
      }
    },
  }
  const items = await suggestProducts(client, '652 oris')
  assert.deepEqual(items.map((item) => item.code), ['32506862'])
})
