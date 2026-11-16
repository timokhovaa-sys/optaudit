const form = document.querySelector('#filters')
const monthInput = document.querySelector('#month')
const productInput = document.querySelector('#product')
const productSuggest = document.querySelector('#product-suggest')
const numberInput = document.querySelector('#number')
const submitButton = document.querySelector('#submit')
const stopButton = document.querySelector('#stop')
const progressBox = document.querySelector('#progress')
const progressText = document.querySelector('#progress-text')
const bar = document.querySelector('#bar')
const errorBox = document.querySelector('#error')
const errorText = document.querySelector('#error-text')
const results = document.querySelector('#results')
const summary = document.querySelector('#summary')
const salesBox = document.querySelector('#sales')
const cardsSection = document.querySelector('#cards')
const tabDraft = document.querySelector('#tab-draft')
const tabDone = document.querySelector('#tab-done')
const draftCount = document.querySelector('#draft-count')
const doneCount = document.querySelector('#done-count')
const draftList = document.querySelector('#draft-list')
const doneList = document.querySelector('#done-list')

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const quantityFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 })

let controller = null
let cardFilter = ''
let suggestController = null
let suggestTimer = 0
let suggestSeq = 0
let suggestItems = []
let suggestIndex = -1

const monthButton = document.querySelector('#month-button')
const monthCaption = document.querySelector('#month-caption')
const monthPop = document.querySelector('#month-pop')
const monthYear = document.querySelector('#month-year')
const monthGrid = document.querySelector('#month-grid')
const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const monthShort = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
let pickerYear = new Date().getFullYear()

const prefs = loadPrefs()
const now = new Date()
setMonth(prefs.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)

form.addEventListener('submit', (event) => {
  event.preventDefault()
  runSearch()
})
stopButton.addEventListener('click', () => controller?.abort())
monthButton.addEventListener('click', () => {
  if (monthPop.hidden) openMonth()
  else closeMonth()
})
document.querySelector('#month-prev').addEventListener('click', () => renderMonthGrid(pickerYear - 1))
document.querySelector('#month-next').addEventListener('click', () => renderMonthGrid(pickerYear + 1))
monthGrid.addEventListener('click', (event) => {
  const choice = event.target.closest('button')
  if (!choice) return
  setMonth(`${pickerYear}-${choice.dataset.month}`)
  savePrefs()
  closeMonth()
})
document.addEventListener('click', (event) => {
  if (!event.target.closest('.field-month')) closeMonth()
  if (!event.target.closest('.reason')) closeReasons()
  if (!event.target.closest('.field-grow')) closeSuggest()
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (closePhotoView) {
    closePhotoView()
    return
  }
  const reasonOpen = document.querySelector('.reason-pop:not([hidden])')
  closeMonth()
  closeReasons()
  closeSuggest()
  if (!reasonOpen) closeReturnModal()
})
productInput.addEventListener('input', () => {
  window.clearTimeout(suggestTimer)
  const text = productInput.value.trim()
  if (text.length < 2) {
    closeSuggest()
    return
  }
  suggestTimer = window.setTimeout(() => loadSuggest(text), 160)
})
wireClear(productInput, numberInput)
wireClear(numberInput, productInput)
productInput.addEventListener('keydown', (event) => {
  if (productSuggest.hidden) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveSuggest(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveSuggest(-1)
  } else if (event.key === 'Enter' && suggestIndex >= 0) {
    event.preventDefault()
    pickSuggest(suggestItems[suggestIndex])
  }
})
productSuggest.addEventListener('mousedown', (event) => {
  const choice = event.target.closest('button[data-index]')
  if (!choice) return
  event.preventDefault()
  pickSuggest(suggestItems[Number(choice.dataset.index)])
})

function wireClear(input, other) {
  const button = input.parentElement.querySelector('.clear')
  const sync = () => { button.hidden = input.value.length === 0 }
  const clearOther = () => {
    if (!other.value) return
    other.value = ''
    other.dispatchEvent(new Event('input'))
  }
  input.addEventListener('input', () => {
    sync()
    if (input.value) clearOther()
  })
  input.addEventListener('focus', clearOther)
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    input.value = ''
    input.dispatchEvent(new Event('input'))
    input.focus()
  })
  sync()
}

function setMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value || '')
  if (!match) return
  monthInput.value = value
  const index = Number(match[2]) - 1
  const name = monthNames[index] || ''
  monthCaption.textContent = `${name.charAt(0).toLocaleUpperCase('ru')}${name.slice(1)} ${match[1]}`
  pickerYear = Number(match[1])
}

function openMonth() {
  renderMonthGrid(pickerYear)
  monthPop.hidden = false
  monthButton.setAttribute('aria-expanded', 'true')
}

function closeMonth() {
  monthPop.hidden = true
  monthButton.setAttribute('aria-expanded', 'false')
}

function closeSuggest() {
  window.clearTimeout(suggestTimer)
  suggestController?.abort()
  suggestController = null
  suggestSeq += 1
  suggestItems = []
  suggestIndex = -1
  productSuggest.hidden = true
  productSuggest.replaceChildren()
  productInput.setAttribute('aria-expanded', 'false')
  productInput.removeAttribute('aria-activedescendant')
}

function moveSuggest(step) {
  if (!suggestItems.length) return
  const next = suggestIndex + step
  suggestIndex = Math.min(suggestItems.length - 1, Math.max(0, next))
  paintSuggest()
}

