import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type {
  Connection, Fact, Relation, GraphNode, DEFAULT_STRENGTH,
} from './graph-types.js';

const DEFAULT_DB = join(homedir(), '.document-pinboard', 'pins.db');

export class GraphDB {
  protected db: Database.Database;

  constructor(dbPath = DEFAULT_DB) {
    // Открываем тот же файл, что и DocumentDB — SQLite в WAL-режиме
    // допускает несколько читателей и одного писателя
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
      -- Типизированные связи (рёбра графа)
      CREATE TABLE IF NOT EXISTS connections (
        id         TEXT PRIMARY KEY,
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        relation   TEXT NOT NULL,
        strength   REAL NOT NULL DEFAULT 0.5,
        note       TEXT,
        source     TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        FOREIGN KEY (from_id) REFERENCES docs(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id)   REFERENCES docs(id) ON DELETE CASCADE,
        UNIQUE (from_id, to_id, relation) ON CONFLICT REPLACE
      );
      CREATE INDEX IF NOT EXISTS idx_conn_from ON connections(from_id);
      CREATE INDEX IF NOT EXISTS idx_conn_to   ON connections(to_id);
      CREATE INDEX IF NOT EXISTS idx_conn_rel  ON connections(relation);

      -- Реестр именованных сущностей
      CREATE TABLE IF NOT EXISTS entities (
        name   TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        count  INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (name, doc_id),
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ent_name  ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_ent_doc   ON entities(doc_id);

      -- Атомарные факты (claims), извлечённые из документов
      CREATE TABLE IF NOT EXISTS facts (
        id         TEXT PRIMARY KEY,
        doc_id     TEXT NOT NULL,
        claim      TEXT NOT NULL,
        entities   TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 1.0,
        span       TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_facts_doc ON facts(doc_id);
    `);
  }

  // ─── Connections ─────────────────────────────────────────────────────────────

  addConnection(c: Omit<Connection, 'id' | 'created_at'>): Connection {
    const conn: Connection = {
      ...c,
      id:         uuidv4(),
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO connections (id, from_id, to_id, relation, strength, note, source, created_at)
      VALUES (@id, @from_id, @to_id, @relation, @strength, @note, @source, @created_at)
    `).run(conn);
    return conn;
  }

  getConnections(docId: string, opts: {
    direction?:  'outbound' | 'inbound' | 'both';
    minStrength?: number;
    relations?:  string[];
    limit?:      number;
  } = {}): (Connection & { other_title: string; other_type: string })[] {
    const { direction = 'both', minStrength = 0, relations, limit = 100 } = opts;

    let whereParts = ['c.strength >= @minStrength'];
    if (direction === 'outbound') whereParts.push('c.from_id = @docId');
    else if (direction === 'inbound') whereParts.push('c.to_id = @docId');
    else whereParts.push('(c.from_id = @docId OR c.to_id = @docId)');

    if (relations?.length) {
      const rels = relations.map(r => `'${r.replace(/'/g, "''")}'`).join(',');
      whereParts.push(`c.relation IN (${rels})`);
    }

    const rows = this.db.prepare(`
      SELECT c.*,
        CASE WHEN c.from_id = @docId THEN dt.title ELSE df.title END AS other_title,
        CASE WHEN c.from_id = @docId THEN dt.content_type ELSE df.content_type END AS other_type
      FROM connections c
      JOIN docs df ON df.id = c.from_id
      JOIN docs dt ON dt.id = c.to_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY c.strength DESC
      LIMIT @limit
    `).all({ docId, minStrength, limit }) as (Connection & { other_title: string; other_type: string })[];

    return rows;
  }

  deleteConnection(id: string): boolean {
    return this.db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
  }

  // ─── Graph Traversal (BFS) ───────────────────────────────────────────────────

  traverse(startId: string, opts: {
    maxDepth?:   number;
    minStrength?: number;
    direction?:  'outbound' | 'inbound' | 'both';
    relations?:  string[];
  } = {}): GraphNode[] {
    const { maxDepth = 2, minStrength = 0, direction = 'both', relations } = opts;

    const visited = new Set<string>([startId]);
    const result:  GraphNode[] = [];
    const queue:   Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      const docRow = this.db.prepare(
        'SELECT id, title, content_type FROM docs WHERE id = ?'
      ).get(id) as { id: string; title: string; content_type: string } | undefined;

      if (!docRow) continue;

      const connections = this.getConnections(id, { direction, minStrength, relations });

      result.push({
        doc_id:       docRow.id,
        title:        docRow.title,
        content_type: docRow.content_type,
        depth,
        connections,
      });

      if (depth < maxDepth) {
        for (const conn of connections) {
          const nextId = conn.from_id === id ? conn.to_id : conn.from_id;
          if (!visited.has(nextId)) {
            visited.add(nextId);
            queue.push({ id: nextId, depth: depth + 1 });
          }
        }
      }
    }

    return result;
  }

