import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildReturnCard } from '../src/cards.js'
import { returnDocumentHtml } from '../src/return-document.js'
import { decodeReturnImage, saveReturnPhotos } from '../src/return-files.js'

test('a return card keeps the compensation', () => {
  const card = buildReturnCard({
    id: 'card-2',
    reason: 'extra',
    compensation: 'cash',
    document: { id: 'd1', kind: 'demand', name: '06108', moment: '2026-11-12 12:00:00', sum: 7000 },
    lines: [{ name: 'Изолента', code: '32506557', quantity: 1, price: 70, sum: 70, assortmentHref: 'https://api/p' }],
    requested: [{ code: '32506557', quantity: 1 }],
    photos: [{ id: 'file-1', slot: 'mounts', name: 'крепление.jpg' }],
  })
  assert.equal(card.compensation, 'cash')
  assert.equal(card.compensationLabel, 'Наличные')
  assert.equal(card.photos[0].slot, 'mounts')
})

test('return photos are stored as files and unknown data is skipped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'returns-'))
  const bytes = Buffer.alloc(48, 7)
  const saved = await saveReturnPhotos(root, 'card-9', [
    { slot: 'overview', name: 'план.jpg', data: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    { slot: 'other', name: 'нет.jpg', data: `data:image/jpeg;base64,${bytes.toString('base64')}` },
    { slot: 'terminals', name: 'нет.txt', data: 'data:text/plain;base64,YQ==' },
  ])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].slot, 'overview')
  assert.equal(readFileSync(join(root, 'card-9', `${saved[0].id}.jpg`)).length, 48)
  assert.equal(decodeReturnImage('data:text/plain;base64,YQ=='), null)
})

test('the return document names the reason, the compensation and the photos', () => {
  const html = returnDocumentHtml({
    createdAt: '2026-11-12T12:00:00.000Z',
    reasonLabel: 'Лишний товар',
    compensationLabel: 'Безнал',
    compensationNote: 'отмена рассрочки',
    amount: 70,
    document: { label: 'Отгрузка', name: '06108', agent: 'ИП Кокорин' },
    lines: [{ name: 'Изолента', article: '', code: '32506557', quantity: 1, sum: 70 }],
  }, [{ slot: 'overview', dataUrl: 'data:image/jpeg;base64,QQ==' }])
  assert.match(html, /Лишний товар/)
  assert.match(html, /Безнал/)
  assert.match(html, /отмена рассрочки/)
  assert.match(html, /Общий план с упаковкой/)
  assert.match(html, /ИП Кокорин/)
})