function pickSuggest(item) {
  if (!item) return
  productInput.value = item.name
  productInput.parentElement.querySelector('.clear').hidden = false
  closeSuggest()
  productInput.focus()
}

async function loadSuggest(text) {
  suggestController?.abort()
  const current = new AbortController()
  suggestController = current
  const seq = ++suggestSeq
  showSuggestNote('Ищу…')
  try {
    const response = await fetch('/sales/api/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: localStorage.getItem('moysklad.token') || '',
        q: text,
      }),
      signal: current.signal,
    })
    const body = await response.json().catch(() => ({}))
    if (seq !== suggestSeq) return
    if (!response.ok) {
      showSuggestNote(body.message || 'Не удалось найти товары')
      return
    }
    const asked = productInput.value.trim()
    if (asked !== text) return
    suggestItems = Array.isArray(body.items) ? body.items.slice(0, 10) : []
    suggestIndex = -1
    if (!suggestItems.length) {
      showSuggestNote('Нет совпадений')
      return
    }
    paintSuggest()
  } catch (error) {
    if (error.name === 'AbortError' || seq !== suggestSeq) return
    closeSuggest()
  }
}

function showSuggestNote(text) {
  suggestItems = []
  suggestIndex = -1
  productSuggest.hidden = false
  productInput.setAttribute('aria-expanded', 'true')
  productInput.removeAttribute('aria-activedescendant')
  const note = document.createElement('div')
  note.className = 'suggest-note'
  note.textContent = text
  productSuggest.replaceChildren(note)
}

function paintSuggest() {
  productSuggest.hidden = false
  productInput.setAttribute('aria-expanded', 'true')
  productSuggest.replaceChildren(...suggestItems.map((item, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.index = String(index)
    button.id = `product-suggest-${index}`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', index === suggestIndex ? 'true' : 'false')
    if (index === suggestIndex) button.className = 'is-on'
    const name = document.createElement('span')
    name.className = 'suggest-name'
    name.textContent = item.name
    button.append(name)
    const meta = [item.article, item.code].filter(Boolean).join(' · ')
    if (meta) {
      const extra = document.createElement('span')
      extra.className = 'suggest-meta'
      extra.textContent = meta
      button.append(extra)
    }
    return button
  }))
  if (suggestIndex >= 0) productInput.setAttribute('aria-activedescendant', `product-suggest-${suggestIndex}`)
  else productInput.removeAttribute('aria-activedescendant')
  productSuggest.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' })
}

function closeReasons() {
  for (const pop of document.querySelectorAll('.reason-pop')) {
    pop.hidden = true
    pop.parentElement?.querySelector('.reason-button')?.setAttribute('aria-expanded', 'false')
  }
}

function renderMonthGrid(year) {
  pickerYear = Math.min(2100, Math.max(2000, year))
  monthYear.textContent = String(pickerYear)
  document.querySelector('#month-prev').disabled = pickerYear <= 2000
  document.querySelector('#month-next').disabled = pickerYear >= 2100
  const selected = monthInput.value
  monthGrid.replaceChildren(...monthShort.map((name, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.month = String(index + 1).padStart(2, '0')
    button.textContent = name
    if (`${pickerYear}-${button.dataset.month}` === selected) button.className = 'is-on'
    return button
  }))
}

async function runSearch() {
  if (!form.reportValidity()) return
  if (!productInput.value.trim() && !numberInput.value.trim()) {
    showError('Укажите товар или номер.')
    return
  }
  controller?.abort()
  controller = new AbortController()
  hideError()
  results.hidden = true
  setBusy(true)
  setProgress('Ищу…', 0.08)
  const token = localStorage.getItem('moysklad.token') || ''
  savePrefs()
  try {
    const response = await fetch('/sales/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        month: monthInput.value,
        product: productInput.value,
        number: numberInput.value,
        postedOnly: true,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.message || 'Не удалось найти продажи')
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
          showSales(event.result)
        }
      }
    }
    if (!gotResult) throw new Error('Поиск прервался. Нажмите «Найти» ещё раз.')
  } catch (error) {
    if (error.name === 'AbortError') {
      setProgress('Остановлено', 0)
      return
    }
    showError(error.message || 'Не удалось найти продажи')
  } finally {
    setBusy(false)
  }
}

function showSales(result) {
  progressBox.hidden = true
  const rows = result.sales || []
  const count = rows.length
    ? `${rows.length} ${plural(rows.length, 'документ', 'документа', 'документов')}`
    : ''
  summary.replaceChildren()
  if (count) summary.append(count)
  else if (!result.notice) summary.textContent = 'За этот месяц документов не найдено.'
  if (result.notice) {
    if (count) summary.append(document.createElement('br'))
    summary.append(result.notice)
  }
  salesBox.replaceChildren(...rows.map(saleRow))
  results.hidden = false
}

const RETURN_REASONS = [
  ['defect', 'Брак'],
  ['fit', 'Не подошло'],
  ['mistake', 'Ошибка в документе'],
  ['extra', 'Лишний товар'],
]