  // ─── Entities ────────────────────────────────────────────────────────────────

  addEntities(docId: string, entities: string[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO entities (name, doc_id, count) VALUES (@name, @docId, 1)
      ON CONFLICT(name, doc_id) DO UPDATE SET count = count + 1
    `);
    const tx = this.db.transaction((names: string[]) => {
      for (const raw of names) {
        const name = raw.toLowerCase().trim();
        if (name.length > 1) upsert.run({ name, docId });
      }
    });
    tx(entities);
  }

  findDocsByEntity(entityName: string): { doc_id: string; title: string; count: number }[] {
    return this.db.prepare(`
      SELECT e.doc_id, d.title, e.count
      FROM entities e
      JOIN docs d ON d.id = e.doc_id
      WHERE e.name = ?
      ORDER BY e.count DESC, d.pinned_at DESC
    `).all(entityName.toLowerCase().trim()) as { doc_id: string; title: string; count: number }[];
  }

  getDocEntities(docId: string): string[] {
    const rows = this.db.prepare(
      'SELECT name FROM entities WHERE doc_id = ? ORDER BY count DESC'
    ).all(docId) as { name: string }[];
    return rows.map(r => r.name);
  }

  /**
   * Найти похожие документы по пересечению сущностей (Jaccard similarity).
   * Используется для авто-создания слабых связей similar_to / shares_topic.
   */
  findSimilarByEntities(docId: string, opts: {
    topN?:        number;
    minJaccard?:  number;
  } = {}): { doc_id: string; title: string; jaccard: number; shared: string[] }[] {
    const { topN = 10, minJaccard = 0.05 } = opts;

    const myEntities = this.getDocEntities(docId);
    if (myEntities.length === 0) return [];

    const placeholders = myEntities.map(() => '?').join(',');
    const candidates = this.db.prepare(`
      SELECT doc_id, GROUP_CONCAT(name) AS shared_names, COUNT(*) AS overlap
      FROM entities
      WHERE name IN (${placeholders}) AND doc_id != ?
      GROUP BY doc_id
      ORDER BY overlap DESC
      LIMIT ?
    `).all(...myEntities, docId, topN * 3) as {
      doc_id: string; shared_names: string; overlap: number;
    }[];

    const mySet = new Set(myEntities);

    return candidates
      .map(c => {
        const theirEntities = this.getDocEntities(c.doc_id);
        const theirSet = new Set(theirEntities);
        const shared = myEntities.filter(e => theirSet.has(e));
        const union  = new Set([...mySet, ...theirSet]).size;
        const jaccard = union > 0 ? shared.length / union : 0;
        const doc = this.db.prepare('SELECT title FROM docs WHERE id = ?').get(c.doc_id) as { title: string } | undefined;
        return { doc_id: c.doc_id, title: doc?.title ?? '', jaccard, shared };
      })
      .filter(r => r.jaccard >= minJaccard)
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, topN);
  }

  // ─── Auto-detection ──────────────────────────────────────────────────────────

  /**
   * Сканирует текст документа на URL, которые совпадают с source других документов.
   * Создаёт автоматические cites-связи.
   */
  autoDetectCitations(docId: string): Connection[] {
    const doc = this.db.prepare(
      'SELECT content, source FROM docs WHERE id = ?'
    ).get(docId) as { content: string; source: string } | undefined;

    if (!doc) return [];

    const urlPattern = /https?:\/\/[^\s)"'>]+/g;
    const foundUrls  = doc.content.match(urlPattern) ?? [];
    const created:    Connection[] = [];

    for (const url of new Set(foundUrls)) {
      const existing = this.db.prepare(
        "SELECT id FROM docs WHERE source = ? AND id != ?"
      ).get(url, docId) as { id: string } | undefined;

      if (existing) {
        created.push(this.addConnection({
          from_id:  docId,
          to_id:    existing.id,
          relation: 'cites',
          strength: 0.9,
          note:     `Auto-detected URL: ${url.slice(0, 120)}`,
          source:   'auto-citation',
        }));
      }
    }

    return created;
  }

  /**
   * Авто-создать слабые связи на основе пересечения сущностей.
   * similar_to если Jaccard ≥ 0.25, иначе shares_topic.
   */
  autoConnectByEntities(docId: string, opts: { topN?: number; minJaccard?: number } = {}): Connection[] {
    const { topN = 10, minJaccard = 0.1 } = opts;
    const similar = this.findSimilarByEntities(docId, { topN, minJaccard });
    const created: Connection[] = [];

    for (const s of similar) {
      const relation: Relation = s.jaccard >= 0.25 ? 'similar_to' : 'shares_topic';
      created.push(this.addConnection({
        from_id:  docId,
        to_id:    s.doc_id,
        relation,
        strength: Math.min(0.6, s.jaccard * 1.5),
        note:     `Shared entities: ${s.shared.slice(0, 5).join(', ')}`,
        source:   'auto-entity',
      }));
    }

    return created;
  }

  // ─── Facts ───────────────────────────────────────────────────────────────────

  addFact(f: Omit<Fact, 'id' | 'created_at'>): Fact {
    const fact: Fact = {
      ...f,
      id:         uuidv4(),
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO facts (id, doc_id, claim, entities, confidence, span, created_at)
      VALUES (@id, @doc_id, @claim, @entities, @confidence, @span, @created_at)
    `).run({ ...fact, entities: JSON.stringify(fact.entities) });
    return fact;
  }

