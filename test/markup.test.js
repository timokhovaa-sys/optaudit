import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentDocuments,
  agentMonthPoints,
  averageMarkup,
  groupReport,
  monthTotals,
  lineEconomics,
  missedProfit,
  monthBounds,
  selectAgentsByName,
  summarizeShipment,
  tagVariants,
  yearBounds,
  addSupplyPrices,
  lastSupplyUnitMinor,
  supplyDocumentPrices,
} from '../src/markup.js'
import { demandFilter, documentShare, parseOrderLink, saleDocumentLinks } from '../src/report.js'
import { salesReportHtml } from '../src/sales-pdf.js'

const rub = {
  vatEnabled: true,
  vatIncluded: true,
  rate: { value: 1 },
}

test('year bounds cover 1 January through 31 December', () => {
  assert.deepEqual(yearBounds(2026), {
    year: 2026,
    from: '2026-01-01 00:00:00',
    to: '2026-12-31 23:59:59',
  })
  assert.throws(() => yearBounds('2026-10'), /Год/)
})

test('agent search prefers one exact name and folds yo', () => {
  const agents = [
    { id: '1', name: 'Иванова' },
    { id: '2', name: 'Иванов' },
    { id: '3', name: 'Ёлка и Ко', archived: true },
  ]
  assert.equal(selectAgentsByName(agents, 'и').status, 'short')
  assert.equal(selectAgentsByName(agents, 'Иванов').status, 'one')
  assert.equal(selectAgentsByName(agents, 'Иванов').matches[0].id, '2')
  assert.equal(selectAgentsByName(agents, 'иван').status, 'many')
  assert.equal(selectAgentsByName(agents, 'иван').matches.length, 2)
  const folded = selectAgentsByName(agents, 'елка')
  assert.equal(folded.status, 'one')
  assert.equal(folded.matches[0].id, '3')
  assert.equal(folded.matches[0].archived, true)
  assert.equal(selectAgentsByName(agents, 'нет такого').status, 'none')
})

test('agent month points use the same sales, markup and missed as a month', () => {
  const points = agentMonthPoints([
    {
      moment: '2026-01-15 10:00:00',
      lines: [
        { saleMinor: 11800, costMinor: 10000, costKnown: true, excluded: false, markup: 18 },
        { saleMinor: 10000, costMinor: 10000, costKnown: true, excluded: false, markup: 0 },
      ],
    },
    {
      moment: '2026-03-02 10:00:00',
      lines: [
        { saleMinor: 5000, costMinor: 4000, costKnown: true, excluded: false, markup: 25 },
      ],
    },
    {
      moment: '2025-12-01 10:00:00',
      lines: [
        { saleMinor: 9000, costMinor: 1000, costKnown: true, excluded: false, markup: 800 },
      ],
    },
  ], 18, 2026)
  assert.deepEqual(points.map((point) => point.month), ['2026-01', '2026-03'])
  assert.equal(points[0].sales, 218)
  assert.equal(points[0].profit, 18)
  assert.equal(points[0].netProfit, 10.37)
  assert.equal(points[0].averageMarkup, 9)
  assert.equal(points[0].missed, 18)
  assert.equal(points[1].missed, 0)
  assert.equal(points[1].sales, 50)
  assert.equal(points[1].netProfit, 8.25)
})

test('sales pdf lists the shipment date, number and sum without profit', () => {
  const html = salesReportHtml({
    agentName: 'Иванов <опт>',
    year: 2026,
    months: [{ month: '2026-01', sales: 218 }],
    documents: [{ moment: '2026-01-15 10:00:00', name: '0007', sum: 218 }],
  })
  assert.match(html, /15\.01\.2026/)
  assert.match(html, /0007/)
  assert.match(html, /218,00/)
  assert.match(html, /Иванов &lt;опт&gt;/)
  assert.equal(html.includes('Прибыль'), false)
  assert.equal(html.includes('Чистая'), false)
})

