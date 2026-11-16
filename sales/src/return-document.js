import { PHOTO_SLOTS } from './return-files.js'

const SLOT_LABELS = new Map(PHOTO_SLOTS)

export function returnDocumentHtml(card, images) {
  const lines = (card?.lines || []).map((line) => `
    <tr>
      <td>${esc(line.name)}</td>
      <td>${esc([line.article, line.code].filter(Boolean).join(' · '))}</td>
      <td>${esc(line.quantity)}</td>
      <td>${esc(money(line.sum))}</td>
    </tr>`).join('')
  const groups = photoSections(images).map(([slot, label]) => {
    const files = (images || []).filter((image) => image.slot === slot && image.dataUrl)
    if (!files.length) return ''
    return `<section><h2>${esc(label)}</h2><div class="photos">${files.map((image) => `<img src="${image.dataUrl}" alt="${esc(label)}">`).join('')}</div></section>`
  }).join('')
  const doc = card?.document || {}
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Заявление на возврат ${esc(doc.name || '')}</title>
  <style>
    body { margin: 32px; color: #1c1f26; font: 14px/1.45 Inter, sans-serif; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 22px 0 8px; font-size: 15px; }
    p { margin: 0 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 6px 8px; border-bottom: 1px solid #e6e8ee; text-align: left; }
    .photos { display: flex; flex-wrap: wrap; gap: 8px; }
    img { width: 180px; height: 180px; object-fit: cover; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Заявление на возврат</h1>
  <p>${esc(when(card?.createdAt))}</p>
  <p><b>${esc(doc.agent || '')}</b></p>
  ${doc.phone ? `<p>${esc(doc.phone)}</p>` : ''}
  ${doc.email ? `<p>${esc(doc.email)}</p>` : ''}
  <p>${esc(doc.label || 'Документ')} ${esc(doc.name || '')}</p>
  ${doc.orderName ? `<p>Заказ ${esc(doc.orderName)}</p>` : ''}
  ${doc.siteOrder ? `<p>Сайт ${esc(doc.siteOrder)}</p>` : ''}
  <p>Причина: ${esc(card?.reasonLabel || '')}</p>
  <p>Компенсация: ${esc(card?.compensationLabel || '')}</p>
  ${card?.compensationNote ? `<p>${esc(card.compensationNote)}</p>` : ''}
  <p>Сумма: ${esc(money(card?.amount))}</p>
  <table>
    <thead><tr><th>Товар</th><th>Артикул</th><th>Количество</th><th>Сумма</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  ${groups}
</body>
</html>`
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char])
}

function money(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)
}

function when(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function slotLabel(slot) {
  return SLOT_LABELS.get(slot) || (slot === 'statement' ? 'Заявление' : '')
}

function photoSections(images) {
  const order = PHOTO_SLOTS.map(([slot]) => slot)
  for (const image of images || []) {
    if (image?.slot && !order.includes(image.slot)) order.push(image.slot)
  }
  return order.map((slot) => [slot, slotLabel(slot) || 'Фото'])
}
