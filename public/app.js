const monthInput = document.querySelector('#month')
const thresholdInput = document.querySelector('#threshold')
const postedInput = document.querySelector('#postedOnly')
const tokenInput = document.querySelector('#token')
const tokenHint = document.querySelector('#token-hint')
const form = document.querySelector('#filters')
const submitButton = document.querySelector('#submit')
const stopButton = document.querySelector('#stop')
const orderForm = document.querySelector('#order-form')
const orderLinkInput = document.querySelector('#order-link')
const orderSubmit = document.querySelector('#order-submit')
const orderCheck = document.querySelector('#order-check')
const agentForm = document.querySelector('#agent-form')
const agentNameInput = document.querySelector('#agent-name')
const agentSubmit = document.querySelector('#agent-submit')
const agentChart = document.querySelector('#agent-chart')
const agentTitle = document.querySelector('#agent-title')
const agentToggles = document.querySelector('#agent-toggles')
const agentMatches = document.querySelector('#agent-matches')
const agentPlot = document.querySelector('#agent-plot')
const agentEmpty = document.querySelector('#agent-empty')
const agentPdfButton = document.querySelector('#agent-pdf')
let clientDynamics = null
const progressBox = document.querySelector('#progress')
const progressText = document.querySelector('#progress-text')
const bar = document.querySelector('#bar')
const errorBox = document.querySelector('#error')
const errorText = document.querySelector('#error-text')
const results = document.querySelector('#results')
const statsBox = document.querySelector('#stats')
const shareBox = document.querySelector('#share')
const yearTitle = document.querySelector('#year-title')
const yearToggles = document.querySelector('#year-toggles')
const yearPlot = document.querySelector('#year-plot')
const yearEmpty = document.querySelector('#year-empty')
const suggestionsBox = document.querySelector('#suggestions')
const ordersBox = document.querySelector('#orders')
const unlinkedBox = document.querySelector('#unlinked')
const searchInput = document.querySelector('#search')
const sortInput = document.querySelector('#sort')
const onlyLowInput = document.querySelector('#only-low')
const tokenSaved = document.querySelector('#token-saved')
const tokenField = document.querySelector('#token-field')

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const amount = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const percent = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const qtyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 })

let current = null
let controller = null
let collecting = false
let savedRequest = 0
let yearRequest = 0
let yearRows = []
const savedToken = localStorage.getItem('moysklad.token')
if (savedToken) {
  tokenInput.value = savedToken
  tokenSaved.hidden = false
  tokenField.hidden = true
}

const prefs = loadPrefs()
const now = new Date()
monthInput.value = prefs.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
if (prefs.threshold != null) thresholdInput.value = prefs.threshold
if (typeof prefs.postedOnly === 'boolean') postedInput.checked = prefs.postedOnly
if (typeof prefs.onlyLow === 'boolean') onlyLowInput.checked = prefs.onlyLow
localStorage.removeItem('moysklad.orderLink')

fetch('/api/status')
  .then((response) => response.json())
  .then((status) => {
    tokenHint.textContent = status.hasToken
      ? 'Можно оставить пустым — токен задан на сервере.'
      : 'Хранится только в этом браузере.'
  })
  .catch(() => {
    tokenHint.textContent = 'Не удалось спросить сервер, задан ли токен.'
  })

form.addEventListener('submit', (event) => {
  event.preventDefault()
  runReport()
})
orderForm.addEventListener('submit', (event) => {
  event.preventDefault()
  runOrderCheck()
})
agentForm.addEventListener('submit', (event) => {
  event.preventDefault()
  runAgentDynamics()
})
agentPdfButton.addEventListener('click', () => downloadAgentPdf())

stopButton.addEventListener('click', () => controller?.abort())
document.querySelector('#token-edit').addEventListener('click', () => {
  tokenSaved.hidden = true
  tokenField.hidden = false
  tokenInput.focus()
})
searchInput.addEventListener('input', render)
sortInput.addEventListener('change', () => {
  savePrefs()
  render()
})
onlyLowInput.addEventListener('change', () => {
  savePrefs()
  render()
})
monthInput.addEventListener('change', () => {
  savePrefs()
  loadSavedReport(monthInput.value)
  loadYearChart()
})
thresholdInput.addEventListener('change', () => {
  savePrefs()
  renderYearChart(chartYear(), yearRows)
  renderClientChart()
})
document.querySelector('#expand-all').addEventListener('click', () => setDetails(true))
document.querySelector('#collapse-all').addEventListener('click', () => setDetails(false))
document.querySelector('#copy-orders').addEventListener('click', copyOrderLinks)
document.querySelector('#copy-manual').addEventListener('click', copyManualLinks)
loadSavedReport(monthInput.value)
loadYearChart()
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  event.preventDefault()
  searchInput.focus()
})

async function runReport() {
  savedRequest += 1
  controller?.abort()
  controller = new AbortController()
  setBusy(true)
  hideError()
  setProgress('Подключаюсь к МоемуСкладу…', 0.08)
  const token = tokenInput.value.trim()
  if (token) localStorage.setItem('moysklad.token', token)
  savePrefs()

  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        month: monthInput.value,
        threshold: Number(thresholdInput.value),
        postedOnly: postedInput.checked,
        token,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || 'Не удалось собрать отчёт')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let gotResult = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'progress') {
          const ratio = event.total ? Math.min(1, event.loaded / event.total) : 0.2
          setProgress(event.message, Math.max(ratio, 0.08))
        } else if (event.type === 'error') {
          throw new Error(event.message)
        } else if (event.type === 'result') {
          gotResult = true
          showReport(event.report, { preview: false, elapsedMs: event.elapsedMs })
          loadYearChart()
        }
      }
    }
    if (!gotResult) throw new Error('Сбор прервался. Нажмите «Собрать» ещё раз.')
  } catch (error) {
    if (error.name === 'AbortError') {
      setProgress('Остановлено', 0)
      return
    }
    progressBox.hidden = true
    showError(error.message || 'Не удалось собрать отчёт')
  } finally {
    setBusy(false)
  }
}

function setBusy(busy) {
  collecting = busy
  submitButton.disabled = busy
  orderSubmit.disabled = busy
  orderLinkInput.disabled = busy
  agentSubmit.disabled = busy
  agentNameInput.disabled = busy
  stopButton.disabled = !busy
  if (busy) progressBox.hidden = false
}

function setProgress(text, ratio) {
  progressBox.hidden = false
  progressText.textContent = text
  bar.style.width = `${Math.round(ratio * 100)}%`
}

function showError(message) {
  errorBox.hidden = false
  errorText.textContent = message
}

function hideError() {
  errorBox.hidden = true
  errorText.textContent = ''
}