function clientBlock(sale) {
  const hasDetails = sale.phone || sale.email || sale.siteOrder || sale.paymentType
  if (!hasDetails) return null
  const block = document.createElement('div')
  block.className = 'sale-client'
  const who = document.createElement('div')
  who.className = 'sale-client-who'
  const name = document.createElement('div')
  name.className = 'sale-client-name'
  name.textContent = sale.agent || 'Без контрагента'
  who.append(name)
  if (sale.phone || sale.email) {
    const contacts = document.createElement('div')
    contacts.className = 'sale-client-contacts'
    if (sale.phone) contacts.append(textSpan(sale.phone))
    if (sale.email) contacts.append(textSpan(sale.email, 'is-mail'))
    who.append(contacts)
  }
  block.append(who)
  if (sale.siteOrder || sale.paymentType) {
    const facts = document.createElement('div')
    facts.className = 'sale-client-facts'
    if (sale.siteOrder) facts.append(clientFact('Сайт', sale.siteOrder))
    if (sale.paymentType) facts.append(clientFact('Оплата', sale.paymentType))
    block.append(facts)
  }
  return block
}

function textSpan(value, className) {
  const span = document.createElement('span')
  if (className) span.className = className
  span.textContent = value
  return span
}

function clientFact(label, value) {
  const item = document.createElement('div')
  const caption = document.createElement('span')
  caption.textContent = label
  const strong = document.createElement('b')
  strong.textContent = value
  item.append(caption, strong)
  return item
}

function saleRow(sale) {
  const article = document.createElement('article')
  article.className = 'panel sale'
  const main = document.createElement('div')
  main.className = 'sale-main'

  const date = document.createElement('div')
  date.className = 'sale-date'
  date.textContent = dateLabel(sale.moment)

  const meta = document.createElement('div')
  meta.className = 'sale-meta'
  const link = document.createElement('a')
  link.className = 'sale-number'
  link.href = sale.href || '#'
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = sale.name || 'без номера'
  meta.append(link)
  meta.append(pill(sale.label))
  if (sale.payment?.status === 'paid') meta.append(pill('оплачен', 'is-ok'))
  if (!sale.applicable) meta.append(pill('не проведён', 'is-warn'))

  const agent = document.createElement('div')
  agent.className = 'sale-agent'
  agent.textContent = sale.agent || 'Без контрагента'

  const sum = document.createElement('div')
  sum.className = 'sale-sum'
  sum.textContent = sale.price != null
    ? `${quantityFormat.format(sale.quantity)} × ${formatMoney(sale.price)}`
    : formatMoney(sale.sum)

  const client = clientBlock(sale)
  if (client) article.classList.add('has-client')
  main.append(date, meta)
  if (!client) main.append(agent)
  main.append(sum)
  article.append(main)
  if (client) article.append(client)

  if (Array.isArray(sale.lines) && sale.lines.length) {
    const lines = document.createElement('div')
    lines.className = 'lines'
    lines.append(lineHead())
    const actions = document.createElement('div')
    actions.className = 'sale-return'
    const returnable = sale.returns ? sale.returns.returnable === true : sale.payment?.status === 'paid'
    const blocked = !returnable
    const total = document.createElement('div')
    total.className = 'return-total'
    const totalLabel = document.createElement('span')
    totalLabel.textContent = 'Итого сумма к возврату'
    const totalValue = document.createElement('b')
    total.append(totalLabel, totalValue)
    if (sale.returns?.returnedSum > 0) {
      const returnedSum = document.createElement('span')
      returnedSum.className = 'return-meta'
      returnedSum.textContent = `Уже возвращено на ${formatMoney(sale.returns.returnedSum)}`
      total.append(returnedSum)
    }
    const note = document.createElement('p')
    note.className = blocked ? 'pay-note' : 'hint'
    note.hidden = !blocked
    if (blocked) note.textContent = sale.returns?.message || paymentMessage(sale.payment)
    const returnButton = document.createElement('button')
    returnButton.type = 'button'
    returnButton.className = 'btn btn-primary'
    returnButton.textContent = 'Оформить черновик возврата'
    returnButton.disabled = true
    const rowsOf = () => [...lines.querySelectorAll('.line[data-return]')]
    let holdNote = false
    const refreshReturn = () => {
      const rows = rowsOf()
      const amount = roundMoney(rows.reduce((sum, row) => sum + returnAmount(row), 0))
      totalValue.textContent = formatMoney(amount)
      totalValue.classList.toggle('is-zero', amount <= 0)
      if (blocked) {
        returnButton.disabled = true
        return
      }
      const remaining = Number(sale.returns?.paidRemaining)
      const selected = rows.some((row) => Number(row.dataset.return) > 0)
      if (Number.isFinite(remaining) && amount > remaining + 0.001) {
        note.className = 'pay-note'
        note.hidden = false
        note.dataset.mode = 'cap'
        note.textContent = `Сумма больше остатка оплаты. Доступно ${formatMoney(remaining)}.`
        returnButton.disabled = true
        return
      }
      if (!holdNote && note.dataset.mode === 'result') {
        delete note.dataset.mode
        note.hidden = true
      }
      returnButton.disabled = !(selected)
    }
    for (const line of sale.lines) lines.append(returnLine(line, refreshReturn, blocked, sale.price != null))
    returnButton.addEventListener('click', () => {
      if (returnButton.disabled) return
      openReturnModal({
        sale,
        rows: rowsOf(),
        note,
        button: returnButton,
        refresh: refreshReturn,
        hold: () => { holdNote = true },
        release: () => { holdNote = false },
      })
    })
    refreshReturn()
    actions.append(returnButton, note)
    const foot = document.createElement('div')
    foot.className = 'sale-foot'
    foot.append(total, actions)
    article.append(lines, foot)
  } else if (!Array.isArray(sale.lines) && sale.positionsCount) {
    const note = document.createElement('p')
    note.className = 'hint lines'
    note.textContent = `${sale.positionsCount} ${plural(sale.positionsCount, 'позиция', 'позиции', 'позиций')}`
    article.append(note)
  }
  return article
}