test('sales pdf follows the selected chart series', () => {
  const html = salesReportHtml({
    agentName: 'Иванов',
    year: 2026,
    series: ['sales', 'profit', 'net'],
    threshold: 18,
    months: [{ month: '2026-01', sales: 218, profit: 18, netProfit: 10.37, averageMarkup: 9, missed: 18 }],
    documents: [{
      moment: '2026-01-15 10:00:00',
      name: '0007',
      sum: 218,
      sales: 218,
      profit: 18,
      netProfit: 10.37,
      markup: 9,
      missed: 18,
    }],
  })
  assert.match(html, /Продажи, Прибыль, Чистая прибыль/)
  assert.match(html, /fill="#b7791f"/)
  assert.match(html, /fill="#1d4e89"/)
  assert.match(html, /18,00/)
  assert.match(html, /10,37/)
  assert.equal(html.includes('Упущено'), false)
  assert.equal(html.includes('Наценка'), false)
})

test('agent documents keep the shipment date, number and sum', () => {
  const rows = agentDocuments([
    { moment: '2026-03-02 09:00:00', name: '20', saleExVat: 50, kind: 'demand' },
    { moment: '2026-01-15 10:00:00', name: '7', saleExVat: 218, kind: 'retaildemand' },
    { moment: '2025-12-01 10:00:00', name: '1', saleExVat: 90, kind: 'demand' },
  ], 2026)
  assert.deepEqual(rows, [
    {
      moment: '2026-01-15 10:00:00', name: '7', kind: 'retaildemand',
      sum: 218, sales: 218, profit: null, netProfit: null, markup: null, missed: null,
    },
    {
      moment: '2026-03-02 09:00:00', name: '20', kind: 'demand',
      sum: 50, sales: 50, profit: null, netProfit: null, markup: null, missed: null,
    },
  ])
  const priced = agentDocuments([{
    moment: '2026-01-15 10:00:00',
    name: '0007',
    kind: 'demand',
    lines: [
      { saleMinor: 11800, costMinor: 10000, costKnown: true, excluded: false, markup: 18 },
      { saleMinor: 10000, costMinor: 10000, costKnown: true, excluded: false, markup: 0 },
    ],
  }], 2026, 18)
  assert.equal(priced[0].sales, 218)
  assert.equal(priced[0].profit, 18)
  assert.equal(priced[0].netProfit, 10.37)
  assert.equal(priced[0].markup, 9)
  assert.equal(priced[0].missed, 18)
})

test('month bounds cover the whole month, including February in a leap year', () => {
  assert.deepEqual(monthBounds('2026-10'), {
    from: '2026-10-01 00:00:00',
    to: '2026-10-31 23:59:59',
  })
  assert.equal(monthBounds('2024-02').to, '2024-02-29 23:59:59')
})

test('tag variants keep the original spelling and a capitalized form', () => {
  assert.deepEqual(tagVariants('оптовики'), ['оптовики', 'Оптовики'])
  assert.deepEqual(tagVariants('ОПТОВИКИ'), ['ОПТОВИКИ', 'оптовики', 'Оптовики'])
})

test('markup of 18% is not below the threshold, 17% is', () => {
  const atThreshold = lineEconomics(
    { quantity: 1, price: 11800, discount: 0, vat: 0, assortment: { buyPrice: { value: 10000 } } },
    rub,
  )
  const below = lineEconomics(
    { quantity: 1, price: 11700, discount: 0, vat: 0, assortment: { buyPrice: { value: 10000 } } },
    rub,
  )
  assert.equal(atThreshold.markup, 18)
  assert.equal(below.markup, 17)
  const exact = summarizeShipment({ ...rub, rate: { value: 1 } }, [
    { quantity: 1, price: 11800, discount: 0, vat: 0, assortment: { buyPrice: { value: 10000 } } },
  ], 18)
  const low = summarizeShipment({ ...rub, rate: { value: 1 } }, [
    { quantity: 1, price: 11700, discount: 0, vat: 0, assortment: { buyPrice: { value: 10000 } } },
  ], 18)
  assert.equal(exact.low, false)
  assert.equal(low.low, true)
})