async function runOrderCheck() {
  const link = orderLinkInput.value.trim()
  if (!link) {
    showError('Вставьте ссылку на заказ')
    orderLinkInput.focus()
    return
  }
  savedRequest += 1
  controller?.abort()
  controller = new AbortController()
  setBusy(true)
  hideError()
  setProgress('Открываю заказ…', 0.08)
  const token = tokenInput.value.trim()
  if (token) localStorage.setItem('moysklad.token', token)
  savePrefs()

  try {
    const response = await fetch('/api/order-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        link,
        threshold: Number(thresholdInput.value),
        postedOnly: postedInput.checked,
        token,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || 'Не удалось проверить заказ')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let gotResult = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'progress') {
          const ratio = event.total ? Math.min(1, event.loaded / event.total) : 0.2
          setProgress(event.message, Math.max(ratio, 0.08))
        } else if (event.type === 'error') {
          throw new Error(event.message)
        } else if (event.type === 'result') {
          gotResult = true
          showOrderCheck(event.check)
        }
      }
    }
    if (!gotResult) throw new Error('Проверка прервалась. Нажмите «Проверить» ещё раз.')
  } catch (error) {
    if (error.name === 'AbortError') {
      setProgress('Остановлено', 0)
      return
    }
    progressBox.hidden = true
    showError(error.message || 'Не удалось проверить заказ')
  } finally {
    setBusy(false)
  }
}

async function runAgentDynamics(agentId) {
  const name = agentNameInput.value.trim()
  if (!agentId && name.length < 2) {
    showError(name ? 'Введите хотя бы две буквы наименования' : 'Введите наименование')
    agentNameInput.focus()
    return
  }
  savedRequest += 1
  controller?.abort()
  controller = new AbortController()
  setBusy(true)
  hideError()
  agentChart.hidden = true
  setProgress('Ищу оптовика…', 0.08)
  const token = tokenInput.value.trim()
  if (token) localStorage.setItem('moysklad.token', token)
  savePrefs()

  try {
    const response = await fetch('/api/agent-dynamics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        agentId: agentId || undefined,
        year: chartYear(),
        threshold: Number(thresholdInput.value),
        postedOnly: postedInput.checked,
        token,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || 'Не удалось построить динамику')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let gotResult = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'progress') {
          const ratio = event.total ? Math.min(1, event.loaded / event.total) : 0.2
          setProgress(event.message, Math.max(ratio, 0.08))
        } else if (event.type === 'error') {
          throw new Error(event.message)
        } else if (event.type === 'result') {
          gotResult = true
          showAgentDynamics(event.dynamics)
        }
      }
    }
    if (!gotResult) throw new Error('Сбор прервался. Нажмите «Показать» ещё раз.')
  } catch (error) {
    if (error.name === 'AbortError') {
      setProgress('Остановлено', 0)
      return
    }
    progressBox.hidden = true
    showError(error.message || 'Не удалось построить динамику')
  } finally {
    setBusy(false)
  }
}