function reasonPicker(blocked, onChange, { downward = false } = {}) {
  const root = document.createElement('div')
  root.className = downward ? 'reason is-down' : 'reason'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'reason-button'
  button.disabled = blocked
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-label', 'Причина возврата')
  const caption = document.createElement('span')
  caption.className = 'is-empty'
  caption.textContent = 'Причина'
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M6 9l6 6 6-6')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.7')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  icon.append(path)
  button.append(caption, icon)
  const pop = document.createElement('div')
  pop.className = 'reason-pop'
  pop.hidden = true
  pop.setAttribute('role', 'listbox')
  pop.setAttribute('aria-label', 'Причина возврата')
  let value = ''
  for (const [code, label] of RETURN_REASONS) {
    const option = document.createElement('button')
    option.type = 'button'
    option.className = 'reason-option'
    option.setAttribute('role', 'option')
    option.textContent = label
    option.addEventListener('click', () => {
      value = code
      caption.textContent = label
      caption.classList.remove('is-empty')
      for (const item of pop.querySelectorAll('.reason-option')) item.classList.toggle('is-on', item === option)
      pop.hidden = true
      button.setAttribute('aria-expanded', 'false')
      onChange()
    })
    pop.append(option)
  }
  button.addEventListener('click', () => {
    if (button.disabled) return
    const open = pop.hidden
    closeReasons()
    if (!open) return
    closeMonth()
    pop.hidden = false
    button.setAttribute('aria-expanded', 'true')
  })
  root.append(button, pop)
  return { root, get value() { return value } }
}

const PHOTO_SLOTS = [
  ['mounts', 'Фото креплений'],
  ['overview', 'Общий план с упаковкой'],
  ['terminals', 'Фото терминалов'],
]
const PHOTO_LABELS = new Map([
  ...PHOTO_SLOTS,
  ['statement', 'Заявление'],
])
const COMPENSATION = [
  ['cash', 'Наличные'],
  ['cashless', 'Безнал'],
]
let returnModal = null
let closePhotoView = null

function openReturnModal({ sale, rows, note, button, refresh, hold, release }) {
  closeReturnModal()
  closeMonth()
  closeSuggest()
  const picks = new Map(PHOTO_SLOTS.map(([slot]) => [slot, []]))
  let compensation = ''
  const back = document.createElement('div')
  back.className = 'modal-back'
  const dialog = document.createElement('div')
  dialog.className = 'modal'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'return-modal-title')
  const head = document.createElement('div')
  head.className = 'modal-head'
  const title = document.createElement('h2')
  title.id = 'return-modal-title'
  title.textContent = 'Оформление возврата'
  const closer = document.createElement('button')
  closer.type = 'button'
  closer.className = 'modal-x'
  closer.textContent = '×'
  closer.setAttribute('aria-label', 'Закрыть')
  head.append(title, closer)
  const lead = document.createElement('p')
  lead.className = 'modal-lead'
  const amount = roundMoney(rows.reduce((sum, row) => sum + returnAmount(row), 0))
  lead.textContent = `${sale.label || 'Документ'} ${sale.name || ''} · ${formatMoney(amount)}`
  const reason = reasonPicker(false, refreshModal, { downward: true })
  const payLabel = document.createElement('span')
  payLabel.className = 'modal-caption'
  payLabel.textContent = 'Компенсация'
  const pay = document.createElement('div')
  pay.className = 'comp'
  for (const [code, label] of COMPENSATION) {
    const choice = document.createElement('button')
    choice.type = 'button'
    choice.textContent = label
    choice.addEventListener('click', () => {
      compensation = code
      for (const item of pay.querySelectorAll('button')) item.classList.toggle('is-on', item === choice)
      refreshModal()
    })
    pay.append(choice)
  }
  const meter = completenessMeter()
  const requisites = document.createElement('label')
  requisites.className = 'requisites'
  requisites.hidden = true
  const requisitesInput = document.createElement('textarea')
  requisitesInput.rows = 3
  requisitesInput.maxLength = 2000
  requisitesInput.placeholder = 'Укажите способ возврата и реквизиты (отмена рассрочки, перевод и тп )'
  requisitesInput.addEventListener('input', () => refreshModal())
  requisites.append(requisitesInput)
  const grid = document.createElement('div')
  grid.className = 'photo-grid'
  for (const [slot, label] of PHOTO_SLOTS) grid.append(photoSlot(slot, label, picks, refreshModal))
  const modalNote = document.createElement('p')
  modalNote.className = 'pay-note'
  modalNote.hidden = true
  const foot = document.createElement('div')
  foot.className = 'modal-foot'
  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn'
  cancel.textContent = 'Отмена'
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'btn btn-primary'
  submit.textContent = 'Оформить'
  submit.disabled = true
  actions.append(submit, cancel)
  foot.append(meter.root, actions)
  dialog.append(head, lead, reason.root, payLabel, pay, requisites, grid, modalNote, foot)
  back.append(dialog)
  document.body.append(back)
  const close = () => {
    for (const list of picks.values()) {
      for (const item of list) URL.revokeObjectURL(item.url)
    }
    back.remove()
    if (returnModal?.close === close) returnModal = null
  }
  returnModal = { close }
  closer.addEventListener('click', close)
  cancel.addEventListener('click', close)
  submit.addEventListener('click', async () => {
    const noteText = compensation === 'cashless' ? requisitesInput.value.trim() : ''
    if (!reason.value || !compensation || (compensation === 'cashless' && !noteText)) {
      modalNote.hidden = false
      modalNote.textContent = compensation === 'cashless' && !noteText
        ? 'Укажите способ возврата и реквизиты.'
        : 'Укажите причину и компенсацию.'
      return
    }
    submit.disabled = true
    cancel.disabled = true
    modalNote.hidden = false
    modalNote.className = 'hint'
    modalNote.textContent = 'Сохраняю фото…'
    const photos = []
    for (const [slot, list] of picks) {
      for (const item of list) {
        const data = await shrinkPhoto(item.file)
        if (data) photos.push({ slot, name: item.file.name, data })
      }
    }
    const ok = await checkReturn(sale, rows, {
      reason: reason.value,
      compensation,
      compensationNote: noteText,
      photos,
    }, note, button, refresh, hold, release)
    if (ok) close()
    else {
      submit.disabled = false
      cancel.disabled = false
      modalNote.className = 'pay-note'
      modalNote.hidden = false
      modalNote.textContent = note.textContent || 'Не удалось оформить возврат.'
    }
  })
  function refreshModal() {
    const cashless = compensation === 'cashless'
    const noteText = cashless ? requisitesInput.value.trim() : ''
    requisites.hidden = !cashless
    let done = 0
    let total = 2 + PHOTO_SLOTS.length
    if (reason.value) done += 1
    if (compensation) done += 1
    if (cashless) {
      total += 1
      if (noteText) done += 1
    }
    for (const [slot] of PHOTO_SLOTS) {
      if (picks.get(slot).length) done += 1
    }
    meter.set(done, total)
    const ready = Boolean(reason.value && compensation && (!cashless || noteText))
    submit.disabled = !ready
    if (ready) modalNote.hidden = true
  }
  refreshModal()
  reason.root.querySelector('button')?.focus()
}