test('discount, negative discount, included VAT, rate and pack change the markup', () => {
  const discounted = lineEconomics(
    { quantity: 1, price: 10000, discount: 10, vat: 0, assortment: { buyPrice: { value: 8000 } } },
    rub,
  )
  assert.equal(discounted.saleMinor, 9000)
  assert.equal(discounted.markup, 12.5)

  const extra = lineEconomics(
    { quantity: 1, price: 10000, discount: -10, vat: 0, assortment: { buyPrice: { value: 10000 } } },
    rub,
  )
  assert.equal(extra.saleMinor, 11000)
  assert.equal(extra.markup, 10)

  const withVat = lineEconomics(
    { quantity: 1, price: 12000, discount: 0, vat: 20, vatEnabled: true, assortment: { buyPrice: { value: 10000 } } },
    rub,
  )
  assert.equal(withVat.saleMinor, 12000)
  assert.equal(withVat.markup, 20)

  const vatNotIncluded = lineEconomics(
    { quantity: 1, price: 12000, discount: 0, vat: 20, vatEnabled: true, assortment: { buyPrice: { value: 10000 } } },
    { vatEnabled: true, vatIncluded: false, rate: { value: 1 } },
  )
  assert.equal(vatNotIncluded.markup, 20)

  const converted = lineEconomics(
    { quantity: 1, price: 10000, discount: 0, vat: 0, assortment: { buyPrice: { value: 10000 } } },
    { vatEnabled: false, vatIncluded: false, rate: { value: 2 } },
  )
  assert.equal(converted.saleMinor, 20000)
  assert.equal(converted.markup, 100)

  const packed = lineEconomics(
    {
      quantity: 2,
      price: 5000,
      discount: 0,
      vat: 0,
      pack: { quantity: 10 },
      assortment: { buyPrice: { value: 400 } },
    },
    rub,
  )
  assert.equal(packed.saleMinor, 10000)
  assert.equal(packed.costMinor, 8000)
  assert.equal(packed.markup, 25)
})

test('VAT charged on top is not inside the document sum', () => {
  const summary = summarizeShipment({
    vatEnabled: true,
    vatIncluded: false,
    rate: { value: 1 },
    sum: 10000,
    vatSum: 2000,
  }, [
    { quantity: 1, price: 10000, discount: 0, vat: 20, vatEnabled: true, assortment: { buyPrice: { value: 8000 } } },
  ], 18)
  assert.equal(summary.saleMinor, 10000)
  assert.equal(summary.lines[0].saleMinor, 10000)
  assert.equal(summary.markup, 25)
})

test('a line sum matches the shipment amount even when the price includes VAT', () => {
  const summary = summarizeShipment({
    vatEnabled: true,
    vatIncluded: true,
    rate: { value: 1 },
    sum: 1326500,
    vatSum: 63167,
  }, [
    { quantity: 2, price: 325800, discount: 0, vat: 5, vatEnabled: true, assortment: { name: 'СЧ динамики', buyPrice: { value: 250000 } } },
    { quantity: 1, price: 674900, discount: 0, vat: 5, vatEnabled: true, assortment: { name: 'Сабвуфер', buyPrice: { value: 530000 } } },
  ], 18)
  assert.deepEqual(summary.lines.map((line) => line.saleMinor), [651600, 674900])
  assert.equal(summary.saleMinor, 1326500)
})