function showAgentDynamics(dynamics) {
  progressBox.hidden = true
  clientDynamics = dynamics?.status === 'one' ? dynamics : null
  agentChart.hidden = false
  agentPdfButton.hidden = dynamics?.status !== 'one'
  agentToggles.replaceChildren()
  agentMatches.replaceChildren()
  agentPlot.replaceChildren()
  agentPlot.hidden = true
  agentEmpty.hidden = true
  if (dynamics?.status === 'many') {
    const shown = dynamics.matches.slice(0, 20)
    agentTitle.textContent = 'Выберите клиента'
    agentHintText(dynamics.matches.length > shown.length
      ? `Найдено ${dynamics.matches.length}. Показаны первые 20, уточните наименование.`
      : `Найдено ${dynamics.matches.length}.`)
    agentMatches.hidden = false
    for (const match of shown) {
      agentMatches.append(h('button', {
        type: 'button',
        class: 'chip',
        onclick: () => runAgentDynamics(match.id),
      }, match.archived ? `${match.name} · архив` : match.name))
    }
  } else if (dynamics?.status === 'none') {
    agentTitle.textContent = 'Клиент'
    agentHintText('Поиск по наименованию среди оптовиков.')
    agentMatches.hidden = true
    agentEmpty.hidden = false
    agentEmpty.textContent = 'Такого оптовика нет.'
  } else {
    agentMatches.hidden = true
    agentTitle.textContent = dynamics?.agent?.name || 'Клиент'
    renderClientChart()
  }
  agentChart.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function agentHintText(text) {
  const hint = document.querySelector('#agent-hint')
  if (hint) hint.textContent = text
}

function renderClientChart() {
  if (!clientDynamics) return
  const year = clientDynamics.year
  const rows = clientDynamics.months || []
  const byMonth = new Map(rows.map((row) => [row.month, row]))
  const points = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`
    const row = byMonth.get(month)
    if (!row) return null
    return {
      month,
      sales: finiteChart(row.sales),
      profit: finiteChart(row.profit),
      netProfit: finiteChart(row.netProfit),
      missed: finiteChart(row.missed),
      markup: finiteChart(row.averageMarkup),
    }
  })
  agentToggles.replaceChildren(...CLIENT_SERIES.map((series) => {
    const on = seriesOn(series.id)
    const button = h('button', {
      type: 'button',
      class: on ? 'year-toggle is-on' : 'year-toggle',
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => setSeries(series.id, !on),
    })
    const swatch = h('i')
    swatch.style.setProperty('--swatch', series.color)
    button.append(swatch, series.label)
    return button
  }))
  const saved = points.some(Boolean)
  const selected = CLIENT_SERIES.filter((series) => seriesOn(series.id))
  const active = selected.filter((series) => points.some((point) => point && point[series.key] != null))
  agentPlot.replaceChildren()
  if (!saved || active.length === 0) {
    agentPlot.hidden = true
    agentEmpty.hidden = false
    agentHintText('Деньги на одной шкале, наценка — на правой')
    agentEmpty.textContent = !saved
      ? `За ${year} год отгрузок и продаж нет.`
      : selected.length === 0
        ? 'Выберите показатель.'
        : 'Для выбранных показателей нет чисел.'
    return
  }
  const moneyOn = active.some((series) => series.unit === 'money')
  const percentOn = active.some((series) => series.unit === 'percent')
  agentHintText(moneyOn && percentOn
    ? `${year}. Деньги на одной шкале, наценка — на правой`
    : percentOn
      ? `${year}. Средняя наценка за месяц`
      : `${year}. Суммы за месяц`)
  agentPlot.hidden = false
  agentEmpty.hidden = true
  agentPlot.append(yearChartSvg(points, active, { tipId: 'agent-tip', labels: true }), yearTip('agent-tip'))
}

async function downloadAgentPdf() {
  if (!clientDynamics?.agent) return
  const series = CLIENT_SERIES.filter((item) => seriesOn(item.id)).map((item) => item.id)
  if (!series.length) {
    showError('Выберите показатель.')
    return
  }
  agentPdfButton.disabled = true
  hideError()
  try {
    const response = await fetch('/api/agent-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: clientDynamics.agent.name,
        year: clientDynamics.year,
        months: clientDynamics.months || [],
        documents: clientDynamics.documents || [],
        series,
        threshold: Number(thresholdInput.value),
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || 'Не удалось собрать PDF')
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeName = String(clientDynamics.agent.name || 'клиент').replace(/[\\/:*?"<>|]+/g, ' ').trim()
    link.href = url
    link.download = `продажи-${safeName}-${clientDynamics.year}.pdf`
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    showError(error.message || 'Не удалось собрать PDF')
  } finally {
    agentPdfButton.disabled = false
  }
}

function showOrderCheck(check) {
  progressBox.hidden = true
  const accountName = check.account?.name
  if (accountName) {
    document.querySelector('#account-name').textContent = accountName
    document.querySelector('#account-role').textContent = check.account.uid || ''
  }
  const threshold = check.threshold
  const verdict = renderVerdict(check)
  const notes = []
  if (check.note) notes.push(note(check.note, 'info'))
  if (check.stats.noCost) notes.push(note(`Без закупочной цены: ${check.stats.noCost}. В порог не входят.`, 'warning'))
  if (check.auditNote) notes.push(note(check.auditNote, 'warning'))
  const body = h('div', { class: 'stack' })
  if (check.order) body.append(orderCard(check.order, threshold, { open: true, showAll: true }))
  else if (check.shipment) body.append(shipmentBlock(check.shipment, threshold, { showAll: true }))
  else body.append(note('По этой ссылке нечего показать.', 'warning'))
  orderCheck.replaceChildren(verdict, ...notes, body)
  orderCheck.hidden = false
  orderCheck.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function checkShipments(check) {
  if (check.order?.shipments?.length) return check.order.shipments
  if (check.shipment) return [check.shipment]
  return []
}

function lowLinesOf(check) {
  const lines = []
  for (const shipment of checkShipments(check)) {
    for (const line of shipment.positions || []) {
      if (line.low && !line.excluded) lines.push(line)
    }
  }
  return lines
}

function renderVerdict(check) {
  const threshold = check.threshold
  const markup = check.stats?.averageMarkup
  const lowLines = lowLinesOf(check)
  const positions = check.stats?.positions || 0
  let tone = 'ok'
  let title = 'В пороге'
  const reasons = []
  if (!positions) {
    tone = 'unknown'
    title = 'Нечего сверить'
    reasons.push('Позиций нет.')
  } else if (lowLines.length) {
    tone = 'bad'
    title = 'Ниже порога'
    if (markup != null) reasons.push(`Наценка ${formatMarkup(markup)} при пороге ${formatPercent(threshold)}.`)
    reasons.push(`${lowLines.length} из ${positions} поз. ниже порога.`)
    if (check.stats?.missed) reasons.push(`Упущено ${formatMoney(check.stats.missed)}.`)
    for (const line of lowLines.slice(0, 6)) {
      const cut = line.priceCut?.by ? `, снизил ${line.priceCut.by}` : ''
      reasons.push(`${line.name} — ${formatMarkup(line.markup)}${cut}`)
    }
    if (lowLines.length > 6) reasons.push(`Ещё ${lowLines.length - 6} поз. ниже порога.`)
  } else if (markup == null) {
    tone = 'unknown'
    title = 'Нет данных'
    reasons.push('Закупка неизвестна, с порогом сравнить нельзя.')
  } else {
    reasons.push(`Наценка ${formatMarkup(markup)}. Порог ${formatPercent(threshold)}.`)
  }
  const box = h('div', { class: `verdict is-${tone}` })
  box.append(verdictMark(tone), verdictText(title, reasons))
  return box
}

function verdictText(title, reasons) {
  const text = h('div', { class: 'verdict-text' })
  text.append(h('b', {}, title))
  if (reasons.length) {
    const list = h('ul')
    for (const reason of reasons) list.append(h('li', {}, reason))
    text.append(list)
  }
  return text
}

function verdictMark(tone) {
  const mark = h('span', { class: 'verdict-icon', 'aria-hidden': 'true' })
  const path = tone === 'ok'
    ? '<path d="M6 12.4 10.2 16.5 18 7.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    : tone === 'bad'
      ? '<path d="M8 8 16 16 M16 8 8 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
      : '<path d="M12 7.2 v6.2 M12 16.8 v.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'
  mark.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`
  return mark
}

function showReport(report, meta) {
  current = { report, meta }
  progressBox.hidden = true
  results.hidden = false
  const accountName = report.account?.name
  if (accountName) {
    document.querySelector('#account-name').textContent = accountName
    document.querySelector('#account-role').textContent = report.account.uid || ''
  }
  render()
  if (meta.scroll !== false) results.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function render() {
  if (!current) return
  const { report, meta } = current
  const threshold = report.threshold
  const missedCount = report.stats.missedPositions ?? 0
  const monthMarkup = report.stats.averageMarkup
  statsBox.replaceChildren(
    metric(report.stats.wholesalers, 'Контрагенты'),
    metric(report.stats.shipments, 'Документы'),
    metric(report.stats.lowShipments, `Ниже ${formatPercent(threshold)}`, 'bad'),
    metric(report.stats.orders, 'Заказы'),
    metric(
      monthMarkup == null ? '—' : formatPercent(monthMarkup),
      'Наценка',
      monthMarkup == null ? '' : monthMarkup < threshold ? 'bad' : 'ok',
      'за месяц',
    ),
    metric(formatMoney(report.stats.missed ?? 0), 'Упущено', 'warn', missedCount ? `${missedCount} поз.` : ''),
  )
  renderShare(report)

  suggestionsBox.replaceChildren()
  if (meta.saved && meta.savedAt) {
    suggestionsBox.append(note(
      `Последняя проверка ${formatSavedAt(meta.savedAt)} · ${report.group} · порог ${formatPercent(report.threshold)}`,
      'info',
    ))
  }
  const notice = emptyNote(report)
  if (notice) suggestionsBox.append(notice)
  if (report.suggestions?.length) {
    const chips = h('div', { class: 'chip-row' })
    for (const tag of report.suggestions) {
      chips.append(h('span', { class: 'chip' }, `${tag.name} · ${tag.count}`))
    }
    suggestionsBox.append(chips)
  }
  if (report.stats.noCost) {
    suggestionsBox.append(note(`Без закупочной цены: ${report.stats.noCost}. В порог не входят.`, 'warning'))
  }
  if (report.auditNote) suggestionsBox.append(note(report.auditNote, 'warning'))

  document.querySelector('#toolbar').hidden = report.orders.length === 0 && report.unlinked.length === 0
  document.querySelector('#copy-orders').disabled = report.orders.length === 0 && report.unlinked.length === 0
  document.querySelector('#copy-manual').disabled = !hasManualCut(report)
  document.querySelector('#copy-fallback').hidden = true
  const orders = sortRows(filterRows(report.orders))
    .map((order) => ({ ...order, shipments: visibleShipments(order.shipments) }))
    .filter((order) => order.shipments.length)
  renderJump(orders)
  ordersBox.replaceChildren(...orders.map((order) => orderCard(order, threshold)))
  if (!orders.length && !report.emptyReason) {
    ordersBox.append(note('По этому поиску заказов нет.', 'info'))
  }

  const unlinked = sortShipments(visibleShipments(filterShipments(report.unlinked)))
  unlinkedBox.replaceChildren()
  if (unlinked.length) {
    unlinkedBox.append(h('h2', { class: 'section-title' }, 'Без заказа'))
    unlinkedBox.append(...unlinked.map((shipment) => shipmentBlock(shipment, threshold)))
  }
}

function renderShare(report) {
  const counts = shareCounts(report.stats)
  const total = counts.ok + counts.low + counts.unknown
  if (!total) {
    shareBox.hidden = true
    shareBox.replaceChildren()
    return
  }
  const okRatio = counts.ok / total
  const lowRatio = counts.low / total
  const parts = [
    { value: counts.ok, color: '#2f9e57' },
    { value: counts.low, color: '#e15b64' },
    { value: counts.unknown, color: '#d5d8de' },
  ]
  const universe = universeLabel(counts.demand, counts.sale)
  shareBox.hidden = false
  shareBox.replaceChildren()
  shareBox.setAttribute('role', 'img')
  shareBox.setAttribute('aria-label', `Удачные ${universe}: ${formatShare(okRatio * 100)}. Ниже порога: ${formatShare(lowRatio * 100)}.`)

  const donut = h('div', { class: 'share-donut' })
  donut.append(donutSvg(parts))
  const center = h('div', { class: 'share-center' })
  center.append(h('b', {}, formatShare(okRatio * 100)), h('span', {}, `${counts.ok} из ${total}`))
  donut.append(center)

  const figures = h('div', { class: 'share-figures' })
  figures.append(shareItem('is-ok', 'Удачные', universe, counts.ok, total))
  figures.append(shareItem('is-low', 'Ниже порога', `${counts.low} из ${total}`, counts.low, total))
  if (counts.unknown) {
    figures.append(shareItem('is-unknown', 'Без наценки', `${counts.unknown} из ${total}`, counts.unknown, total))
  }
  const kinds = h('div', { class: 'kind-list' })
  const demandLine = kindLine('Отгрузки', counts.demand)
  const saleLine = kindLine('Продажи', counts.sale)
  if (demandLine) kinds.append(demandLine)
  if (saleLine) kinds.append(saleLine)

  shareBox.append(donut, figures)
  if (kinds.childElementCount) shareBox.append(kinds)
}

function shareCounts(stats) {
  const share = stats?.share
  if (share?.demand && share?.retaildemand) {
    const bucket = (name) => (share.demand[name] || 0) + (share.retaildemand[name] || 0)
    return {
      ok: bucket('ok'),
      low: bucket('low'),
      unknown: bucket('unknown'),
      demand: share.demand,
      sale: share.retaildemand,
    }
  }
  const total = stats?.shipments || 0
  const low = stats?.lowShipments || 0
  const unknown = Math.min(stats?.noCost || 0, Math.max(0, total - low))
  return {
    ok: Math.max(0, total - low - unknown),
    low,
    unknown,
    demand: { ok: 0, low: 0, unknown: 0 },
    sale: { ok: 0, low: 0, unknown: 0 },
  }
}

function universeLabel(demand, sale) {
  const demandTotal = (demand?.ok || 0) + (demand?.low || 0) + (demand?.unknown || 0)
  const saleTotal = (sale?.ok || 0) + (sale?.low || 0) + (sale?.unknown || 0)
  if (demandTotal && saleTotal) return 'отгрузки и продажи'
  if (saleTotal) return 'продажи'
  return 'отгрузки'
}

function shareItem(tone, title, caption, count, total) {
  const item = h('div', { class: 'share-item' })
  item.append(h('i', { class: `swatch ${tone}` }))
  const text = h('div', { class: 'share-copy' })
  text.append(h('span', {}, title), h('small', {}, caption))
  item.append(text, h('b', {}, formatShare(total ? (count / total) * 100 : 0)))
  return item
}

function kindLine(label, bucket) {
  const ok = bucket?.ok || 0
  const low = bucket?.low || 0
  const unknown = bucket?.unknown || 0
  const total = ok + low + unknown
  if (!total) return null
  const row = h('div', { class: 'kind-row' })
  const bar = h('div', { class: 'kind-bar', 'aria-hidden': 'true' })
  if (ok) bar.append(h('i', { class: 'ok', style: `width:${(ok / total) * 100}%` }))
  if (low) bar.append(h('i', { class: 'low', style: `width:${(low / total) * 100}%` }))
  if (unknown) bar.append(h('i', { class: 'unknown', style: `width:${(unknown / total) * 100}%` }))
  row.append(h('span', {}, label), bar, h('b', {}, `${low} ниже`))
  return row
}

function donutSvg(parts) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 120 120')
  svg.setAttribute('aria-hidden', 'true')
  svg.append(donutCircle('#eef0f3'))
  const radius = 46
  const length = 2 * Math.PI * radius
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const active = parts.filter((part) => part.value > 0)
  const gap = active.length > 1 ? 20 : 0
  let cursor = 0
  for (const part of parts) {
    const slice = total ? (part.value / total) * length : 0
    if (slice <= 0) continue
    const draw = slice > gap * 1.8 ? slice - gap : slice
    const arc = donutCircle(part.color)
    arc.setAttribute('stroke-dasharray', `${draw} ${length - draw}`)
    arc.setAttribute('stroke-dashoffset', String(-cursor))
    arc.setAttribute('transform', 'rotate(-90 60 60)')
    svg.append(arc)
    cursor += slice
  }
  return svg
}

function donutCircle(color) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  node.setAttribute('cx', '60')
  node.setAttribute('cy', '60')
  node.setAttribute('r', '46')
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', color)
  node.setAttribute('stroke-width', '14')
  node.setAttribute('stroke-linecap', 'round')
  return node
}