function completenessMeter() {
  const root = document.createElement('div')
  root.className = 'fill'
  const track = document.createElement('div')
  track.className = 'fill-track'
  const bar = document.createElement('span')
  track.append(bar)
  const text = document.createElement('span')
  root.append(track, text)
  return {
    root,
    set(done, total) {
      const ratio = total ? done / total : 0
      bar.style.width = `${Math.round(ratio * 100)}%`
      root.classList.toggle('is-full', total > 0 && done === total)
      text.textContent = `Заполнено ${done} из ${total}`
    },
  }
}

function photoSlot(slot, label, picks, onChange) {
  const box = document.createElement('section')
  box.className = 'photo-slot'
  const head = document.createElement('div')
  head.className = 'photo-slot-head'
  const caption = document.createElement('b')
  caption.textContent = label
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'btn'
  add.textContent = 'Добавить'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.hidden = true
  const thumbs = document.createElement('div')
  thumbs.className = 'thumbs'
  const paint = () => {
    thumbs.replaceChildren(...picks.get(slot).map((item, index) => {
      const wrap = document.createElement('figure')
      const image = document.createElement('img')
      image.src = item.url
      image.alt = label
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '×'
      remove.setAttribute('aria-label', 'Убрать фото')
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(item.url)
        picks.get(slot).splice(index, 1)
        paint()
        onChange()
      })
      wrap.append(image, remove)
      return wrap
    }))
    box.classList.toggle('is-filled', picks.get(slot).length > 0)
  }
  add.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const list = picks.get(slot)
    for (const file of input.files || []) {
      if (countPhotos(picks) >= 12) break
      if (!file.type.startsWith('image/')) continue
      list.push({ file, url: URL.createObjectURL(file) })
    }
    input.value = ''
    paint()
    onChange()
  })
  head.append(caption, add)
  box.append(head, input, thumbs)
  return box
}

function countPhotos(picks) {
  let count = 0
  for (const list of picks.values()) count += list.length
  return count
}

function shrinkPhoto(file) {
  return new Promise((resolve) => {
    const image = new Image()
    const url = URL.createObjectURL(file)
    image.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height || 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.72))
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve('')
    }
    image.src = url
  })
}

function closeReturnModal() {
  returnModal?.close()
  returnModal = null
}

function lineHead() {
  const row = document.createElement('div')
  row.className = 'line line-head'
  for (const text of ['', 'Отгружено', 'К возврату', '']) {
    const cell = document.createElement('span')
    cell.textContent = text
    row.append(cell)
  }
  return row
}

