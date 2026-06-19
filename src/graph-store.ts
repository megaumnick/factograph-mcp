/**
 * graph-store.ts — сохранение и загрузка графа знаний на диск
 *
 * Форматы:
 *   JSON  — полный snapshot (узлы + рёбра + факты + сущности)
 *   CSV   — только рёбра (from, to, relation, strength) — удобно для Excel
 *   DOT   — Graphviz, визуализация через `dot -Tsvg graph.dot > graph.svg`
 *
 * AUTO-SAVE:
 *   Установи AUTO_SAVE_PATH=/path/to/graph.json в .env.
 *   При запуске сервер загружает граф, при SIGINT — сохраняет.
 */
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync }                 from 'fs';
import { dirname, resolve }           from 'path';
import type { DocumentDB }            from './db.js';
import type { GraphDB }               from './graph.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface NodeRecord {
  id:           string;
  title:        string;
  source:       string;
  source_type:  string;
  content_type: string;
  summary:      string;
  tags:         string[];
  collection:   string | null;
  metadata:     Record<string, unknown>;
  pinned_at:    string;
  content?:     string;   // только при include_content: true
}

export interface EdgeRecord {
  id:         string;
  from_id:    string;
  to_id:      string;
  relation:   string;
  strength:   number;
  note:       string | null;
  source:     string;
  created_at: string;
}

export interface FactRecord {
  id:         string;
  doc_id:     string;
  claim:      string;
  entities:   string[];
  confidence: number;
  span:       string | null;
}

export interface EntityRecord {
  name:   string;
  doc_id: string;
  count:  number;
}

export interface GraphSnapshot {
  version:     '1.0';
  exported_at: string;
  stats: {
    nodes:    number;
    edges:    number;
    facts:    number;
    entities: number;
  };
  nodes:    NodeRecord[];
  edges:    EdgeRecord[];
  facts:    FactRecord[];
  entities: EntityRecord[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

function rawDb(graphDb: GraphDB) {
  return (graphDb as any).db as import('better-sqlite3').Database;
}

// ─── SAVE ─────────────────────────────────────────────────────────────────────

export async function saveGraph(
  docDb:    DocumentDB,
  graphDb:  GraphDB,
  filePath: string,
  opts: {
    collection?:      string | null;
    include_content?: boolean;
    pretty?:          boolean;
  } = {}
): Promise<{ path: string; stats: GraphSnapshot['stats'] }> {
  const { collection, include_content = false, pretty = true } = opts;
  const abs = resolve(filePath);
  await ensureDir(abs);

  // Узлы
  const listResult = docDb.list({ collection: collection ?? undefined, limit: 100_000 });
  const nodes: NodeRecord[] = listResult.items.map(d => ({
    id: d.id, title: d.title, source: d.source, source_type: d.source_type,
    content_type: d.content_type, summary: d.summary, tags: d.tags,
    collection: d.collection, metadata: d.metadata, pinned_at: d.pinned_at,
    ...(include_content ? { content: d.content } : {}),
  }));
  const nodeIds = new Set(nodes.map(n => n.id));

  // Рёбра (только между включёнными узлами)
  const allEdges = rawDb(graphDb).prepare(
    'SELECT id, from_id, to_id, relation, strength, note, source, created_at FROM connections ORDER BY created_at'
  ).all() as EdgeRecord[];
  const edges = allEdges.filter(e => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));

  // Факты
  const factsRaw = rawDb(graphDb).prepare(
    'SELECT id, doc_id, claim, entities, confidence, span FROM facts'
  ).all() as (Omit<FactRecord, 'entities'> & { entities: string })[];
  const facts: FactRecord[] = factsRaw
    .filter(f => nodeIds.has(f.doc_id))
    .map(f => ({ ...f, entities: JSON.parse(f.entities) as string[] }));

  // Сущности
  const entRaw = rawDb(graphDb).prepare(
    'SELECT name, doc_id, count FROM entities ORDER BY doc_id, count DESC'
  ).all() as EntityRecord[];
  const entities = entRaw.filter(e => nodeIds.has(e.doc_id));

  const snapshot: GraphSnapshot = {
    version:     '1.0',
    exported_at: new Date().toISOString(),
    stats:       { nodes: nodes.length, edges: edges.length, facts: facts.length, entities: entities.length },
    nodes, edges, facts, entities,
  };

  await writeFile(abs, pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot), 'utf-8');
  return { path: abs, stats: snapshot.stats };
}