test('cost is the buy price times quantity, and a missing buy price stays unknown', () => {
  const withOverhead = lineEconomics(
    { quantity: 1, price: 11000, discount: 0, vat: 0, overhead: 1000, assortment: { buyPrice: { value: 10000 } } },
    rub,
  )
  assert.equal(withOverhead.costMinor, 10000)
  assert.equal(withOverhead.markup, 10)

  const service = lineEconomics(
    { quantity: 2, price: 5000, discount: 0, vat: 0, assortment: { buyPrice: { value: 4000 } } },
    rub,
  )
  assert.equal(service.costMinor, 8000)
  assert.equal(service.markup, 25)

  const consignment = lineEconomics(
    {
      quantity: 2,
      price: 5000,
      discount: 0,
      vat: 0,
      assortment: { meta: { type: 'consignment' }, assortment: { buyPrice: { value: 3000 } } },
    },
    rub,
  )
  assert.equal(consignment.costMinor, 6000)

  const unknown = lineEconomics(
    { quantity: 1, price: 10000, discount: 0, vat: 0 },
    rub,
  )
  assert.equal(unknown.costKnown, false)
  assert.equal(unknown.markup, null)

  const partial = summarizeShipment(rub, [
    { quantity: 1, price: 11000, discount: 0, vat: 0, assortment: { name: 'А', buyPrice: { value: 10000 } } },
    { quantity: 1, price: 5000, discount: 0, vat: 0, assortment: { name: 'Б' } },
  ], 18)
  assert.equal(partial.costStatus, 'partial')
  assert.equal(partial.markup, 10)
  assert.equal(partial.low, true)
})

