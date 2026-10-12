import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MONTH = /^\d{4}-\d{2}$/

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS month_reports (
      month TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `)
  const write = db.prepare(`
    INSERT INTO month_reports (month, saved_at, report_json)
    VALUES (?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      saved_at = excluded.saved_at,
      report_json = excluded.report_json
  `)
  const read = db.prepare('SELECT saved_at, report_json FROM month_reports WHERE month = ?')
  const readYear = db.prepare(
    'SELECT month, saved_at, report_json FROM month_reports WHERE month >= ? AND month <= ? ORDER BY month',
  )

  return {
    save(report, savedAt = new Date().toISOString()) {
      const month = String(report?.month ?? '')
      if (!MONTH.test(month)) throw new Error('Месяц укажите в формате ГГГГ-ММ')
      write.run(month, savedAt, JSON.stringify(report))
      return { month, savedAt }
    },
    get(month) {
      if (!MONTH.test(String(month ?? ''))) return null
      const row = read.get(String(month))
      if (!row) return null
      try {
        return { savedAt: row.saved_at, report: JSON.parse(row.report_json) }
      } catch {
        return null
      }
    },
    list(year) {
      const value = String(year ?? '')
      if (!/^\d{4}$/.test(value)) return []
      return readYear.all(`${value}-01`, `${value}-12`).flatMap((row) => {
        try {
          const stats = JSON.parse(row.report_json).stats || {}
          return [{
            month: row.month,
            savedAt: row.saved_at,
            sales: finiteNumber(stats.sales),
            profit: finiteNumber(stats.profit),
            averageMarkup: finiteNumber(stats.averageMarkup),
            missed: finiteNumber(stats.missed),
          }]
        } catch {
          return []
        }
      })
    },
    close() {
      db.close()
    },
  }
}
