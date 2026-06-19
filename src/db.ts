import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { PinnedDocument, ListResult, SearchResult } from './types.js';

const DEFAULT_DB = join(homedir(), '.document-pinboard', 'pins.db');

export class DocumentDB {
  private db: Database.Database;

  constructor(dbPath = DEFAULT_DB) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  // ─── Schema ─────────────────────────────────────────────────────────────────

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        source       TEXT NOT NULL,
        source_type  TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content      TEXT NOT NULL DEFAULT '',
        summary      TEXT NOT NULL DEFAULT '',
        tags         TEXT NOT NULL DEFAULT '[]',
        collection   TEXT,
        metadata     TEXT NOT NULL DEFAULT '{}',
        pinned_at    TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      -- FTS5: виртуальная таблица для полнотекстового поиска
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        title, content, summary, tags,
        content="docs",
        content_rowid="rowid"
      );

      -- Автоматическое обновление FTS через триггеры
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid, title, content, summary, tags)
        VALUES (new.rowid, new.title, new.content, new.summary, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, content, summary, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.summary, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts, rowid, title, content, summary, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.summary, old.tags);
        INSERT INTO docs_fts(rowid, title, content, summary, tags)
        VALUES (new.rowid, new.title, new.content, new.summary, new.tags);
      END;
    `);
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  insert(doc: PinnedDocument): PinnedDocument {
    this.db.prepare(`
      INSERT INTO docs VALUES (
        @id, @title, @source, @source_type, @content_type,
        @content, @summary, @tags, @collection, @metadata,
        @pinned_at, @updated_at
      )
    `).run(this.serialize(doc));
    return doc;
  }

  update(id: string, patch: Partial<PinnedDocument>): PinnedDocument | null {
    const cur = this.getById(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.db.prepare(`
      UPDATE docs SET
        title=@title, content_type=@content_type, content=@content,
        summary=@summary, tags=@tags, collection=@collection,
        metadata=@metadata, updated_at=@updated_at
      WHERE id=@id
    `).run(this.serialize(next));
    return next;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM docs WHERE id=?').run(id).changes > 0;
  }

  getById(id: string): PinnedDocument | null {
    const row = this.db.prepare('SELECT * FROM docs WHERE id=?').get(id);
    return row ? this.deserialize(row as Record<string, unknown>) : null;
  }

  // ─── Query ──────────────────────────────────────────────────────────────────

  list(opts: {
    collection?: string | null;
    tags?: string[];
    content_type?: string;
    limit?: number;
    offset?: number;
  } = {}): ListResult {
    const { collection, tags, content_type, limit = 20, offset = 0 } = opts;
    const conds: string[] = [];
    const params: unknown[] = [];

    if (collection !== undefined) { conds.push('collection IS ?'); params.push(collection); }
    if (content_type)             { conds.push('content_type=?'); params.push(content_type); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    let rows = this.db
      .prepare(`SELECT * FROM docs ${where} ORDER BY pinned_at DESC`)
      .all(...params) as Record<string, unknown>[];

    // Фильтрация по тегам (AND-логика)
    if (tags?.length) {
      rows = rows.filter(r => {
        const dt = JSON.parse(r.tags as string) as string[];
        return tags.every(t => dt.includes(t));
      });
    }

    return {
      total: rows.length,
      offset,
      limit,
      items: rows.slice(offset, offset + limit).map(r => this.deserialize(r)),
    };
  }

  search(query: string, opts: {
    collection?: string;
    tags?: string[];
    content_type?: string;
    limit?: number;
  } = {}): SearchResult[] {
    const { collection, tags, content_type, limit = 10 } = opts;

    // FTS5 MATCH с ранжированием по BM25
    const rows = this.db.prepare(`
      SELECT docs.*, fts.rank
      FROM docs_fts fts
      JOIN docs ON docs.rowid = fts.rowid
      WHERE docs_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `).all(query, limit * 4) as Record<string, unknown>[];

    let results: SearchResult[] = rows.map(r => ({
      ...this.deserialize(r),
      rank: r.rank as number,
    }));

    if (collection)   results = results.filter(d => d.collection === collection);
    if (content_type) results = results.filter(d => d.content_type === content_type);
    if (tags?.length) results = results.filter(d => tags.every(t => d.tags.includes(t)));

    return results.slice(0, limit);
  }

  listCollections(): { name: string; count: number }[] {
    return this.db.prepare(`
      SELECT collection AS name, COUNT(*) AS count
      FROM docs WHERE collection IS NOT NULL
      GROUP BY collection ORDER BY count DESC
    `).all() as { name: string; count: number }[];
  }

  listTags(): { name: string; count: number }[] {
    const rows = this.db.prepare('SELECT tags FROM docs').all() as { tags: string }[];
    const map = new Map<string, number>();
    for (const { tags } of rows) {
      for (const t of JSON.parse(tags) as string[]) {
        map.set(t, (map.get(t) ?? 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private serialize(doc: PinnedDocument): Record<string, unknown> {
    return { ...doc, tags: JSON.stringify(doc.tags), metadata: JSON.stringify(doc.metadata) };
  }

  private deserialize(row: Record<string, unknown>): PinnedDocument {
    return {
      ...row,
      tags:     JSON.parse(row.tags     as string) as string[],
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    } as PinnedDocument;
  }

  close() { this.db.close(); }
}
