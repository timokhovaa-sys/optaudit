import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accessSync, constants } from 'node:fs'

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function amount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)
}

function compact(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const abs = Math.abs(number)
  const scaled = abs >= 1_000_000 ? number / 1_000_000 : abs >= 10_000 ? number / 1_000 : number
  const suffix = abs >= 1_000_000 ? ' млн' : abs >= 10_000 ? ' тыс.' : ''
  const rounded = Math.round(scaled * 10) / 10
  const digits = Math.abs(rounded - Math.round(rounded)) < 0.05 ? 0 : 1
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded)}${suffix}`
}

function dateLabel(moment) {
  const [date, time = ''] = String(moment || '').split(' ')
  const [year, month, day] = date.split('-')
  if (!day || !month || !year) return 'без даты'
  return `${day}.${month}.${year}${time ? ` ${time.slice(0, 5)}` : ''}`
}

const PDF_SERIES = [
  { id: 'sales', key: 'sales', documentKey: 'sales', label: 'Продажи', unit: 'money', color: '#1c1f26' },
  { id: 'markup', key: 'averageMarkup', documentKey: 'markup', label: 'Наценка', unit: 'percent', color: '#2f9e57' },
  { id: 'profit', key: 'profit', documentKey: 'profit', label: 'Прибыль', unit: 'money', color: '#b7791f' },
  { id: 'net', key: 'netProfit', documentKey: 'netProfit', label: 'Чистая прибыль', unit: 'money', color: '#1d4e89' },
  { id: 'missed', key: 'missed', documentKey: 'missed', label: 'Упущено', unit: 'money', color: '#d64545' },
]

function percentLabel(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(number)} %`
}

function finiteOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function chosenSeries(ids) {
  const wanted = new Set((ids || []).map(String))
  const series = PDF_SERIES.filter((item) => wanted.has(item.id))
  return series.length ? series : [PDF_SERIES[0]]
}

function salesChart(months, year, series, threshold) {
  const byMonth = new Map((months || []).map((row) => [row.month, row]))
  const points = MONTHS.map((_, index) => byMonth.get(`${year}-${String(index + 1).padStart(2, '0')}`) || null)
  const money = series.filter((item) => item.unit === 'money')
  const percent = series.filter((item) => item.unit === 'percent')
  const moneyValues = points.flatMap((point) => point ? money.map((item) => finiteOrNull(point[item.key])) : [])
  const percentValues = points.flatMap((point) => point ? percent.map((item) => finiteOrNull(point[item.key])) : [])
  if (percent.length && Number.isFinite(threshold)) percentValues.push(threshold)
  const moneyExtent = extent(moneyValues)
  const percentExtent = extent(percentValues)
  const width = 1000
  const height = 250 + money.length * 12
  const left = percent.length && !money.length ? 48 : 16
  const right = money.length && percent.length ? 48 : 16
  const top = 8 + Math.max(money.length, 1) * 13
  const bottom = 28
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const slot = plotWidth / 12
  const yOf = (value, box) => {
    const span = box.max - box.min || 1
    return top + (1 - (value - box.min) / span) * plotHeight
  }
  const parts = []
  if (money.length) {
    const inner = slot * 0.72
    const barWidth = inner / money.length
    points.forEach((point, index) => {
      if (!point) return
      let labelY = 12
      money.forEach((item, seriesIndex) => {
        const value = finiteOrNull(point[item.key])
        if (value == null) return
        const barHeight = Math.max(Math.abs(yOf(value, moneyExtent) - yOf(0, moneyExtent)), 1)
        const y = Math.min(yOf(value, moneyExtent), yOf(0, moneyExtent))
        const x = left + index * slot + (slot - inner) / 2 + seriesIndex * barWidth
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barWidth - 2, 1).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${item.color}"></rect>`)
        parts.push(`<text x="${(left + index * slot + 2).toFixed(1)}" y="${labelY}" fill="${item.color}" font-size="10" font-weight="700">${escapeHtml(compact(value))}</text>`)
        labelY += 12
      })
    })
  }
  if (percent.length) {
    const item = percent[0]
    const coords = []
    points.forEach((point, index) => {
      const value = point ? finiteOrNull(point[item.key]) : null
      if (value == null) {
        if (coords.length > 1) {
          parts.push(`<polyline points="${coords.join(' ')}" fill="none" stroke="${item.color}" stroke-width="2.5"></polyline>`)
        }
        coords.length = 0
        return
      }
      const x = left + (index + 0.5) * slot
      const y = yOf(value, percentExtent)
      coords.push(`${x.toFixed(1)},${y.toFixed(1)}`)
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${item.color}" stroke="#fff" stroke-width="1.5"></circle>`)
    })
    if (coords.length > 1) {
      parts.push(`<polyline points="${coords.join(' ')}" fill="none" stroke="${item.color}" stroke-width="2.5"></polyline>`)
    }
    if (Number.isFinite(threshold)) {
      const y = yOf(threshold, percentExtent)
      parts.push(`<line x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#15803d" stroke-width="1.5" stroke-dasharray="5 4"></line>`)
      parts.push(`<text x="${left + 6}" y="${(y - 6).toFixed(1)}" fill="#15803d" font-size="11">порог ${escapeHtml(percentLabel(threshold))}</text>`)
    }
  }
  MONTHS.forEach((name, index) => {
    const x = left + (index + 0.5) * slot
    parts.push(`<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="#8b919c" font-size="11">${name}</text>`)
  })
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Показатели по месяцам">${parts.join('')}</svg>`
}