// ─── LOAD ─────────────────────────────────────────────────────────────────────

export interface LoadResult {
  nodes_added:   number;
  edges_added:   number;
  facts_added:   number;
  nodes_skipped: number;
  edges_skipped: number;
}

export async function loadGraph(
  docDb:    DocumentDB,
  graphDb:  GraphDB,
  filePath: string,
  opts: {
    on_conflict?: 'skip' | 'overwrite';
    dry_run?:     boolean;
  } = {}
): Promise<LoadResult> {
  const { on_conflict = 'skip', dry_run = false } = opts;
  const abs = resolve(filePath);

  const raw      = await readFile(abs, 'utf-8');
  const snapshot = JSON.parse(raw) as GraphSnapshot;

  if (snapshot.version !== '1.0')
    throw new Error(`Неизвестная версия: ${snapshot.version}`);

  let nodes_added = 0, edges_added = 0, facts_added = 0;
  let nodes_skipped = 0, edges_skipped = 0;

  if (dry_run) {
    return {
      nodes_added:   snapshot.nodes.length,
      edges_added:   snapshot.edges.length,
      facts_added:   snapshot.facts.length,
      nodes_skipped: 0,
      edges_skipped: 0,
    };
  }

  const db = rawDb(graphDb);

  // Узлы
  for (const node of snapshot.nodes) {
    const exists = docDb.getById(node.id);
    if (exists) {
      if (on_conflict === 'skip') { nodes_skipped++; continue; }
      docDb.update(node.id, { title: node.title, tags: node.tags, collection: node.collection, summary: node.summary });
    } else {
      docDb.insert({
        ...node,
        content:      (node as any).content ?? '',
        source_type:  node.source_type  as any,
        content_type: node.content_type as any,
        updated_at:   new Date().toISOString(),
      });
      nodes_added++;
    }
  }

  // Рёбра (INSERT OR IGNORE / REPLACE)
  const edgeStmt = db.prepare(`
    INSERT OR ${on_conflict === 'overwrite' ? 'REPLACE' : 'IGNORE'}
    INTO connections (id, from_id, to_id, relation, strength, note, source, created_at)
    VALUES (@id, @from_id, @to_id, @relation, @strength, @note, @source, @created_at)
  `);
  for (const edge of snapshot.edges) {
    try { edgeStmt.run(edge); edges_added++; }
    catch { edges_skipped++; }
  }

  // Факты
  const factStmt = db.prepare(`
    INSERT OR IGNORE INTO facts (id, doc_id, claim, entities, confidence, span, created_at)
    VALUES (@id, @doc_id, @claim, @entities, @confidence, @span, @created_at)
  `);
  for (const fact of snapshot.facts) {
    try {
      factStmt.run({ ...fact, entities: JSON.stringify(fact.entities), created_at: new Date().toISOString() });
      facts_added++;
    } catch { /* skip */ }
  }

  // Сущности
  const entStmt = db.prepare(`
    INSERT OR IGNORE INTO entities (name, doc_id, count) VALUES (?, ?, ?)
  `);
  for (const ent of snapshot.entities) {
    try { entStmt.run(ent.name, ent.doc_id, ent.count); } catch { /* skip */ }
  }

  return { nodes_added, edges_added, facts_added, nodes_skipped, edges_skipped };
}

// ─── EXPORT: CSV (только рёбра) ───────────────────────────────────────────────

export async function exportEdgesCsv(
  graphDb:  GraphDB,
  filePath: string
): Promise<{ path: string; edges: number }> {
  const abs = resolve(filePath);
  await ensureDir(abs);

  const rows = rawDb(graphDb).prepare(`
    SELECT c.from_id, df.title AS from_title, c.to_id, dt.title AS to_title,
           c.relation, c.strength, c.note, c.source, c.created_at
    FROM connections c
    JOIN docs df ON df.id = c.from_id
    JOIN docs dt ON dt.id = c.to_id
    ORDER BY c.strength DESC, c.created_at
  `).all() as any[];

  const esc  = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = 'from_id,from_title,to_id,to_title,relation,strength,note,source,created_at\n';
  const body = rows.map(r =>
    [r.from_id, esc(r.from_title), r.to_id, esc(r.to_title),
     r.relation, r.strength.toFixed(4), esc(r.note ?? ''), r.source,
     r.created_at].join(',')
  ).join('\n');

  await writeFile(abs, header + body, 'utf-8');
  return { path: abs, edges: rows.length };
}