function formatShare(value) {
  const rounded = Math.round(value * 10) / 10
  const digits = Math.abs(rounded - Math.round(rounded)) < 0.05 ? 0 : 1
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded)}%`
}

function emptyNote(report) {
  if (report.emptyReason === 'group') {
    return note(`Группа «${report.group}» не найдена. Это метка контрагента.`, 'warning')
  }
  if (report.emptyReason === 'shipments') {
    return note(`За ${report.periodLabel} отгрузок и продаж нет.`, 'info')
  }
  if (report.emptyReason === 'threshold') {
    return note(`Ниже ${formatPercent(report.threshold)} отгрузок и продаж нет.`, 'info')
  }
  return null
}

async function loadSavedReport(month) {
  if (!month || collecting) return
  const request = ++savedRequest
  let response
  try {
    response = await fetch(`/api/reports/${encodeURIComponent(month)}`)
  } catch {
    return
  }
  if (request !== savedRequest || collecting) return
  if (!response.ok) {
    if (current && current.report?.month !== month) {
      current = null
      results.hidden = true
    }
    return
  }
  const body = await response.json()
  if (request !== savedRequest || collecting || body.report?.month !== month) return
  if (body.report.threshold != null) thresholdInput.value = body.report.threshold
  if (typeof body.report.postedOnly === 'boolean') postedInput.checked = body.report.postedOnly
  savePrefs()
  showReport(body.report, { saved: true, savedAt: body.savedAt, scroll: false })
  if (request !== savedRequest || !body.report.auditNote?.includes('не разобрано')) return
  const refreshKey = `moysklad.priceCutRefresh.3.${month}`
  if (sessionStorage.getItem(refreshKey) === 'done') return
  const token = localStorage.getItem('moysklad.token') || ''
  if (!token) return
  sessionStorage.setItem(refreshKey, 'done')
  setBusy(true)
  setProgress('История цен…', 0.35)
  try {
    const refreshed = await fetch('/api/reports/price-cuts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, month }),
    })
    const payload = await refreshed.json().catch(() => ({}))
    if (!refreshed.ok) throw new Error(payload.message || 'Не удалось прочитать историю цен')
  } catch (error) {
    progressBox.hidden = true
    showError(error.message || 'Не удалось прочитать историю цен')
    return
  } finally {
    setBusy(false)
  }
  if (request === savedRequest) await loadSavedReport(month)
}

function formatSavedAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('moysklad.filters')) || {}
  } catch {
    return {}
  }
}

function savePrefs() {
  localStorage.setItem('moysklad.filters', JSON.stringify({
    month: monthInput.value,
    threshold: thresholdInput.value,
    postedOnly: postedInput.checked,
    onlyLow: onlyLowInput.checked,
  }))
}

function setDetails(open) {
  document.querySelectorAll('#orders details, #unlinked details').forEach((node) => {
    node.open = open
  })
}

function renderJump(orders) {
  const jump = document.querySelector('#jump')
  jump.hidden = orders.length < 2 || orders.length > 8
  jump.replaceChildren(...orders.map((order) => h('button', {
    class: 'chip',
    type: 'button',
    onclick: () => document.getElementById(`order-${order.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }, `${order.agent?.name || order.name} · ${formatMarkup(order.lowestMarkup)}`)))
}