function returnLine(line, onChange, blocked, unitPrice) {
  const shipped = Math.max(0, Number(line.quantity) || 0)
  const available = Math.max(0, Number.isFinite(Number(line.available)) ? Number(line.available) : shipped)
  const closed = blocked || available <= 0
  const step = quantityStep(available || shipped)
  let returning = 0
  let maxQty = available
  const row = document.createElement('div')
  row.className = 'line'

  const label = document.createElement('label')
  label.className = 'line-name'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.disabled = closed
  const name = document.createElement('span')
  name.textContent = lineLabel(line)
  checkbox.setAttribute('aria-label', `Вернуть: ${name.textContent}`)
  label.append(checkbox, name)
  if (Number(line.returned) > 0 || Number(line.reserved) > 0) {
    const returned = document.createElement('small')
    returned.className = 'line-returned'
    const reservedOnly = Number(line.reserved) > 0 && !(Number(line.returned) > 0)
    returned.textContent = reservedOnly
      ? 'уже в возврате'
      : available > 0
        ? `уже возвращено ${quantityFormat.format(line.returned)}`
        : 'уже возвращено'
    label.append(returned)
  }

  const shippedCell = document.createElement('b')
  shippedCell.className = 'line-shipped'
  shippedCell.textContent = quantityFormat.format(shipped)

  const stepper = document.createElement('div')
  stepper.className = 'stepper'
  const minus = document.createElement('button')
  minus.type = 'button'
  minus.textContent = '‹'
  minus.setAttribute('aria-label', 'Меньше к возврату')
  const value = document.createElement('b')
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.textContent = '›'
  plus.setAttribute('aria-label', 'Больше к возврату')
  stepper.append(minus, value, plus)

  const moneyCell = document.createElement('b')
  moneyCell.className = 'line-money'
  moneyCell.textContent = unitPrice && line.price != null
    ? formatMoney(line.price)
    : formatMoney(line.sum)

  const paint = (notify) => {
    const factor = step < 1 ? 1000 : 1
    returning = Math.round(returning * factor) / factor
    value.textContent = quantityFormat.format(returning)
    checkbox.checked = !closed && returning > 0
    row.classList.toggle('is-return', !closed && returning > 0)
    minus.disabled = closed || returning <= 0
    plus.disabled = closed || returning >= maxQty
    row.dataset.return = String(returning)
    if (notify) onChange()
  }
  const setReturn = (next) => {
    if (closed) return
    returning = Math.min(maxQty, Math.max(0, next))
    paint(true)
  }
  row.setAvailable = (next) => {
    maxQty = Math.max(0, Number(next) || 0)
    row.dataset.max = String(maxQty)
    if (maxQty <= 0) {
      checkbox.disabled = true
      returning = 0
      paint(true)
      return
    }
    if (returning > maxQty) setReturn(maxQty)
    else paint(true)
  }
  checkbox.addEventListener('change', () => setReturn(checkbox.checked ? maxQty : 0))
  minus.addEventListener('click', () => setReturn(returning - step))
  plus.addEventListener('click', () => setReturn(returning + step))
  paint(false)
  row.dataset.shipped = String(shipped)
  row.dataset.max = String(maxQty)
  row.dataset.href = line.assortmentHref || ''
  row.dataset.code = line.code || ''
  row.dataset.unit = line.price != null && Number.isFinite(Number(line.price))
    ? String(line.price)
    : ''
  row.dataset.amount = line.sum != null && Number.isFinite(Number(line.sum))
    ? String(line.sum)
    : ''
  row.append(label, shippedCell, stepper, moneyCell)
  return row
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}

async function checkReturn(sale, rows, details, note, button, refresh, hold, release) {
  button.disabled = true
  note.className = 'hint'
  note.hidden = false
  note.dataset.mode = 'result'
  note.textContent = 'Проверяю…'
  hold()
  let ok = false
  try {
    const response = await fetch('/sales/api/return-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: localStorage.getItem('moysklad.token') || '',
        kind: sale.kind,
        id: sale.id,
        reason: details.reason,
        compensation: details.compensation,
        compensationNote: details.compensationNote || '',
        photos: details.photos || [],
        lines: rows
          .filter((row) => Number(row.dataset.return) > 0)
          .map((row) => ({
            assortmentHref: row.dataset.href || '',
            code: row.dataset.code || '',
            quantity: Number(row.dataset.return),
          })),
      }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.message || 'Не удалось проверить возврат')
    if (body.returns) sale.returns = { ...sale.returns, ...body.returns }
    for (const fresh of body.lines || []) {
      const row = rows.find((item) => (
        (fresh.assortmentHref && item.dataset.href === fresh.assortmentHref)
        || (fresh.code && item.dataset.code === fresh.code)
      ))
      if (row?.setAvailable) row.setAvailable(fresh.available)
    }
    if (body.card) {
      ok = true
      note.hidden = true
      note.textContent = ''
      delete note.dataset.mode
      cardFilter = 'draft'
      await loadCards()
    } else {
      note.className = body.ok ? 'hint' : 'pay-note'
      note.hidden = false
      note.dataset.mode = 'result'
      note.textContent = body.message || (body.ok ? 'Проверки пройдены. Возврат пока не создаём.' : 'Возврат недоступен.')
    }
  } catch (error) {
    note.className = 'pay-note'
    note.hidden = false
    note.dataset.mode = 'result'
    note.textContent = error.message || 'Не удалось проверить возврат'
  }
  refresh()
  release()
  return ok
}

function returnAmount(row) {
  const quantity = Number(row.dataset.return) || 0
  if (!quantity) return 0
  const shipped = Number(row.dataset.shipped) || 0
  const amount = Number(row.dataset.amount)
  if (shipped && quantity === shipped && Number.isFinite(amount)) return amount
  const unit = Number(row.dataset.unit)
  if (Number.isFinite(unit)) return Math.round(unit * quantity * 100) / 100
  if (shipped && Number.isFinite(amount)) return Math.round((amount / shipped) * quantity * 100) / 100
  return 0
}