test('purchase price is the last supply before the order, not the card price', () => {
  const supply = { rate: { value: 1 } }
  const packed = supplyDocumentPrices(supply, [{
    quantity: 2,
    price: 8000,
    discount: 0,
    pack: { quantity: 4 },
    assortment: { id: 'p1' },
  }])
  assert.equal(packed.get('p1'), 2000)

  const discounted = supplyDocumentPrices(supply, [{
    quantity: 1,
    price: 10000,
    discount: 10,
    assortment: { id: 'p1' },
  }])
  assert.equal(discounted.get('p1'), 9000)

  const timelines = new Map()
  addSupplyPrices(timelines, '2026-03-01 09:00:00.000', new Map([['p1', 10000], ['v1', 5000]]))
  addSupplyPrices(timelines, '2026-03-20 09:00:00', new Map([['p1', 20000]]))
  const product = { id: 'p1', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1' }, buyPrice: { value: 99999 } }
  const variant = { id: 'v1', meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/variant/v1' }, assortment: product }
  assert.equal(lastSupplyUnitMinor(timelines, product, '2026-03-10 12:00:00'), 10000)
  assert.equal(lastSupplyUnitMinor(timelines, product, '2026-03-20 09:00:00.000'), 10000)
  assert.equal(lastSupplyUnitMinor(timelines, product, '2026-03-25 09:00:00'), 20000)
  assert.equal(lastSupplyUnitMinor(timelines, product, '2026-02-01 00:00:00'), null)
  assert.equal(lastSupplyUnitMinor(timelines, variant, '2026-03-25 09:00:00'), 5000)

  const position = { quantity: 2, price: 15000, discount: 0, vat: 0, assortment: product }
  const early = summarizeShipment({
    ...rub,
    moment: '2026-03-25 10:00:00',
    customerOrder: { moment: '2026-03-10 12:00:00' },
  }, [position], 18, {
    unitPriceOf: (line, demand) => lastSupplyUnitMinor(timelines, line.assortment, demand.customerOrder?.moment || demand.moment),
  })
  assert.equal(early.lines[0].buyMinor, 10000)
  assert.equal(early.lines[0].costMinor, 20000)
  assert.equal(lineEconomics(position, rub).buyMinor, 99999)

  const missing = summarizeShipment(rub, [position], 18, { unitPriceOf: () => null })
  assert.equal(missing.lines[0].costKnown, false)
  assert.equal(missing.lines[0].markup, null)
  assert.equal(missing.costStatus, 'none')
})

test('an order is included when any of its shipments is under the threshold', () => {
  const order = { id: 'order-1', name: '00015', moment: '2026-10-02 10:00:00.000', sum: 100, href: null }
  const agent = { id: 'agent-1', name: 'ООО Север' }
  const { orders, unlinked } = groupReport([
    { id: 'd1', markup: 12, saleExVat: 100, order, agent, moment: '2026-10-03 10:00:00.000' },
    { id: 'd2', markup: 30, saleExVat: 200, order, agent, moment: '2026-10-04 10:00:00.000' },
    { id: 'd3', markup: 40, order: { id: 'order-2', name: '00016' }, agent, moment: '2026-10-05 10:00:00.000' },
    { id: 'd4', markup: 9, order: null, agent, moment: '2026-10-06 10:00:00.000' },
    { id: 'd5', markup: null, order: null, agent, moment: '2026-10-07 10:00:00.000' },
  ], 18)

  assert.equal(orders.length, 1)
  assert.equal(orders[0].name, '00015')
  assert.deepEqual(orders[0].shipments.map((shipment) => shipment.id), ['d1', 'd2'])
  assert.equal(orders[0].lowestMarkup, 12)
  assert.equal(orders[0].saleExVat, 300)
  assert.deepEqual(unlinked.map((shipment) => shipment.id), ['d4'])
})

test('average markup weights the month by cost and skips exclusions', () => {
  const markup = averageMarkup([
    { saleMinor: 15000, costMinor: 10000, costKnown: true },
    { saleMinor: 5000, costMinor: 5000, costKnown: true },
    { saleMinor: 100, costMinor: 10000, costKnown: true, excluded: true },
    { saleMinor: 8000, costMinor: null, costKnown: false },
  ])
  assert.equal(Math.round(markup * 10) / 10, 33.3)
  assert.equal(averageMarkup([]), null)
  assert.equal(averageMarkup([{ saleMinor: 100, costMinor: 0, costKnown: true }]), null)
})

test('month totals count every sale and profit only on markup lines', () => {
  const totals = monthTotals([
    { saleMinor: 15000, costMinor: 10000, costKnown: true },
    { saleMinor: 5000, costMinor: 5000, costKnown: true },
    { saleMinor: 100, costMinor: 10000, costKnown: true, excluded: true },
    { saleMinor: 8000, costMinor: null, costKnown: false },
  ])
  assert.equal(totals.salesMinor, 28100)
  assert.equal(totals.profitMinor, 5000)
})

test('missed profit is the gap up to the threshold markup', () => {
  const lines = [
    { saleMinor: 640000, costMinor: 590000, markup: (640000 - 590000) / 590000 * 100, costKnown: true },
    { saleMinor: 200000, costMinor: 163363, markup: 22.4, costKnown: true },
    { saleMinor: 150000, costMinor: 140000, markup: (150000 - 140000) / 140000 * 100, costKnown: true },
    { saleMinor: 10000, costMinor: null, markup: null, costKnown: false },
    { saleMinor: 11800, costMinor: 10000, markup: 18, costKnown: true },
  ]
  const missed = missedProfit(lines, 18)
  assert.equal(missed.positions, 2)
  assert.equal(missed.amountMinor, 56200 + 15200)
  assert.equal(missed.saleMinor, 640000 + 150000)
  assert.equal(missed.targetMinor, 696200 + 165200)
  assert.equal(missedProfit([{ saleMinor: 5000, costMinor: 10000, markup: -50, costKnown: true }], 18).amountMinor, 6800)
})

test('the branded aromatizer is excluded from threshold and missed profit', () => {
  const aromatizer = {
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Фирменный ароматизатор Bass-Line', article: '2754', buyPrice: { value: 20000 } },
  }
  const fine = {
    quantity: 1,
    price: 15000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Кабель', article: 'CB', buyPrice: { value: 10000 } },
  }
  const summary = summarizeShipment(rub, [aromatizer, fine], 18)
  assert.equal(summary.lines[0].excluded, true)
  assert.equal(summary.low, false)
  assert.equal(summary.markup, 50)
  assert.equal(missedProfit(summary.lines, 18).positions, 0)

  const alone = summarizeShipment(rub, [aromatizer], 18)
  assert.equal(alone.low, false)
  assert.equal(alone.markup, null)

  const byCode = lineEconomics({
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Другое имя', code: '2754', buyPrice: { value: 20000 } },
  }, rub)
  assert.equal(byCode.excluded, true)

  const stillLow = summarizeShipment(rub, [
    aromatizer,
    { quantity: 1, price: 11000, discount: 0, vat: 0, assortment: { name: 'Кабель', buyPrice: { value: 10000 } } },
  ], 18)
  assert.equal(stillLow.low, true)
  assert.equal(stillLow.lines[0].excluded, true)
  assert.equal(missedProfit(stillLow.lines, 18).positions, 1)

  const agent = { id: 'agent-1', name: 'ООО Север' }
  const { orders, unlinked } = groupReport([
    { id: 'alone', markup: alone.markup, saleExVat: 100, order: { id: 'o1', name: 'только ароматизатор' }, agent },
    { id: 'fine', markup: summary.markup, saleExVat: 250, order: { id: 'o2', name: 'с нормальным' }, agent },
    { id: 'low', markup: stillLow.markup, saleExVat: 210, order: { id: 'o3', name: 'с низким' }, agent },
    { id: 'free', markup: alone.markup, saleExVat: 100, order: null, agent },
  ], 18)
  assert.deepEqual(orders.map((order) => order.id), ['o3'])
  assert.deepEqual(unlinked.map((shipment) => shipment.id), [])
})

test('the branded white sticker is excluded from threshold and missed profit', () => {
  const sticker = {
    quantity: 1,
    price: 5000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Фирменная наклейка Bass-Line (белая)', article: '2755', buyPrice: { value: 10000 } },
  }
  const alone = summarizeShipment(rub, [sticker], 18)
  assert.equal(alone.lines[0].excluded, true)
  assert.equal(alone.low, false)
  assert.equal(alone.markup, null)
  assert.equal(missedProfit(alone.lines, 18).positions, 0)

  const withFine = summarizeShipment(rub, [
    sticker,
    { quantity: 1, price: 15000, discount: 0, vat: 0, assortment: { name: 'Кабель', article: 'CB', buyPrice: { value: 10000 } } },
  ], 18)
  assert.equal(withFine.low, false)
  assert.equal(withFine.markup, 50)

  const byCode = lineEconomics({
    quantity: 1,
    price: 5000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Другое имя', code: '2755', buyPrice: { value: 10000 } },
  }, rub)
  assert.equal(byCode.excluded, true)

  const near = lineEconomics({
    quantity: 1,
    price: 5000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Другой товар', article: '27550', buyPrice: { value: 1000 } },
  }, rub)
  assert.equal(near.excluded, false)
})

test('a series or variant of the aromatizer is the same exclusion', () => {
  const series = lineEconomics({
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: {
      meta: { type: 'consignment' },
      name: 'Серия 12',
      code: 'S-12',
      assortment: { name: 'Фирменный ароматизатор Bass-Line', article: '2754', buyPrice: { value: 20000 } },
    },
  }, rub)
  assert.equal(series.excluded, true)
  assert.equal(series.name, 'Серия 12')

  const dash = lineEconomics({
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Фирменный ароматизатор Bass–Line', buyPrice: { value: 20000 } },
  }, rub)
  assert.equal(dash.excluded, true)

  const variant = lineEconomics({
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: {
      name: 'Фирменный ароматизатор Bass-Line (новый)',
      code: '999',
      product: { name: 'Фирменный ароматизатор Bass-Line', article: '2754' },
    },
  }, rub)
  assert.equal(variant.excluded, true)

  const other = lineEconomics({
    quantity: 1,
    price: 10000,
    discount: 0,
    vat: 0,
    assortment: { name: 'Другой товар', article: '27540', buyPrice: { value: 1000 } },
  }, rub)
  assert.equal(other.excluded, false)
})

test('document share splits successful shipments and sales from those under the threshold', () => {
  const share = documentShare([
    { kind: 'demand', low: false, markup: 30 },
    { kind: 'demand', low: true, markup: 9 },
    { kind: 'retaildemand', low: true, markup: 4 },
    { kind: 'retaildemand', low: false, markup: null },
    { kind: 'demand', low: false, markup: null },
  ])
  assert.deepEqual(share.demand, { ok: 1, low: 1, unknown: 1 })
  assert.deepEqual(share.retaildemand, { ok: 0, low: 1, unknown: 1 })
})

test('order link accepts a customer order, a shipment and a bare id', () => {
  assert.deepEqual(
    parseOrderLink('https://online.moysklad.ru/app/#customerorder/edit?id=dce0ee41-c666-11f1-0a80-0405005906e6'),
    { kind: 'customerorder', id: 'dce0ee41-c666-11f1-0a80-0405005906e6' },
  )
  assert.deepEqual(
    parseOrderLink('https://online.moysklad.ru/app/#demand/edit?id=50eb047c-874c-11f1-0a80-0e02000bc196'),
    { kind: 'demand', id: '50eb047c-874c-11f1-0a80-0e02000bc196' },
  )
  assert.deepEqual(
    parseOrderLink('https://api.moysklad.ru/api/remap/1.2/entity/retaildemand/50eb047c-874c-11f1-0a80-0e02000bc196'),
    { kind: 'retaildemand', id: '50eb047c-874c-11f1-0a80-0e02000bc196' },
  )
  assert.deepEqual(parseOrderLink('DCE0EE41-C666-11F1-0A80-0405005906E6'), {
    kind: 'customerorder',
    id: 'dce0ee41-c666-11f1-0a80-0405005906e6',
  })
  assert.throws(() => parseOrderLink(''), /ссылку на заказ/)
  assert.throws(() => parseOrderLink('не ссылка'), /ссылка на заказ/)
})

test('an order check follows the demands listed on the order', () => {
  const links = saleDocumentLinks({
    demands: [
      { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/50eb047c-874c-11f1-0a80-0e02000bc196', type: 'demand' } },
      { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/demand/50eb047c-874c-11f1-0a80-0e02000bc196', type: 'demand' } },
    ],
  }, {
    id: 'aaaaaaaa-874c-11f1-0a80-0e02000bc196',
    kind: 'retaildemand',
  })
  assert.deepEqual(links.map((link) => link.kind + ':' + link.id), [
    'demand:50eb047c-874c-11f1-0a80-0e02000bc196',
    'retaildemand:aaaaaaaa-874c-11f1-0a80-0e02000bc196',
  ])
  assert.equal(links[1].prefetched.kind, 'retaildemand')
})

test('demand filter can name one order without a month', () => {
  assert.equal(
    demandFilter({
      postedOnly: true,
      extra: ['customerOrder=https://api.moysklad.ru/api/remap/1.2/entity/customerorder/abc'],
    }),
    'applicable=true;customerOrder=https://api.moysklad.ru/api/remap/1.2/entity/customerorder/abc',
  )
})

test('demand filter combines the month, posted flag and agents', () => {
  const filter = demandFilter({
    from: '2026-10-01 00:00:00',
    to: '2026-10-31 23:59:59',
    postedOnly: true,
    agentHrefs: ['https://api.moysklad.ru/api/remap/1.2/entity/counterparty/abc'],
  })
  assert.equal(
    filter,
    'moment>=2026-10-01 00:00:00;moment<=2026-10-31 23:59:59;applicable=true;agent=https://api.moysklad.ru/api/remap/1.2/entity/counterparty/abc',
  )
})