function visibleShipments(shipments) {
  const query = searchInput.value.trim().toLocaleLowerCase('ru')
  return shipments.filter((shipment) => {
    if (query && shipmentBlob(shipment).includes(query)) return true
    if (!onlyLowInput.checked) return true
    return shipment.low || shipment.positions.some((line) => line.low)
  })
}

function visibleLines(shipment) {
  const query = searchInput.value.trim().toLocaleLowerCase('ru')
  const positions = shipment.positions || []
  if (query) {
    const matched = positions.filter((line) => `${line.name} ${line.article}`.toLocaleLowerCase('ru').includes(query))
    if (matched.length) return matched
  }
  if (onlyLowInput.checked) {
    const low = positions.filter((line) => line.low || line.excluded)
    if (low.length) return low
  }
  return positions
}

function orderLink(order) {
  if (order.href) return order.href
  if (!order.id) return null
  return `https://online.moysklad.ru/app/#customerorder/edit?id=${encodeURIComponent(order.id)}`
}

function documentKindLabel(shipment) {
  if (shipment?.kind === 'retaildemand') return 'Продажа'
  if (shipment?.kind === 'customerorder') return 'Позиции заказа'
  return 'Отгрузка'
}

function shipmentLink(shipment) {
  if (shipment.href) return shipment.href
  if (!shipment.id) return null
  const type = shipment.kind === 'retaildemand' ? 'retaildemand' : shipment.kind === 'customerorder' ? 'customerorder' : 'demand'
  return `https://online.moysklad.ru/app/#${type}/edit?id=${encodeURIComponent(shipment.id)}`
}

function copyBlocks() {
  const report = current?.report
  if (!report) return []
  const blocks = []
  for (const order of sortRows([...(report.orders || [])])) {
    for (const shipment of order.shipments) {
      const block = shipmentCopy(order.agent?.name || shipment.agent?.name, shipment)
      if (block) blocks.push(block)
    }
  }
  for (const shipment of sortShipments([...(report.unlinked || [])])) {
    const block = shipmentCopy(shipment.agent?.name, shipment)
    if (block) blocks.push(block)
  }
  return blocks
}

function shipmentCopy(agentName, shipment) {
  const positions = shipment.positions || []
  const low = positions.filter((line) => line.low && !line.excluded)
  if (!low.length) return null
  const products = low.map((line) => (
    line.article ? `${line.name}, ${line.article}` : line.name
  )).filter(Boolean)
  return [
    agentName || 'Контрагент',
    `${documentKindLabel(shipment)}: ${shipmentLink(shipment) || shipment.name || 'нет ссылки'}`,
    'Товары:',
    ...products,
  ].join('\n')
}

function changedLines(positions) {
  const lines = []
  const seen = new Set()
  for (const line of positions || []) {
    if (!line.priceCut) continue
    const label = line.article ? `${line.name}, ${line.article}` : line.name
    if (!label || seen.has(label)) continue
    seen.add(label)
    lines.push(label)
  }
  return lines
}

function hasManualCut(report) {
  const orders = report?.orders || []
  const unlinked = report?.unlinked || []
  return orders.some((order) => order.priceCut) || unlinked.some((shipment) => shipment.priceCut)
}

function manualBlocks() {
  const report = current?.report
  if (!report) return []
  const blocks = []
  for (const order of sortRows([...(report.orders || [])])) {
    const lines = changedLines((order.shipments || []).flatMap((shipment) => shipment.positions || []))
    if (!lines.length) continue
    blocks.push([
      order.agent?.name || 'Контрагент',
      `Заказ: ${orderLink(order) || order.name || 'нет ссылки'}`,
      'Товары:',
      ...lines,
    ].join('\n'))
  }
  for (const shipment of sortShipments([...(report.unlinked || [])])) {
    const lines = changedLines(shipment.positions)
    if (!lines.length) continue
    blocks.push([
      shipment.agent?.name || 'Контрагент',
      `${documentKindLabel(shipment)}: ${shipmentLink(shipment) || shipment.name || 'нет ссылки'}`,
      'Товары:',
      ...lines,
    ].join('\n'))
  }
  return blocks
}

async function copyOrderLinks() {
  await copyBlocksTo(document.querySelector('#copy-orders'), copyBlocks())
}

async function copyManualLinks() {
  await copyBlocksTo(document.querySelector('#copy-manual'), manualBlocks())
}

async function copyBlocksTo(button, blocks) {
  if (!blocks.length) {
    flashButton(button, 'Нет ссылок')
    return
  }
  const text = blocks.join('\n\n')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    if (!copyWithCommand(text)) {
      showCopyFallback(text)
      flashButton(button, 'Выделил ссылки')
      return
    }
  }
  document.querySelector('#copy-fallback').hidden = true
  flashButton(button, `Скопировано: ${blocks.length}`)
}

function copyWithCommand(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.append(area)
  area.focus()
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}

function showCopyFallback(text) {
  const box = document.querySelector('#copy-fallback')
  const area = document.querySelector('#copy-text')
  box.hidden = false
  area.value = text
  area.rows = Math.min(12, Math.max(3, text.split('\n').length))
  area.focus()
  area.select()
}

function flashButton(button, text) {
  window.clearTimeout(button.flashTimer)
  if (!button.dataset.label) button.dataset.label = button.textContent
  button.textContent = text
  button.flashTimer = window.setTimeout(() => {
    button.textContent = button.dataset.label
  }, 1600)
}

