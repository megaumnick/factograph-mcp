#!/usr/bin/env node
import 'dotenv/config';
/**
 * Factograph MCP Server
 *
 * Надстройка над Document Pinboard:
 *   - все 8 инструментов пинборда (pin, list, search, get, update, unpin, collections, export)
 *   - + 9 инструментов графа знаний
 *   - + 6 инструментов файлового ввода и дискового хранилища графа
 *
 * AI-backend: Ollama (qwen3:14b) приоритетно, либо Anthropic как fallback.
 * См. .env.example для конфигурации.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// Импортируем оба слоя — DocumentDB и GraphDB открывают ОДИН файл БД
import { DocumentDB } from './db.js';
import { GraphDB }    from './graph.js';
import { processUrl, processText } from './processor.js';
import { enrichDocument, synthesizeCluster } from './enricher.js';
import { FILE_AND_GRAPH_TOOLS, handleFileOrGraphTool } from './file-tools.js';
import { autoLoad, autoSave } from './graph-store.js';
import type { ContentType } from './types.js';

// ─── Init ────────────────────────────────────────────────────────────────────

const docDb   = new DocumentDB();
const graphDb = new GraphDB();  // тот же pins.db

const server = new Server(
  { name: 'factograph', version: '2.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

const txt = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

// ─── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ════════════════════════════════════════════════════════════
    // СЛОЙ 1 — ПИНБОРД (базовые инструменты)
    // ════════════════════════════════════════════════════════════

    {
      name: 'pin_document',
      description: 'Добавить документ (URL или текст) в базу знаний',
      inputSchema: {
        type: 'object',
        properties: {
          url:          { type: 'string' },
          text:         { type: 'string' },
          title:        { type: 'string' },
          tags:         { type: 'array', items: { type: 'string' } },
          collection:   { type: 'string' },
          content_type: { type: 'string', enum: ['article','note','code','reference','data','other'] },
          auto_enrich:  { type: 'boolean', default: false, description: 'Сразу обогатить через AI (нужен API key)' },
        },
      },
    },
    {
      name: 'list_pins',
      description: 'Список документов с фильтрами',
      inputSchema: {
        type: 'object',
        properties: {
          collection:   { type: 'string' },
          tags:         { type: 'array', items: { type: 'string' } },
          content_type: { type: 'string' },
          limit:        { type: 'number', default: 20 },
          offset:       { type: 'number', default: 0 },
        },
      },
    },
    {
      name: 'search_pins',
      description: 'Полнотекстовый FTS5-поиск по документам',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query:        { type: 'string' },
          collection:   { type: 'string' },
          tags:         { type: 'array', items: { type: 'string' } },
          content_type: { type: 'string' },
          limit:        { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'get_pin',
      description: 'Получить полное содержимое документа',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
    {
      name: 'update_pin',
      description: 'Обновить метаданные документа',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id:          { type: 'string' },
          title:       { type: 'string' },
          tags:        { type: 'array', items: { type: 'string' } },
          add_tags:    { type: 'array', items: { type: 'string' } },
          remove_tags: { type: 'array', items: { type: 'string' } },
          collection:  { type: 'string' },
          summary:     { type: 'string' },
        },
      },
    },
    {
      name: 'unpin',
      description: 'Удалить документ (и все его связи)',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
    {
      name: 'list_collections',
      description: 'Коллекции, топ-теги и статистика графа',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'export_collection',
      description: 'Экспорт документов в JSON или Markdown',
      inputSchema: {
        type: 'object', required: ['format'],
        properties: {
          collection:      { type: 'string' },
          format:          { type: 'string', enum: ['json', 'markdown'] },
          include_content: { type: 'boolean', default: false },
        },
      },
    },

    // ════════════════════════════════════════════════════════════
    // СЛОЙ 2 — ГРАФ ЗНАНИЙ
    // ════════════════════════════════════════════════════════════

    {
      name: 'link_documents',
      description: 'Вручную создать типизированную связь между документами',
      inputSchema: {
        type: 'object', required: ['from_id', 'to_id', 'relation'],
        properties: {
          from_id:  { type: 'string' },
          to_id:    { type: 'string' },
          relation: {
            type: 'string',
            enum: ['cites','extends','contradicts','is_part_of',
                   'supports','mentions','shares_topic',
                   'similar_to','relates_to','co_referenced'],
            description: 'Тип связи (strong: cites/extends/contradicts/is_part_of | medium: supports/mentions/shares_topic | weak: similar_to/relates_to)',
          },
          strength: { type: 'number', minimum: 0, maximum: 1, description: 'Сила 0.0–1.0 (авто если не задана)' },
          note:     { type: 'string', description: 'Описание причины связи' },
        },
      },
    },
    {
      name: 'get_connections',
      description: 'Получить все связи документа с фильтрами',
      inputSchema: {
        type: 'object', required: ['doc_id'],
        properties: {
          doc_id:      { type: 'string' },
          direction:   { type: 'string', enum: ['outbound','inbound','both'], default: 'both' },
          min_strength:{ type: 'number', default: 0 },
          relations:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'traverse_graph',
      description: 'BFS-обход графа от документа — возвращает узлы с их связями',
      inputSchema: {
        type: 'object', required: ['doc_id'],
        properties: {
          doc_id:      { type: 'string' },
          max_depth:   { type: 'number', default: 2 },
          min_strength:{ type: 'number', default: 0.3 },
          direction:   { type: 'string', enum: ['outbound','inbound','both'], default: 'both' },
          relations:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'enrich_document',
      description: 'AI-обогащение ОДНОГО документа: извлечь сущности и факты, предложить связи с другими. ' +
        'Требует OLLAMA_HOST (приоритетно) или ANTHROPIC_API_KEY (fallback). ' +
        'Если нужно связать ВСЕ документы коллекции/базы сразу — используй auto_link_collection, а не вызывай этот инструмент по одному для каждого документа в цикле.',
      inputSchema: {
        type: 'object', required: ['doc_id'],
        properties: {
          doc_id:           { type: 'string' },
          max_context_docs: { type: 'number', default: 10 },
        },
      },
    },
    {
      name: 'find_by_entity',
      description: 'Найти все документы, упоминающие сущность',
      inputSchema: {
        type: 'object', required: ['entity'],
        properties: {
          entity: { type: 'string', description: 'Имя сущности (регистр не важен)' },
        },
      },
    },
    {
      name: 'find_related',
      description: 'Найти документы, похожие на ОДИН конкретный документ (по пересечению сущностей, Jaccard). ' +
        'Если пользователь просит связать/построить граф для ВСЕХ документов сразу — используй auto_link_collection вместо цикла по этому инструменту.',
      inputSchema: {
        type: 'object', required: ['doc_id'],
        properties: {
          doc_id:      { type: 'string' },
          top_n:       { type: 'number', default: 5 },
          min_jaccard: { type: 'number', default: 0.05 },
          auto_link:   { type: 'boolean', default: false, description: 'Авто-создать слабые связи' },
        },
      },
    },
    {
      name: 'auto_link_collection',
      description: 'Массово установить связи между документами ОДНИМ вызовом. ' +
        'Вызывай это, когда пользователь просит "свяжи все документы", "установи связи между всеми файлами", ' +
        '"построй граф" — НЕ нужно вызывать enrich_document или find_related по очереди для каждого документа. ' +
        'Если у документов ещё нет извлечённых сущностей, инструмент сам обогатит их через AI (Ollama/Anthropic) ' +
        'перед тем как искать связи — это решает частую ситуацию "0 связей", когда документы просто никогда не обогащались.',
      inputSchema: {
        type: 'object',
        properties: {
          collection:  { type: 'string', description: 'Только эта коллекция (все документы базы если не задано)' },
          use_ai:      { type: 'boolean', default: true,
                         description: 'Обогащать документы без сущностей через AI перед связыванием. Выключи, если сущности уже есть или AI-backend не настроен' },
          min_jaccard: { type: 'number', default: 0.1, description: 'Порог схожести для авто-связей (0–1)' },
        },
      },
    },
    {
      name: 'get_facts',
      description: 'Получить атомарные факты, извлечённые из документа',
      inputSchema: {
        type: 'object', required: ['doc_id'],
        properties: {
          doc_id:     { type: 'string' },
          find_related: { type: 'boolean', default: false, description: 'Найти связанные факты из других документов' },
        },
      },
    },
    {
      name: 'synthesize_cluster',
      description: 'AI-синтез: написать резюме по кластеру документов. Требует ANTHROPIC_API_KEY',
      inputSchema: {
        type: 'object',
        properties: {
          doc_ids:    { type: 'array', items: { type: 'string' }, description: 'Список ID (приоритет)' },
          collection: { type: 'string', description: 'Или вся коллекция' },
          start_doc:  { type: 'string', description: 'Или граф из стартового документа (depth=2)' },
        },
      },
    },
    {
      name: 'graph_stats',
      description: 'Статистика графа: узлы, рёбра, хабы, факты',
      inputSchema: { type: 'object', properties: {} },
    },

    // ════════════════════════════════════════════════════════════
    // СЛОЙ 3 — ФАЙЛЫ НА СЕРВЕРЕ + ХРАНЕНИЕ ГРАФА НА ДИСКЕ
    // ════════════════════════════════════════════════════════════
    ...FILE_AND_GRAPH_TOOLS,
  ],
}));

// ─── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const { name, arguments: args = {} } = params;
  const a = args as Record<string, unknown>;

  try {

    // ── pin_document ──────────────────────────────────────────────────────────
    if (name === 'pin_document') {
      if (!a.url && !a.text)
        throw new McpError(ErrorCode.InvalidParams, 'Нужен url или text');

      const doc = a.url
        ? await processUrl(a.url as string, {
            title: a.title as string, tags: a.tags as string[],
            collection: (a.collection as string) ?? null,
          })
        : processText(a.text as string, {
            title: a.title as string, tags: a.tags as string[],
            collection: (a.collection as string) ?? null,
            content_type: a.content_type as ContentType,
          });

      if (a.content_type) doc.content_type = a.content_type as ContentType;
      docDb.insert(doc);

      // Авто-обогащение через AI (опционально)
      let enrichment = null;
      if (a.auto_enrich) {
        try {
          enrichment = await enrichDocument(doc.id, graphDb);
        } catch (e) {
          enrichment = { error: String(e) };
        }
      }

      return txt({
        ok: true,
        id: doc.id, title: doc.title, content_type: doc.content_type,
        summary: doc.summary, tags: doc.tags, collection: doc.collection,
        word_count: doc.metadata.word_count,
        ...(enrichment ? { enrichment } : {}),
      });
    }

    // ── list_pins ─────────────────────────────────────────────────────────────
    if (name === 'list_pins') {
      const r = docDb.list({
        collection: a.collection as string | undefined,
        tags: a.tags as string[] | undefined,
        content_type: a.content_type as string | undefined,
        limit: a.limit as number | undefined,
        offset: a.offset as number | undefined,
      });
      return txt({
        total: r.total,
        showing: `${r.offset + 1}–${Math.min(r.offset + r.limit, r.total)}`,
        items: r.items.map(d => ({
          id: d.id, title: d.title, content_type: d.content_type,
          summary: d.summary.slice(0, 120), tags: d.tags,
          collection: d.collection, pinned_at: d.pinned_at,
        })),
      });
    }

    // ── search_pins ───────────────────────────────────────────────────────────
    if (name === 'search_pins') {
      if (!a.query) throw new McpError(ErrorCode.InvalidParams, 'query обязателен');
      const results = docDb.search(a.query as string, {
        collection: a.collection as string | undefined,
        tags: a.tags as string[] | undefined,
        content_type: a.content_type as string | undefined,
        limit: a.limit as number | undefined,
      });
      return txt({
        query: a.query, found: results.length,
        results: results.map(d => ({
          id: d.id, title: d.title, content_type: d.content_type,
          summary: d.summary.slice(0, 160), tags: d.tags, collection: d.collection,
        })),
      });
    }

    // ── get_pin ───────────────────────────────────────────────────────────────
    if (name === 'get_pin') {
      const doc = docDb.getById(a.id as string);
      if (!doc) throw new McpError(ErrorCode.InvalidParams, `Не найден: ${a.id}`);
      // Добавляем граф-метаданные
      const connections = graphDb.getConnections(a.id as string, { limit: 20 });
      const facts = graphDb.getFacts(a.id as string);
      const entities = graphDb.getDocEntities(a.id as string);
      return txt({ ...doc, graph: { connections, facts, entities } });
    }

    // ── update_pin ────────────────────────────────────────────────────────────
    if (name === 'update_pin') {
      const cur = docDb.getById(a.id as string);
      if (!cur) throw new McpError(ErrorCode.InvalidParams, `Не найден: ${a.id}`);
      let tags = (a.tags as string[] | undefined) ?? cur.tags;
      if (a.add_tags)    tags = [...new Set([...tags, ...(a.add_tags as string[])])];
      if (a.remove_tags) tags = tags.filter(t => !(a.remove_tags as string[]).includes(t));
      const updated = docDb.update(a.id as string, {
        title: (a.title as string) ?? cur.title,
        tags,
        collection: a.collection !== undefined ? (a.collection as string) : cur.collection,
        summary: (a.summary as string) ?? cur.summary,
      });
      return txt({ ok: true, document: updated });
    }

    // ── unpin ─────────────────────────────────────────────────────────────────
    if (name === 'unpin') {
      const ok = docDb.delete(a.id as string); // CASCADE удалит связи/факты/сущности
      return txt({ ok, message: ok ? `Удалён ${a.id}` : `Не найден ${a.id}` });
    }

    // ── list_collections ──────────────────────────────────────────────────────
    if (name === 'list_collections') {
      const stats = graphDb.getGraphStats();
      return txt({
        collections: docDb.listCollections(),
        top_tags:    docDb.listTags().slice(0, 20),
        graph:       stats,
      });
    }

    // ── export_collection ─────────────────────────────────────────────────────
    if (name === 'export_collection') {
      const items = docDb.list({ collection: a.collection as string | undefined, limit: 10_000 }).items;
      if (a.format === 'json') {
        return txt(items.map(d => a.include_content ? d : { ...d, content: undefined }));
      }
      const header = [
        `# Factograph Export`,
        a.collection ? `**Collection**: ${a.collection}` : '**All documents**',
        `**Generated**: ${new Date().toISOString()}`,
        `**Total**: ${items.length}`, '', '---', '',
      ];
      const body = items.map(d => {
        const conns = graphDb.getConnections(d.id, { limit: 5 });
        const connLines = conns.map(c => `  - [${c.relation}] → ${c.other_title} (${c.strength.toFixed(2)})`);
        return [
          `## ${d.title}`,
          `**ID**: \`${d.id}\` · **Type**: ${d.content_type} · **Pinned**: ${d.pinned_at.slice(0, 10)}`,
          d.tags.length ? `**Tags**: ${d.tags.join(', ')}` : '',
          '', `> ${d.summary}`,
          ...(connLines.length ? ['', '**Connections**:', ...connLines] : []),
          ...(a.include_content ? ['', '```', d.content.slice(0, 3000), '```'] : []),
          '',
        ].filter(l => l !== null).join('\n');
      });
      return { content: [{ type: 'text' as const, text: [...header, ...body].join('\n') }] };
    }

    // ════════════════════════════════════════════════════════════
    // ГРАФ-ИНСТРУМЕНТЫ
    // ════════════════════════════════════════════════════════════

    // ── link_documents ────────────────────────────────────────────────────────
    if (name === 'link_documents') {
      const { from_id, to_id, relation, strength, note } = a as Record<string, unknown>;
      // Дефолтная сила по типу связи
      const DEFAULT_STRENGTH: Record<string, number> = {
        cites: 0.95, extends: 0.90, contradicts: 0.90, is_part_of: 0.95,
        supports: 0.65, mentions: 0.55, shares_topic: 0.50,
        similar_to: 0.35, relates_to: 0.25, co_referenced: 0.20,
      };
      const conn = graphDb.addConnection({
        from_id:  from_id as string,
        to_id:    to_id   as string,
        relation: relation as any,
        strength: typeof strength === 'number' ? strength : (DEFAULT_STRENGTH[relation as string] ?? 0.5),
        note:     (note as string) ?? null,
        source:   'manual',
      });
      return txt({ ok: true, connection: conn });
    }

    // ── get_connections ───────────────────────────────────────────────────────
    if (name === 'get_connections') {
      const connections = graphDb.getConnections(a.doc_id as string, {
        direction:   a.direction as any,
        minStrength: a.min_strength as number | undefined,
        relations:   a.relations as string[] | undefined,
      });
      return txt({ doc_id: a.doc_id, count: connections.length, connections });
    }

    // ── traverse_graph ────────────────────────────────────────────────────────
    if (name === 'traverse_graph') {
      const nodes = graphDb.traverse(a.doc_id as string, {
        maxDepth:    (a.max_depth   as number) ?? 2,
        minStrength: (a.min_strength as number) ?? 0.3,
        direction:   a.direction as any,
        relations:   a.relations as string[] | undefined,
      });
      // Компактный формат для больших графов
      const summary = nodes.map(n => ({
        doc_id: n.doc_id, title: n.title, content_type: n.content_type, depth: n.depth,
        connections: n.connections.map(c => ({
          to: c.from_id === n.doc_id ? c.to_id : c.from_id,
          title: c.other_title, relation: c.relation, strength: c.strength,
        })),
      }));
      return txt({ start: a.doc_id, nodes_found: nodes.length, graph: summary });
    }

    // ── enrich_document ───────────────────────────────────────────────────────
    if (name === 'enrich_document') {
      const result = await enrichDocument(a.doc_id as string, graphDb, {
        maxContextDocs: (a.max_context_docs as number) ?? 10,
      });
      return txt({
        ok: true,
        doc_id: a.doc_id,
        entities_extracted:   result.entities.length,
        facts_extracted:      result.facts.length,
        connections_created:  result.connections.length,
        entities:    result.entities.slice(0, 20),
        facts:       result.facts.slice(0, 5).map(f => ({ claim: f.claim, confidence: f.confidence })),
        connections: result.connections.map(c => ({
          to: c.to_id, relation: c.relation, strength: c.strength, source: c.source,
        })),
      });
    }

    // ── find_by_entity ────────────────────────────────────────────────────────
    if (name === 'find_by_entity') {
      const docs = graphDb.findDocsByEntity(a.entity as string);
      return txt({ entity: a.entity, found: docs.length, documents: docs });
    }

    // ── find_related ──────────────────────────────────────────────────────────
    if (name === 'find_related') {
      const similar = graphDb.findSimilarByEntities(a.doc_id as string, {
        topN:       (a.top_n       as number) ?? 5,
        minJaccard: (a.min_jaccard as number) ?? 0.05,
      });
      // Авто-связи (опционально)
      let linked: unknown[] = [];
      if (a.auto_link && similar.length > 0) {
        linked = graphDb.autoConnectByEntities(a.doc_id as string)
          .map(c => ({ to: c.to_id, relation: c.relation, strength: c.strength }));
      }
      return txt({
        doc_id: a.doc_id, found: similar.length,
        similar: similar.map(s => ({
          doc_id: s.doc_id, title: s.title,
          jaccard: +s.jaccard.toFixed(3),
          shared_entities: s.shared.slice(0, 10),
        })),
        ...(a.auto_link ? { auto_linked: linked } : {}),
      });
    }

    // ── auto_link_collection ─────────────────────────────────────────────────
    // Решает ровно ту ситуацию, где модель не смогла спланировать цикл
    // "обогатить каждый документ → найти связи" сама — делаем это одним вызовом.
    if (name === 'auto_link_collection') {
      const collection = a.collection as string | undefined;
      const useAi       = a.use_ai !== false; // по умолчанию true
      const minJaccard  = (a.min_jaccard as number) ?? 0.1;

      const docs = docDb.list({ collection, limit: 10_000 }).items;
      if (docs.length < 2) {
        return txt({
          ok: true,
          message: 'Недостаточно документов для связывания (нужно минимум 2)',
          docs_count: docs.length,
        });
      }

      // Шаг 1: обогащаем документы, у которых пока нет сущностей —
      // без этого Jaccard-сравнение не с чем считать (это и есть причина "0 связей")
      let enriched = 0, enrich_errors = 0;
      if (useAi) {
        for (const doc of docs) {
          if (graphDb.getDocEntities(doc.id).length === 0) {
            try {
              await enrichDocument(doc.id, graphDb, { maxContextDocs: docs.length });
              enriched++;
            } catch (e) {
              enrich_errors++;
            }
          }
        }
      }

      // Шаг 2: авто-связи по сущностям для каждого документа
      const allConnections: { from: string; from_title: string; to: string; to_title: string; relation: string; strength: number }[] = [];
      const titleById = new Map(docs.map(d => [d.id, d.title]));

      for (const doc of docs) {
        const created = graphDb.autoConnectByEntities(doc.id, { minJaccard });
        for (const c of created) {
          allConnections.push({
            from: doc.id, from_title: doc.title,
            to: c.to_id, to_title: titleById.get(c.to_id) ?? c.to_id,
            relation: c.relation, strength: +c.strength.toFixed(3),
          });
        }
      }

      return txt({
        ok: true,
        docs_processed:      docs.length,
        enriched_now:        enriched,
        enrich_errors,
        connections_created: allConnections.length,
        connections:         allConnections.slice(0, 50),
        ...(allConnections.length === 0 ? {
          hint: 'Связей не найдено даже после обогащения — возможно, документы действительно не пересекаются по темам/сущностям. Попробуй снизить min_jaccard.',
        } : {}),
      });
    }

    // ── get_facts ─────────────────────────────────────────────────────────────
    if (name === 'get_facts') {
      const facts = graphDb.getFacts(a.doc_id as string);
      const related = a.find_related
        ? graphDb.findRelatedFacts(a.doc_id as string)
        : [];
      return txt({
        doc_id: a.doc_id,
        facts_count: facts.length,
        facts,
        ...(a.find_related ? {
          related_facts_count: related.length,
          related_facts: related.map(r => ({
            doc_title: r.doc_title,
            claim: r.fact.claim,
            entities: r.fact.entities,
            confidence: r.fact.confidence,
          })),
        } : {}),
      });
    }

    // ── synthesize_cluster ────────────────────────────────────────────────────
    if (name === 'synthesize_cluster') {
      let docIds: string[] = (a.doc_ids as string[]) ?? [];

      if (!docIds.length && a.collection) {
        docIds = docDb.list({ collection: a.collection as string, limit: 20 })
          .items.map(d => d.id);
      }
      if (!docIds.length && a.start_doc) {
        docIds = graphDb
          .traverse(a.start_doc as string, { maxDepth: 2, minStrength: 0.3 })
          .map(n => n.doc_id);
      }
      if (!docIds.length) throw new McpError(ErrorCode.InvalidParams, 'Нужен doc_ids, collection или start_doc');

      const synthesis = await synthesizeCluster(docIds, graphDb);
      return txt({ docs_count: docIds.length, doc_ids: docIds, synthesis });
    }

    // ── graph_stats ───────────────────────────────────────────────────────────
    if (name === 'graph_stats') {
      return txt(graphDb.getGraphStats());
    }

    // ════════════════════════════════════════════════════════════
    // СЛОЙ 3 — файлы на сервере + save/load графа на диск
    // ════════════════════════════════════════════════════════════
    if (FILE_AND_GRAPH_TOOLS.some(t => t.name === name)) {
      return await handleFileOrGraphTool(name, a, docDb, graphDb);
    }

    throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);

  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, String(e));
  }
});

// ─── Resources ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'factograph://index',       name: 'All documents',       mimeType: 'application/json' },
    { uri: 'factograph://graph/stats', name: 'Graph statistics',    mimeType: 'application/json' },
    ...docDb.listCollections().map(c => ({
      uri:      `factograph://collection/${encodeURIComponent(c.name)}`,
      name:     c.name,
      description: `${c.count} docs`,
      mimeType: 'application/json',
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params: { uri } }) => {
  if (uri === 'factograph://index') {
    return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify(docDb.list({ limit: 500 }), null, 2) }] };
  }
  if (uri === 'factograph://graph/stats') {
    return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify(graphDb.getGraphStats(), null, 2) }] };
  }
  const m = uri.match(/^factograph:\/\/collection\/(.+)$/);
  if (m) {
    const col = decodeURIComponent(m[1]);
    return { contents: [{ uri, mimeType: 'application/json',
      text: JSON.stringify(docDb.list({ collection: col, limit: 200 }), null, 2) }] };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
});

// ─── Start ───────────────────────────────────────────────────────────────────

// Загружаем граф с диска, если задан AUTO_SAVE_PATH (см. .env)
await autoLoad(docDb, graphDb);

async function shutdown() {
  await autoSave(docDb, graphDb);
  docDb.close();
  graphDb.close();
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[factograph-mcp] запущен (nodes+graph+files)\n');
