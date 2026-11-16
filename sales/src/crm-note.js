export function crmNote(card) {
  const doc = card?.document || {}
  const lines = ['Возврат через CRM.']
  const order = String(doc.orderName || '').trim()
  if (order) lines.push(`Заказ ${order}`)
  const orderHref = String(doc.orderHref || '').trim()
  if (orderHref) lines.push(orderHref)
  const name = String(doc.name || '').trim()
  if (name) lines.push(`${doc.label || (doc.kind === 'retaildemand' ? 'Продажа' : 'Отгрузка')} ${name}`)
  const href = String(doc.href || '').trim()
  if (href) lines.push(href)
  const reason = String(card?.reasonLabel || '').trim()
  if (reason) lines.push(reason)
  const note = String(card?.compensationNote || '').trim()
  if (note) lines.push(note)
  return lines.join('\n')
}

export function payoutComment(card) {
  const lines = [crmNote(card)]
  const name = String(card?.moysklad?.name || '').trim()
  const href = String(card?.moysklad?.href || '').trim()
  if (name) lines.push(`Возврат ${name}`)
  if (href) lines.push(href)
  return lines.filter(Boolean).join('\n')
}