function extent(values) {
  const nums = values.filter((value) => value != null && Number.isFinite(value))
  if (!nums.length) return { min: 0, max: 1 }
  const min = Math.min(0, ...nums)
  const max = Math.max(0, ...nums)
  if (min === max) return { min, max: max === 0 ? 1 : max * 1.12 }
  const pad = (max - min) * 0.12
  return { min: min < 0 ? min - pad : min, max: max + pad }
}

function cell(series, row) {
  const value = finiteOrNull(row[series.documentKey])
  if (series.id === 'sales' && value == null) return amount(row.sum)
  if (value == null) return '—'
  return series.unit === 'percent' ? percentLabel(value) : amount(value)
}

function totalCell(series, rows) {
  if (series.unit !== 'money') return '—'
  const numbers = rows.map((row) => finiteOrNull(row[series.documentKey])).filter((value) => value != null)
  if (!numbers.length && series.id === 'sales') {
    return amount(rows.reduce((sum, row) => sum + (Number(row.sum) || 0), 0))
  }
  if (!numbers.length) return '—'
  return amount(numbers.reduce((sum, value) => sum + value, 0))
}

export function salesReportHtml({ agentName, year, months, documents, series, threshold }) {
  const rows = Array.isArray(documents) ? documents : []
  const active = chosenSeries(series)
  const head = active.map((item) => `<th class="sum">${escapeHtml(item.label)}</th>`).join('')
  const body = rows.map((row) => `<tr>
      <td>${escapeHtml(dateLabel(row.moment))}</td>
      <td>${escapeHtml(row.name || '—')}</td>
      ${active.map((item) => `<td class="sum">${escapeHtml(cell(item, row))}</td>`).join('')}
    </tr>`).join('')
  const foot = active.map((item) => `<td class="sum">${escapeHtml(totalCell(item, rows))}</td>`).join('')
  const empty = rows.length ? '' : '<p class="empty">За этот год отгрузок и продаж нет.</p>'
  const limit = finiteOrNull(threshold)
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(agentName)} · ${escapeHtml(year)}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1c1f26; font: 13px/1.4 "Segoe UI", sans-serif; }
    h1 { margin: 0 0 2px; font-size: 22px; letter-spacing: -0.03em; }
    p.lead { margin: 0 0 12px; color: #5c6570; }
    svg { display: block; width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th, td { padding: 5px 8px; border-bottom: 1px solid #e6e8ee; text-align: left; vertical-align: top; }
    th { font-size: 11px; color: #5c6570; font-weight: 600; }
    td.sum, th.sum { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-bottom: 0; }
    tr { break-inside: avoid; }
    .empty { color: #5c6570; }
  </style>
</head>
<body>
  <h1>${escapeHtml(agentName || 'Клиент')}</h1>
  <p class="lead">${escapeHtml(year)}. ${escapeHtml(active.map((item) => item.label).join(', '))}.</p>
  ${salesChart(months, year, active, limit)}
  ${empty}
  <table>
    <thead>
      <tr><th>Дата</th><th>Номер</th>${head}</tr>
    </thead>
    <tbody>${body}</tbody>
    <tfoot>
      <tr><td colspan="2">Итого</td>${foot}</tr>
    </tfoot>
  </table>
</body>
</html>`
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      accessSync(file, constants.F_OK)
      return file
    } catch {
      /* next candidate */
    }
  }
  return null
}

export async function renderSalesPdf(html) {
  const chrome = chromePath()
  if (!chrome) throw Object.assign(new Error('Не найден Chrome для сборки PDF'), { statusCode: 500 })
  const dir = await mkdtemp(join(tmpdir(), 'mc-pdf-'))
  const htmlFile = join(dir, 'report.html')
  const pdfFile = join(dir, 'report.pdf')
  try {
    await writeFile(htmlFile, html, 'utf8')
    await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        '--headless',
        '--disable-gpu',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfFile}`,
        pathToFileURL(htmlFile).href,
      ], { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        reject(Object.assign(new Error('Сборка PDF прервалась по времени'), { statusCode: 500 }))
      }, 30000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(Object.assign(new Error('Не удалось собрать PDF'), { statusCode: 500 }))
      })
    })
    return await readFile(pdfFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function salesPdfPayload(body) {
  const year = Number(body?.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw Object.assign(new Error('Год укажите в формате ГГГГ'), { statusCode: 400 })
  }
  const agentName = String(body?.agentName || '').trim().slice(0, 200) || 'Клиент'
  const months = (Array.isArray(body?.months) ? body.months : []).slice(0, 12).map((row) => ({
    month: String(row?.month || '').slice(0, 7),
    sales: Number(row?.sales) || 0,
    profit: Number(row?.profit) || 0,
    netProfit: Number(row?.netProfit) || 0,
    averageMarkup: finiteOrNull(row?.averageMarkup),
    missed: Number(row?.missed) || 0,
  })).filter((row) => /^\d{4}-\d{2}$/.test(row.month))
  const documents = (Array.isArray(body?.documents) ? body.documents : []).slice(0, 5000).map((row) => ({
    moment: String(row?.moment || '').slice(0, 19),
    name: String(row?.name || '').slice(0, 80),
    sum: Number(row?.sum) || 0,
    sales: finiteOrNull(row?.sales),
    profit: finiteOrNull(row?.profit),
    netProfit: finiteOrNull(row?.netProfit),
    markup: finiteOrNull(row?.markup),
    missed: finiteOrNull(row?.missed),
  }))
  const series = chosenSeries(body?.series).map((item) => item.id)
  const threshold = finiteOrNull(body?.threshold)
  return { agentName, year, months, documents, series, threshold }
}