function orderCard(order, threshold, options = {}) {
  const lowCount = order.shipments.filter((shipment) => shipment.low).length
  const tone = lowCount === order.shipments.length ? 'is-low' : lowCount ? 'is-mixed' : 'is-ok'
  const card = h('details', { class: `row-card ${tone}`, id: `${options.showAll ? 'check' : 'order'}-${order.id}` })
  card.open = Boolean(options.open) || searchInput.value.trim().length > 0
  const summary = h('summary', { class: 'row-summary' })
  const main = h('div', { class: 'row-main' })
  main.append(
    h('div', { class: 'row-title' }, order.agent?.name || 'Контрагент'),
    h('div', { class: 'row-meta' }, `Заказ ${order.name} · ${formatMoment(order.moment)}`),
  )
  const pills = h('div', { class: 'pills' })
  pills.append(pill(formatMarkup(order.lowestMarkup), markupTone(order.lowestMarkup, threshold)))
  if (order.priceCut) pills.append(pill('снизили цену', 'cut', priceCutTitle(order.shipments.flatMap((shipment) => shipment.positions))))
  pills.append(pill(`${lowCount} из ${order.shipments.length}`, lowCount ? 'bad' : 'ok'))
  pills.append(pill(formatMoney(order.saleExVat ?? order.sum), 'muted'))
  const href = orderLink(order)
  if (href) pills.append(quietLink(href, 'Открыть'))
  summary.append(main, pills, h('span', { class: 'chevron', 'aria-hidden': 'true' }))
  const body = h('div', { class: 'row-body' })
  body.append(...order.shipments.map((shipment) => shipmentBlock(shipment, threshold, options)))
  card.append(summary, body)
  return card
}

function shipmentBlock(shipment, threshold, options = {}) {
  const block = h('div', { class: shipment.low ? 'ship is-low' : 'ship is-ok' })
  const head = h('div', { class: 'ship-head' })
  const main = h('div', { class: 'row-main' })
  const meta = [formatMoment(shipment.moment), shipment.applicable ? '' : 'не проведена', shipment.agent?.name]
    .filter(Boolean)
    .join(' · ')
  main.append(
    h('div', { class: 'row-title' }, `${documentKindLabel(shipment)} ${shipment.name}`),
    h('div', { class: 'row-meta' }, meta),
  )
  const pills = h('div', { class: 'pills' })
  pills.append(labeledPill('сумма', formatMoney(shipment.saleExVat)))
  if (shipment.cost != null) pills.append(labeledPill('себест.', formatMoney(shipment.cost)))
  pills.append(pill(formatMarkup(shipment.markup), markupTone(shipment.markup, threshold), costCaption(shipment)))
  if (shipment.priceCut) pills.append(pill('снизили цену', 'cut', priceCutTitle(shipment.positions)))
  if (shipment.href) pills.append(quietLink(shipment.href, 'Открыть'))
  head.append(main, pills)
  const lines = options.showAll ? (shipment.positions || []) : visibleLines(shipment)
  const positions = h('details', { class: 'positions' })
  const lowPositions = shipment.lowPositions ?? shipment.positions.filter((line) => line.low).length
  const shown = `Позиции · ${lowPositions} ниже порога из ${shipment.positions.length}`
  positions.open = Boolean(options.showAll) || Boolean(shipment.low) || searchInput.value.trim().length > 0
  positions.append(h('summary', {}, shown))
  positions.append(positionTable(lines, threshold))
  block.append(head, positions)
  return block
}

function positionTable(lines) {
  const wrap = h('div', { class: 'table-wrap' })
  const table = h('table', { class: 'lines' })
  const head = h('tr')
  for (const label of ['Товар', 'Кол-во', 'Цена', 'Сумма', 'Закупка', 'Себестоимость', 'Наценка']) {
    head.append(h('th', { class: label === 'Товар' ? '' : 'num' }, label))
  }
  table.append(h('thead', {}, head))
  const body = h('tbody')
  for (const line of lines) {
    const row = h('tr', { class: line.excluded ? 'is-exception' : line.markup != null && line.markup < 0 ? 'is-bad' : line.low ? 'is-low' : 'is-ok' })
    const product = h('td', { class: 'product' })
    const title = h('div', { class: 'product-title' })
    title.append(h('span', { class: 'cell-strong' }, line.name))
    if (line.excluded) title.append(h('span', { class: 'badge-exception' }, 'исключение'))
    if (line.priceCut) title.append(h('span', { class: 'badge-cut', title: cutTitle(line.priceCut) }, 'снизили'))
    product.append(title)
    if (line.article) product.append(h('div', { class: 'article' }, line.article))
    row.append(product)
    const quantity = line.packQuantity
      ? `${formatQty(line.quantity)} уп. × ${formatQty(line.packQuantity)}`
      : formatQty(line.quantity)
    row.append(h('td', { class: 'num' }, quantity))
    row.append(h('td', { class: 'num' }, formatAmount(line.price)))
    row.append(h('td', { class: 'num' }, formatAmount(line.sale)))
    row.append(h('td', { class: 'num' }, line.costKnown ? formatAmount(line.buy) : 'нет данных'))
    row.append(h('td', { class: 'num' }, line.costKnown ? formatAmount(line.cost) : 'нет данных'))
    row.append(h('td', { class: 'num cell-strong' }, formatMarkup(line.markup)))
    body.append(row)
  }
  table.append(body)
  wrap.append(table)
  return wrap
}

function metric(value, label, tone = '', extra = '') {
  const node = h('div', { class: tone ? `metric is-${tone}` : 'metric' })
  node.append(h('span', {}, label), h('b', {}, String(value ?? 0)))
  if (extra) node.append(h('small', {}, extra))
  return node
}

function cutTitle(cut) {
  const bits = [cut.by, cut.moment ? formatMoment(cut.moment) : '']
  if (cut.oldPrice != null && cut.newPrice != null && cut.oldPrice !== cut.newPrice) {
    bits.push(`${formatAmount(cut.oldPrice)} → ${formatAmount(cut.newPrice)}`)
  } else if (cut.oldDiscount != null && cut.newDiscount != null && cut.oldDiscount !== cut.newDiscount) {
    bits.push(`скидка ${formatQty(cut.oldDiscount)}% → ${formatQty(cut.newDiscount)}%`)
  }
  return bits.filter(Boolean).join(' · ')
}

function priceCutTitle(lines) {
  return (lines || []).filter((line) => line.priceCut).map((line) => `${line.name}: ${cutTitle(line.priceCut)}`).join('\n')
}

function pill(text, tone = 'muted', title = '') {
  return h('span', { class: tone === 'muted' ? 'pill' : `pill is-${tone}`, title: title || null }, text)
}

function labeledPill(label, value) {
  const node = h('span', { class: 'pill' })
  node.append(h('i', {}, label), value)
  return node
}

function quietLink(href, text) {
  const link = h('a', { class: 'pill link', href, target: '_blank', rel: 'noreferrer' }, text)
  link.addEventListener('click', (event) => event.stopPropagation())
  return link
}

function markupTone(value, threshold) {
  if (value == null || !Number.isFinite(value)) return 'na'
  if (value < 0 || value < threshold) return 'bad'
  return 'ok'
}

function costCaption(shipment) {
  if (shipment.costStatus === 'none' || shipment.costStatus === 'zero') return 'нет закупки'
  if (shipment.costStatus === 'partial') return 'закупка не у всех'
  return shipment.low ? 'ниже порога' : 'норма'
}

function note(text, variant = '') {
  return h('div', { class: variant ? `notice notice-${variant}` : 'notice' }, text)
}

function filterRows(orders) {
  const query = searchInput.value.trim().toLocaleLowerCase('ru')
  if (!query) return orders
  return orders.filter((order) => blob(order).includes(query))
}