// ─── EXPORT: DOT (Graphviz) ───────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  article:   '#7F77DD', note:      '#1D9E75',
  code:      '#BA7517', data:      '#1A7AB5',
  reference: '#8B5CF6', other:     '#888780',
};
const REL_STYLE: Record<string, string> = {
  cites: 'solid',    extends:      'solid',    contradicts:   'dashed',
  is_part_of: 'solid', supports:   'dashed',   mentions:      'dashed',
  shares_topic: 'dotted', similar_to: 'dotted', relates_to: 'dotted',
  co_referenced: 'dotted',
};

export async function exportGraphDot(
  graphDb:  GraphDB,
  docDb:    DocumentDB,
  filePath: string
): Promise<{ path: string; nodes: number; edges: number }> {
  const abs = resolve(filePath);
  await ensureDir(abs);

  const docs  = docDb.list({ limit: 10_000 }).items;
  const edges = rawDb(graphDb).prepare(
    'SELECT * FROM connections ORDER BY strength DESC'
  ).all() as any[];

  const nodeLines = docs.map(d => {
    const label = d.title.replace(/"/g, '\\"').slice(0, 45);
    const color = TYPE_COLOR[d.content_type] ?? TYPE_COLOR.other;
    return `  "${d.id}" [label="${label}" style=filled fillcolor="${color}" fontcolor=white shape=box tooltip="${d.content_type}"];`;
  });

  const edgeLines = edges.map(e => {
    const style   = REL_STYLE[e.relation] ?? 'solid';
    const width   = Math.max(1, +(e.strength * 4).toFixed(1));
    const label   = e.relation;
    const color   = e.relation === 'contradicts' ? '#D85A30' : '#7F77DD';
    return `  "${e.from_id}" -> "${e.to_id}" [label="${label}" style=${style} penwidth=${width} color="${color}" fontsize=9];`;
  });

  const dot = [
    'digraph factograph {',
    '  rankdir=LR; overlap=false; splines=curved;',
    '  graph [bgcolor=transparent fontname="Helvetica"];',
    '  node  [fontname="Helvetica" fontsize=11];',
    '  edge  [fontname="Helvetica"];',
    '',
    '  // Nodes',
    ...nodeLines,
    '',
    '  // Edges',
    ...edgeLines,
    '}',
  ].join('\n');

  await writeFile(abs, dot, 'utf-8');
  return { path: abs, nodes: docs.length, edges: edges.length };
}

// ─── AUTO-SAVE lifecycle helpers ──────────────────────────────────────────────

/**
 * Вызвать при старте сервера: загружает граф если AUTO_SAVE_PATH указан
 * и файл существует.
 */
export async function autoLoad(docDb: DocumentDB, graphDb: GraphDB): Promise<void> {
  const path = process.env.AUTO_SAVE_PATH;
  if (!path || !existsSync(resolve(path))) return;
  try {
    const r = await loadGraph(docDb, graphDb, path, { on_conflict: 'skip' });
    process.stderr.write(`[graph-store] Loaded from ${path}: +${r.nodes_added} nodes, +${r.edges_added} edges\n`);
  } catch (e) {
    process.stderr.write(`[graph-store] Auto-load failed: ${e}\n`);
  }
}

/**
 * Вызвать при завершении сервера: сохраняет граф если AUTO_SAVE_PATH указан.
 */
export async function autoSave(docDb: DocumentDB, graphDb: GraphDB): Promise<void> {
  const path = process.env.AUTO_SAVE_PATH;
  if (!path) return;
  try {
    const r = await saveGraph(docDb, graphDb, path, { pretty: true });
    process.stderr.write(`[graph-store] Saved to ${r.path}: ${r.stats.nodes} nodes, ${r.stats.edges} edges\n`);
  } catch (e) {
    process.stderr.write(`[graph-store] Auto-save failed: ${e}\n`);
  }
}