function quantityStep(quantity) {
  const text = String(Math.round(quantity * 1000) / 1000)
  const decimals = text.includes('.') ? text.split('.')[1].length : 0
  return decimals > 0 ? 10 ** -decimals : 1
}

function paymentMessage(payment) {
  const order = payment?.source !== 'document'
  if (payment?.status === 'partial') {
    return order
      ? 'Заказ оплачен не полностью. Возврат недоступен.'
      : 'Документ оплачен не полностью. Возврат недоступен.'
  }
  if (payment?.status === 'unpaid') {
    return order
      ? 'Заказ не оплачен. Возврат недоступен.'
      : 'Документ не оплачен. Возврат недоступен.'
  }
  return 'Оплату заказа не удалось проверить. Возврат недоступен.'
}

function lineLabel(line) {
  const extra = [line.article, line.code].filter(Boolean).join(' · ')
  return extra ? `${line.name} · ${extra}` : line.name
}

function pill(text, className = '') {
  const node = document.createElement('span')
  node.className = className ? `pill ${className}` : 'pill'
  node.textContent = text
  return node
}

function savedLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return dateLabel(value)
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateLabel(moment) {
  const [date, time = ''] = String(moment || '').split(' ')
  const [year, month, day] = date.split('-')
  if (!day || !month || !year) return 'без даты'
  return `${day}.${month}.${year}${time ? ` ${time.slice(0, 5)}` : ''}`
}

function formatMoney(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return money.format(number)
}

function plural(count, one, few, many) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function setBusy(busy) {
  submitButton.disabled = busy
  monthButton.disabled = busy
  productInput.disabled = busy
  numberInput.disabled = busy
  for (const button of document.querySelectorAll('.filters .clear')) button.disabled = busy
  stopButton.disabled = !busy
  if (busy) {
    closeMonth()
    closeSuggest()
    progressBox.hidden = false
  }
}

function setProgress(message, ratio) {
  progressBox.hidden = false
  progressBox.classList.toggle('is-stopped', ratio <= 0)
  progressText.textContent = message
  bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
}

function showError(message) {
  progressBox.hidden = true
  errorText.textContent = message
  errorBox.hidden = false
}

function hideError() {
  errorBox.hidden = true
  errorText.textContent = ''
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('sales.filters') || '{}')
  } catch {
    return {}
  }
}

function savePrefs() {
  localStorage.setItem('sales.filters', JSON.stringify({
    month: monthInput.value,
  }))
}

loadCards()

async function loadCards() {
  try {
    const response = await fetch('/sales/api/returns')
    if (!response.ok) return
    const body = await response.json()
    showCards(body.cards || [])
  } catch {
    // список карточек не мешает поиску
  }
}