function filterShipments(shipments) {
  const query = searchInput.value.trim().toLocaleLowerCase('ru')
  if (!query) return shipments
  return shipments.filter((shipment) => shipmentBlob(shipment).includes(query))
}

function blob(order) {
  return [order.agent?.name, order.name, ...order.shipments.flatMap((shipment) => shipmentBlob(shipment).split(' '))].join(' ').toLocaleLowerCase('ru')
}

function shipmentBlob(shipment) {
  return [shipment.name, shipment.agent?.name, ...shipment.positions.flatMap((line) => [line.name, line.article])].join(' ').toLocaleLowerCase('ru')
}

function sortRows(orders) {
  const copy = [...orders]
  const mode = sortInput.value
  copy.sort((a, b) => {
    if (mode === 'agent') return (a.agent?.name || '').localeCompare(b.agent?.name || '', 'ru')
    if (mode === 'date') return momentValue(a) - momentValue(b)
    return (a.lowestMarkup ?? 9999) - (b.lowestMarkup ?? 9999)
  })
  return copy
}

function sortShipments(shipments) {
  const copy = [...shipments]
  copy.sort((a, b) => {
    if (sortInput.value === 'date') return String(a.moment).localeCompare(String(b.moment))
    if (sortInput.value === 'agent') return (a.agent?.name || '').localeCompare(b.agent?.name || '', 'ru')
    return (a.markup ?? 9999) - (b.markup ?? 9999)
  })
  return copy
}

function momentValue(order) {
  const moments = order.shipments.map((shipment) => shipment.moment).filter(Boolean).sort()
  return moments.length ? Date.parse(moments[0].replace(' ', 'T')) : 0
}

function formatMoney(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  return money.format(value)
}

function formatAmount(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  return amount.format(value)
}

function formatMarkup(value) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${percent.format(value)} %`
}

function formatPercent(value) {
  return `${percent.format(value)} %`
}

function formatQty(value) {
  return qtyFormat.format(value ?? 0)
}

function formatMoment(value) {
  if (!value) return 'без даты'
  const [date, time = ''] = value.split(' ')
  const [year, month, day] = date.split('-')
  return `${day}.${month}.${year}${time ? ` ${time.slice(0, 5)}` : ''}`
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'onclick') node.addEventListener('click', value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

const YEAR_SERIES = [
  { id: 'sales', key: 'sales', label: 'Продажи', unit: 'money', color: '#1c1f26' },
  { id: 'markup', key: 'markup', label: 'Наценка', unit: 'percent', color: '#2f9e57' },
  { id: 'profit', key: 'profit', label: 'Прибыль', unit: 'money', color: '#b7791f' },
  { id: 'missed', key: 'missed', label: 'Упущено', unit: 'money', color: '#d64545' },
]
const CLIENT_SERIES = [
  YEAR_SERIES[0],
  YEAR_SERIES[1],
  YEAR_SERIES[2],
  { id: 'net', key: 'netProfit', label: 'Чистая прибыль', unit: 'money', color: '#1d4e89' },
  YEAR_SERIES[3],
]
const YEAR_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const YEAR_MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const CHART_KEY = 'moysklad.chart'

function chartYear() {
  const year = Number(String(monthInput.value || '').slice(0, 4))
  return Number.isInteger(year) && year >= 2000 ? year : new Date().getFullYear()
}

function chartSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHART_KEY) || '')
    if (saved && typeof saved === 'object') return saved
  } catch { /* keep defaults */ }
  return {}
}

function seriesOn(id) {
  return chartSelection()[id] !== false
}

function setSeries(id, on) {
  const next = { ...chartSelection(), [id]: on }
  localStorage.setItem(CHART_KEY, JSON.stringify(next))
  renderYearChart(chartYear(), yearRows)
  renderClientChart()
}

async function loadYearChart() {
  const year = chartYear()
  const request = ++yearRequest
  yearTitle.textContent = String(year)
  let response
  try {
    response = await fetch(`/api/reports?year=${year}`)
  } catch {
    return
  }
  if (request !== yearRequest || !response.ok) return
  const body = await response.json()
  if (request !== yearRequest) return
  yearRows = body.months || []
  renderYearChart(year, yearRows)
}

function renderYearChart(year, rows) {
  const byMonth = new Map(rows.map((row) => [row.month, row]))
  const points = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`
    const row = byMonth.get(month)
    if (!row) return null
    return {
      month,
      sales: finiteChart(row.sales),
      profit: finiteChart(row.profit),
      missed: finiteChart(row.missed),
      markup: finiteChart(row.averageMarkup),
    }
  })
  yearToggles.replaceChildren(...YEAR_SERIES.map((series) => {
    const on = seriesOn(series.id)
    const button = h('button', {
      type: 'button',
      class: on ? 'year-toggle is-on' : 'year-toggle',
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => setSeries(series.id, !on),
    })
    const swatch = h('i')
    swatch.style.setProperty('--swatch', series.color)
    button.append(swatch, series.label)
    return button
  }))

  const saved = points.some(Boolean)
  const selected = YEAR_SERIES.filter((series) => seriesOn(series.id))
  const active = selected.filter((series) => points.some((point) => point && point[series.key] != null))
  const yearHint = document.querySelector('#year-hint')
  yearPlot.replaceChildren()
  if (!saved || active.length === 0) {
    yearPlot.hidden = true
    yearEmpty.hidden = false
    yearHint.textContent = 'Деньги на одной шкале, наценка — на правой'
    yearEmpty.textContent = !saved
      ? `За ${year} год проверок ещё нет. Они появятся после «Собрать».`
      : selected.length === 0
        ? 'Выберите показатель.'
        : 'Для выбранных показателей в этом году нет чисел. Продажи и прибыль появятся после новой сборки.'
    return
  }
  const moneyOn = active.some((series) => series.unit === 'money')
  const percentOn = active.some((series) => series.unit === 'percent')
  yearHint.textContent = moneyOn && percentOn
    ? 'Деньги на одной шкале, наценка — на правой'
    : percentOn
      ? 'Средняя наценка за месяц'
      : 'Суммы за месяц'
  yearPlot.hidden = false
  yearEmpty.hidden = true
  yearPlot.append(yearChartSvg(points, active), yearTip())
}

