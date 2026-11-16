import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openReturnStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS return_cards (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      card_json TEXT NOT NULL
    );
  `)
  const write = db.prepare(`
    INSERT INTO return_cards (id, created_at, card_json)
    VALUES (?, ?, ?)
  `)
  const read = db.prepare(`
    SELECT card_json FROM return_cards
    ORDER BY created_at DESC, id DESC
  `)
  const one = db.prepare('SELECT card_json FROM return_cards WHERE id = ?')
  const replace = db.prepare('UPDATE return_cards SET card_json = ? WHERE id = ?')
  const remove = db.prepare('DELETE FROM return_cards WHERE id = ?')

  return {
    save(card) {
      write.run(card.id, card.createdAt, JSON.stringify(card))
      return card
    },
    list() {
      return read.all().flatMap((row) => {
        try {
          return [JSON.parse(row.card_json)]
        } catch {
          return []
        }
      })
    },
    get(id) {
      const row = one.get(String(id || ''))
      if (!row) return null
      try {
        return JSON.parse(row.card_json)
      } catch {
        return null
      }
    },
    update(card) {
      return replace.run(JSON.stringify(card), card.id).changes > 0
    },
    remove(id) {
      return remove.run(String(id || '')).changes > 0
    },
    close() {
      db.close()
    },
  }
}