  getFacts(docId: string): Fact[] {
    const rows = this.db.prepare(
      'SELECT * FROM facts WHERE doc_id = ? ORDER BY confidence DESC'
    ).all(docId) as (Omit<Fact, 'entities'> & { entities: string })[];
    return rows.map(r => ({ ...r, entities: JSON.parse(r.entities) as string[] }));
  }

  /**
   * Найти факты из других документов, которые пересекаются по сущностям —
   * кандидаты на contradicts / supports.
   */
  findRelatedFacts(docId: string): { fact: Fact; doc_title: string }[] {
    const myEntities = this.getDocEntities(docId);
    if (myEntities.length === 0) return [];

    const allFacts = this.db.prepare(`
      SELECT f.*, d.title AS doc_title
      FROM facts f
      JOIN docs d ON d.id = f.doc_id
      WHERE f.doc_id != ?
    `).all(docId) as (Omit<Fact, 'entities'> & { entities: string; doc_title: string })[];

    return allFacts
      .map(r => ({
        fact: { ...r, entities: JSON.parse(r.entities) as string[] } as Fact,
        doc_title: r.doc_title,
      }))
      .filter(({ fact }) =>
        fact.entities.some(e => myEntities.includes(e))
      )
      .sort((a, b) => b.fact.confidence - a.fact.confidence)
      .slice(0, 30);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getGraphStats(): {
    nodes: number;
    edges: number;
    entities: number;
    facts: number;
    top_hubs: { doc_id: string; title: string; degree: number }[];
  } {
    const nodes    = (this.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
    const edges    = (this.db.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n;
    const entities = (this.db.prepare('SELECT COUNT(DISTINCT name) AS n FROM entities').get() as { n: number }).n;
    const facts    = (this.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;

    const top_hubs = this.db.prepare(`
      SELECT doc_id, d.title,
        COUNT(*) AS degree
      FROM (
        SELECT from_id AS doc_id FROM connections
        UNION ALL
        SELECT to_id   AS doc_id FROM connections
      )
      JOIN docs d ON d.id = doc_id
      GROUP BY doc_id
      ORDER BY degree DESC
      LIMIT 5
    `).all() as { doc_id: string; title: string; degree: number }[];

    return { nodes, edges, entities, facts, top_hubs };
  }

  close() { this.db.close(); }
}