function finiteChart(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function yearTip(id = 'year-tip') {
  return h('div', { class: 'year-tip', id, hidden: true })
}

function yearChartSvg(points, active, options = {}) {
  const tipId = options.tipId || 'year-tip'
  const labelsOn = Boolean(options.labels)
  const moneySeries = active.filter((series) => series.unit === 'money')
  const percentSeries = active.filter((series) => series.unit === 'percent')
  const threshold = Number(thresholdInput.value)
  const moneyExtent = chartExtent(points.flatMap((point) => point ? moneySeries.map((series) => point[series.key]) : []))
  const percentValues = points.flatMap((point) => point ? percentSeries.map((series) => point[series.key]) : [])
  if (percentSeries.length && Number.isFinite(threshold)) percentValues.push(threshold)
  const percentExtent = chartExtent(percentValues)
  const width = 760
  const left = 58
  const right = moneySeries.length && percentSeries.length ? 52 : 16
  const top = labelsOn ? 78 : 16
  const bottom = 28
  const height = labelsOn ? 310 : 248
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const slot = plotWidth / 12
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' })
  svg.setAttribute('aria-label', 'Показатели по месяцам')
  const yMoney = (value) => chartY(value, moneyExtent, top, plotHeight)
  const yPercent = (value) => chartY(value, percentExtent, top, plotHeight)
  const hover = svgEl('rect', { fill: '#f6f7f9', visibility: 'hidden' })
  svg.append(hover)
  const axisExtent = moneySeries.length ? moneyExtent : percentExtent
  const axisY = moneySeries.length ? yMoney : yPercent
  for (const tick of chartTicks(axisExtent, 4)) {
    const y = axisY(tick)
    svg.append(svgEl('line', { x1: left, x2: width - right, y1: y, y2: y, stroke: '#e6e8ee' }))
    svg.append(svgText(left - 8, y + 4, moneySeries.length ? axisMoney(tick) : axisPercent(tick), { 'text-anchor': 'end' }))
  }
  if (moneySeries.length && percentSeries.length) {
    for (const tick of chartTicks(percentExtent, 4)) {
      svg.append(svgText(width - right + 8, yPercent(tick) + 4, axisPercent(tick)))
    }
  }
  const zero = moneySeries.length ? yMoney(0) : yPercent(0)
  if (moneySeries.length) {
    const inner = slot * 0.7
    const barWidth = inner / moneySeries.length
    points.forEach((point, index) => {
      if (!point) return
      moneySeries.forEach((series, seriesIndex) => {
        const value = point[series.key]
        if (value == null) return
        const y = yMoney(value)
        const x = left + index * slot + (slot - inner) / 2 + seriesIndex * barWidth
        const drawnWidth = Math.max(barWidth - 2, 1)
        const barTop = Math.min(zero, y)
        svg.append(svgEl('rect', {
          x,
          y: barTop,
          width: drawnWidth,
          height: Math.max(Math.abs(zero - y), 1),
          rx: 2,
          fill: series.color,
        }))
      })
    })
    if (labelsOn) {
      points.forEach((point, index) => {
        if (!point) return
        let labelY = 12
        const labelX = left + index * slot + 2
        for (const series of moneySeries) {
          const value = point[series.key]
          if (value == null) continue
          const label = svgText(labelX, labelY, axisMoney(value))
          label.style.fill = series.color
          label.style.fontSize = '10px'
          label.style.fontWeight = '700'
          svg.append(label)
          labelY += 12
        }
      })
    }
  }
  for (const series of percentSeries) {
    for (const run of chartRuns(points, series.key)) {
      if (run.length > 1) {
        svg.append(svgEl('polyline', {
          points: run.map((item) => `${left + (item.index + 0.5) * slot},${yPercent(item.value)}`).join(' '),
          fill: 'none',
          stroke: series.color,
          'stroke-width': 2.5,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }))
      }
      for (const item of run) {
        svg.append(svgEl('circle', {
          cx: left + (item.index + 0.5) * slot,
          cy: yPercent(item.value),
          r: 3.5,
          fill: series.color,
          stroke: '#fff',
          'stroke-width': 2,
        }))
      }
    }
  }
  if (percentSeries.length && Number.isFinite(threshold)) {
    const y = yPercent(threshold)
    svg.append(svgEl('line', {
      x1: left,
      x2: width - right,
      y1: y,
      y2: y,
      stroke: '#15803d',
      'stroke-width': 1.5,
      'stroke-dasharray': '5 4',
    }))
    const label = svgText(left + 6, y - 6, `порог ${formatPercent(threshold)}`)
    label.style.fill = '#15803d'
    svg.append(label)
  }
  points.forEach((point, index) => {
    svg.append(svgText(left + (index + 0.5) * slot, height - 8, YEAR_MONTHS[index], { 'text-anchor': 'middle' }))
    const hit = svgEl('rect', {
      x: left + index * slot,
      y: top,
      width: slot,
      height: plotHeight,
      fill: 'transparent',
    })
    if (point) hit.style.cursor = 'pointer'
    hit.addEventListener('pointerenter', () => {
      hover.setAttribute('x', String(left + index * slot))
      hover.setAttribute('y', String(top))
      hover.setAttribute('width', String(slot))
      hover.setAttribute('height', String(plotHeight))
      hover.setAttribute('visibility', point ? 'visible' : 'hidden')
      showYearTip(points, active, index, left, slot, width, tipId)
    })
    hit.addEventListener('click', () => {
      if (!point) return
      monthInput.value = point.month
      monthInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    svg.append(hit)
  })
  svg.addEventListener('pointerleave', () => {
    hover.setAttribute('visibility', 'hidden')
    const tip = document.querySelector(`#${tipId}`)
    if (tip) tip.hidden = true
  })
  return svg
}

function showYearTip(points, active, index, left, slot, width, tipId = 'year-tip') {
  const tip = document.querySelector(`#${tipId}`)
  const point = points[index]
  if (!tip || !point) {
    if (tip) tip.hidden = true
    return
  }
  tip.classList.toggle('is-start', index <= 1)
  tip.classList.toggle('is-end', index >= 10)
  tip.style.left = `${((left + (index + 0.5) * slot) / width) * 100}%`
  tip.replaceChildren(h('strong', {}, YEAR_MONTHS_FULL[index]))
  for (const series of active) {
    const value = point[series.key]
    const row = h('p')
    const swatch = h('i')
    swatch.style.background = series.color
    row.append(
      swatch,
      series.label,
      h('b', {}, value == null ? '—' : series.unit === 'percent' ? formatPercent(value) : formatMoney(value)),
    )
    tip.append(row)
  }
  tip.hidden = false
}

function chartRuns(points, key) {
  const runs = []
  let run = []
  points.forEach((point, index) => {
    const value = point?.[key]
    if (value == null) {
      if (run.length) runs.push(run)
      run = []
      return
    }
    run.push({ index, value })
  })
  if (run.length) runs.push(run)
  return runs
}

function chartExtent(values) {
  const nums = values.filter((value) => value != null && Number.isFinite(value))
  if (!nums.length) return { min: 0, max: 1 }
  const min = Math.min(0, ...nums)
  const max = Math.max(0, ...nums)
  if (min === max) return { min, max: max === 0 ? 1 : max * 1.08 }
  return { min, max: max + (max - min) * 0.08 }
}

function chartTicks(extent, count) {
  const span = extent.max - extent.min || 1
  return Array.from({ length: count }, (_, index) => extent.min + (span * index) / (count - 1))
}

function chartY(value, extent, top, height) {
  const span = extent.max - extent.min || 1
  return top + (1 - (value - extent.min) / span) * height
}

function axisMoney(value) {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${axisNumber(value / 1_000_000)} млн`
  if (abs >= 10_000) return `${axisNumber(value / 1_000)} тыс.`
  return axisNumber(value)
}

function axisPercent(value) {
  return `${axisNumber(value)}%`
}

function axisNumber(value) {
  const rounded = Math.round(value * 10) / 10
  const digits = Math.abs(rounded - Math.round(rounded)) < 0.05 ? 0 : 1
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded)
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

function svgText(x, y, text, attrs = {}) {
  const node = svgEl('text', { x, y, ...attrs })
  node.textContent = text
  return node
}