async function confirmCard(card, button) {
  button.disabled = true
  hideError()
  try {
    const response = await fetch(`/sales/api/returns/${encodeURIComponent(card.id)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: localStorage.getItem('moysklad.token') || '' }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok === false) throw new Error(body.message || 'Не удалось провести возврат')
    await loadCards()
  } catch (error) {
    button.disabled = false
    showError(error.message || 'Не удалось провести возврат')
  }
}

async function deleteCard(id, button) {
  button.disabled = true
  try {
    const response = await fetch(`/sales/api/returns/${encodeURIComponent(id)}`, { method: 'DELETE' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.message || 'Не удалось удалить карточку')
    hideError()
    await loadCards()
  } catch (error) {
    button.disabled = false
    showError(error.message || 'Не удалось удалить карточку')
  }
}

function showCards(cards) {
  const drafts = []
  const done = []
  for (const card of cards) (cardSettled(card) ? done : drafts).push(card)
  draftList.replaceChildren(...drafts.map(returnCard))
  doneList.replaceChildren(...done.map(returnCard))
  draftCount.textContent = String(drafts.length)
  doneCount.textContent = String(done.length)
  if (!cardFilter) cardFilter = drafts.length ? 'draft' : 'done'
  applyCardFilter()
  cardsSection.hidden = cards.length === 0
}

function applyCardFilter() {
  const draftsOn = cardFilter !== 'done'
  draftList.hidden = !draftsOn
  doneList.hidden = draftsOn
  tabDraft.classList.toggle('is-on', draftsOn)
  tabDone.classList.toggle('is-on', !draftsOn)
  tabDraft.setAttribute('aria-selected', draftsOn ? 'true' : 'false')
  tabDone.setAttribute('aria-selected', draftsOn ? 'false' : 'true')
}

tabDraft.addEventListener('click', () => {
  cardFilter = 'draft'
  applyCardFilter()
})
tabDone.addEventListener('click', () => {
  cardFilter = 'done'
  applyCardFilter()
})

function cardSettled(card) {
  const needsReturn = !card.moysklad?.id
  const needsPayout = card.document?.kind === 'demand' && card.compensation === 'cash' && !card.payout?.id
  return card.status === 'confirmed' && !needsReturn && !needsPayout
}

function returnCard(card) {
  const article = document.createElement('article')
  article.className = 'panel return-card'
  const head = document.createElement('div')
  head.className = 'return-card-head'
  const id = document.createElement('div')
  id.className = 'return-id'
  const when = document.createElement('span')
  when.className = 'sale-date'
  when.textContent = savedLabel(card.createdAt)
  id.append(when)
  if (card.document?.href) {
    const link = document.createElement('a')
    link.className = 'sale-number'
    link.href = card.document.href
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = card.document.name || 'без номера'
    id.append(link)
  }
  if (card.document?.label) id.append(pill(card.document.label))
  const confirmed = cardSettled(card)
  id.append(pill(confirmed ? 'в МоёмСкладе' : 'новая', confirmed ? 'is-ok' : 'is-warn'))
  const side = document.createElement('div')
  side.className = 'return-card-side'
  const amount = document.createElement('b')
  amount.textContent = formatMoney(card.amount)
  const tools = document.createElement('div')
  tools.className = 'return-tools'
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn'
  remove.textContent = confirmed ? 'Удалить' : 'Отменить'
  remove.addEventListener('click', () => deleteCard(card.id, remove))
  tools.append(remove)
  if (!confirmed) {
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'btn btn-primary'
    confirm.textContent = 'Провести'
    confirm.addEventListener('click', () => confirmCard(card, confirm))
    tools.append(confirm)
  }
  side.append(amount, tools)
  head.append(id, side)
  article.append(head)
  const buyer = clientBlock({
    agent: card.document?.agent,
    phone: card.document?.phone,
    email: card.document?.email,
    siteOrder: card.document?.siteOrder,
    paymentType: card.document?.paymentType,
  })
  if (buyer) article.append(buyer)
  else if (card.document?.agent) {
    const name = document.createElement('div')
    name.className = 'sale-client-name'
    name.textContent = card.document.agent
    article.append(name)
  }
  const lines = document.createElement('div')
  lines.className = 'card-lines'
  for (const line of card.lines || []) {
    const row = document.createElement('div')
    row.className = 'card-line'
    const title = document.createElement('span')
    title.textContent = lineLabel(line)
    const qty = document.createElement('b')
    qty.textContent = `${quantityFormat.format(line.quantity)} × ${formatMoney(line.sum)}`
    row.append(title, qty)
    lines.append(row)
  }
  const facts = document.createElement('div')
  facts.className = 'return-facts'
  for (const text of [card.reasonLabel, card.compensationLabel, card.document?.orderName ? `Заказ ${card.document.orderName}` : '']) {
    if (!text) continue
    facts.append(pill(text))
  }
  if (card.compensationNote) {
    const requisites = document.createElement('p')
    requisites.className = 'return-requisites'
    requisites.textContent = card.compensationNote
    facts.append(requisites)
  }
  if (card.moysklad?.href) {
    const back = document.createElement('a')
    back.className = 'pill'
    back.href = card.moysklad.href
    back.target = '_blank'
    back.rel = 'noreferrer'
    back.textContent = card.moysklad.name ? `Возврат ${card.moysklad.name}` : 'Возврат'
    facts.append(back)
  }
  if (card.payout?.href) {
    const payout = document.createElement('a')
    payout.className = 'pill'
    payout.href = card.payout.href
    payout.target = '_blank'
    payout.rel = 'noreferrer'
    payout.textContent = card.payout.name ? `Выплата ${card.payout.name}` : 'Выплата'
    facts.append(payout)
  }
  const more = cardMore(card, lines, facts, card.photos?.length ? cardPhotos(card) : null)
  if (more) article.append(more)
  return article
}

function cardMore(card, lines, facts, photos) {
  const lineCount = lines.childElementCount
  const photoCount = card.photos?.length || 0
  const parts = []
  if (lineCount) parts.push(`${lineCount} ${plural(lineCount, 'позиция', 'позиции', 'позиций')}`)
  if (photoCount) parts.push(`${photoCount} ${plural(photoCount, 'фото', 'фото', 'фото')}`)
  if (!parts.length && facts.childElementCount) parts.push('Подробности')
  if (!parts.length) return null
  const details = document.createElement('details')
  details.className = 'card-more'
  const summary = document.createElement('summary')
  summary.textContent = parts.join(' · ')
  details.append(summary)
  if (lineCount) details.append(lines)
  if (facts.childElementCount) details.append(facts)
  if (photos) details.append(photos)
  return details
}

function cardPhotos(card) {
  const box = document.createElement('div')
  box.className = 'card-photos'
  for (const photo of card.photos) {
    const item = document.createElement('figure')
    item.className = 'card-photo'
    const image = document.createElement('img')
    image.src = `/sales/api/returns/${encodeURIComponent(card.id)}/files/${encodeURIComponent(photo.id)}`
    image.alt = PHOTO_LABELS.get(photo.slot) || 'Фото'
    const caption = document.createElement('figcaption')
    caption.textContent = image.alt
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'card-photo-open'
    open.setAttribute('aria-label', image.alt)
    open.append(image)
    open.addEventListener('click', () => openPhoto(image.src, image.alt))
    item.append(open, caption)
    box.append(item)
  }
  return box
}

function openPhoto(src, alt) {
  closePhotoView?.()
  const back = document.createElement('div')
  back.className = 'photo-view'
  const closer = document.createElement('button')
  closer.type = 'button'
  closer.className = 'modal-x'
  closer.setAttribute('aria-label', 'Закрыть')
  closer.textContent = '×'
  const image = document.createElement('img')
  image.src = src
  image.alt = alt
  back.append(closer, image)
  const close = () => {
    back.remove()
    if (closePhotoView === close) closePhotoView = null
  }
  closer.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
  })
  back.addEventListener('click', (event) => {
    if (event.target === back) close()
  })
  document.body.append(back)
  closePhotoView = close
}
