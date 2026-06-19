/**
 * file-tools.ts — новые инструменты MCP: файловый ввод + диск-хранилище
 *
 * Как подключить к существующему index.ts:
 *
 *   import { FILE_AND_GRAPH_TOOLS, handleFileOrGraphTool } from './file-tools.js';
 *
 *   // В ListToolsRequestSchema:
 *   tools: [...existingTools, ...FILE_AND_GRAPH_TOOLS],
 *
 *   // В CallToolRequestSchema, перед финальным throw:
 *   if (FILE_AND_GRAPH_TOOLS.some(t => t.name === name)) {
 *     return await handleFileOrGraphTool(name, a, docDb, graphDb);
 *   }
 *
 *   // Добавить lifecycle hooks (startup + shutdown):
 *   import { autoLoad, autoSave } from './graph-store.js';
 *   await autoLoad(docDb, graphDb);                     // ← до server.connect()
 *   process.on('SIGINT', async () => {
 *     await autoSave(docDb, graphDb);
 *     docDb.close(); graphDb.close(); process.exit(0);
 *   });
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ingestFile, collectFiles }                       from './ingest.js';
import { saveGraph, loadGraph, exportEdgesCsv, exportGraphDot } from './graph-store.js';
import { pingOllama }                                     from './ollama.js';
import type { DocumentDB }                                from './db.js';
import type { GraphDB }                                   from './graph.js';

// Разрешённые корни из env (ALLOWED_ROOTS=/home/user:/mnt/data)
const ALLOWED_ROOTS: string[] = (process.env.ALLOWED_ROOTS ?? '')
  .split(':').map(p => p.trim()).filter(Boolean);

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const FILE_AND_GRAPH_TOOLS = [

  // ════ ФАЙЛОВЫЙ ВВОД ═══════════════════════════════════════════════════════

  {
    name: 'ingest_file',
    description: 'Прочитать файл на сервере и добавить в базу знаний (PDF, DOCX, txt, код, CSV...)',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:         { type: 'string', description: 'Абсолютный путь к файлу' },
        title:        { type: 'string' },
        tags:         { type: 'array', items: { type: 'string' } },
        collection:   { type: 'string' },
        content_type: { type: 'string', enum: ['article','note','code','reference','data','other'] },
        auto_enrich:  { type: 'boolean', default: false,
                        description: 'Запустить AI-обогащение после загрузки (нужен OLLAMA_HOST или ANTHROPIC_API_KEY)' },
      },
    },
  },

  {
    name: 'ingest_directory',
    description: 'Загрузить все поддерживаемые файлы из директории на сервере',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:        { type: 'string' },
        recursive:   { type: 'boolean', default: false },
        extensions:  { type: 'array', items: { type: 'string' },
                       description: 'Фильтр расширений без точки: ["pdf","md","py"]' },
        tags:        { type: 'array', items: { type: 'string' } },
        collection:  { type: 'string' },
        max_files:   { type: 'number', default: 100 },
        auto_enrich: { type: 'boolean', default: false },
        dry_run:     { type: 'boolean', default: false,
                       description: 'Только показать файлы, не импортировать' },
      },
    },
  },

  {
    name: 'list_server_files',
    description: 'Показать содержимое директории на сервере',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:       { type: 'string' },
        extensions: { type: 'array', items: { type: 'string' } },
      },
    },
  },

  {
    name: 'ping_ollama',
    description: 'Проверить соединение с Ollama и список доступных моделей',
    inputSchema: { type: 'object', properties: {} },
  },

  // ════ ХРАНИЛИЩЕ ГРАФА НА ДИСКЕ ════════════════════════════════════════════

  {
    name: 'save_graph',
    description: 'Сохранить граф (узлы + связи + факты + сущности) в JSON-файл',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:            { type: 'string', description: 'Путь к .json файлу' },
        collection:      { type: 'string', description: 'Только эта коллекция (все если не задана)' },
        include_content: { type: 'boolean', default: false,
                           description: 'Включить полный текст документов (файл будет больше)' },
      },
    },
  },

  {
    name: 'load_graph',
    description: 'Загрузить граф из JSON-файла в базу (merge)',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:        { type: 'string' },
        on_conflict: { type: 'string', enum: ['skip', 'overwrite'], default: 'skip',
                       description: 'skip — не трогать существующие; overwrite — перезаписать' },
        dry_run:     { type: 'boolean', default: false },
      },
    },
  },

  {
    name: 'export_edges',
    description: 'Экспортировать связи в CSV или Graphviz DOT файл',
    inputSchema: {
      type: 'object',
      required: ['path', 'format'],
      properties: {
        path:   { type: 'string' },
        format: { type: 'string', enum: ['csv', 'dot'],
                  description: 'csv — Excel/таблица; dot — визуализация через Graphviz' },
      },
    },
  },

] as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleFileOrGraphTool(
  name:    string,
  args:    Record<string, unknown>,
  docDb:   DocumentDB,
  graphDb: GraphDB,
): Promise<{ content: { type: 'text'; text: string }[] }> {

  const txt = (obj: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  });

  // ── ingest_file ───────────────────────────────────────────────────────────
  if (name === 'ingest_file') {
    const doc = await ingestFile(args.path as string, {
      title:        args.title        as string | undefined,
      tags:         args.tags         as string[] | undefined,
      collection:   (args.collection  as string) ?? null,
      content_type: args.content_type as any,
      allowedRoots: ALLOWED_ROOTS,
    });
    docDb.insert(doc as any);

    let enrichment: unknown = null;
    if (args.auto_enrich) {
      try {
        const { enrichDocument } = await import('./enricher.js');
        const r = await enrichDocument(doc.id, graphDb);
        enrichment = {
          entities:    r.entities.length,
          facts:       r.facts.length,
          connections: r.connections.length,
        };
      } catch (e) { enrichment = { error: String(e) }; }
    }

    return txt({
      ok: true, id: doc.id, title: doc.title, content_type: doc.content_type,
      summary:    doc.summary.slice(0, 200),
      tags:       doc.tags,
      collection: doc.collection,
      word_count: doc.metadata.word_count,
      file_path:  doc.metadata.file_path,
      ...(enrichment ? { enrichment } : {}),
    });
  }

  // ── ingest_directory ──────────────────────────────────────────────────────
  if (name === 'ingest_directory') {
    const collected = await collectFiles(args.path as string, {
      recursive:    args.recursive  as boolean  | undefined,
      extensions:   args.extensions as string[] | undefined,
      maxFiles:     args.max_files  as number   | undefined,
      allowedRoots: ALLOWED_ROOTS,
    });

    if (args.dry_run) {
      return txt({
        dry_run: true,
        found:         collected.files.length,
        skipped_types: collected.skipped.length,
        total_scanned: collected.total_scanned,
        files: collected.files,
      });
    }

    type FileResult = { path: string; id: string; title: string; ok: boolean; error?: string };
    const results: FileResult[] = [];
    let enrich_errors = 0;

    for (const filePath of collected.files) {
      try {
        const doc = await ingestFile(filePath, {
          tags:         args.tags       as string[] | undefined,
          collection:   (args.collection as string) ?? null,
          allowedRoots: ALLOWED_ROOTS,
        });
        docDb.insert(doc as any);

        if (args.auto_enrich) {
          try {
            const { enrichDocument } = await import('./enricher.js');
            await enrichDocument(doc.id, graphDb);
          } catch { enrich_errors++; }
        }

        results.push({ path: filePath, id: doc.id, title: doc.title, ok: true });
      } catch (e) {
        results.push({ path: filePath, id: '', title: '', ok: false, error: String(e) });
      }
    }

    const ok    = results.filter(r => r.ok);
    const fails = results.filter(r => !r.ok);
    return txt({
      ingested:        ok.length,
      failed:          fails.length,
      enrich_errors,
      total_scanned:   collected.total_scanned,
      skipped_formats: collected.skipped.length,
      results: ok.map(r => ({ id: r.id, title: r.title, path: r.path })),
      errors:  fails.map(r => ({ path: r.path, error: r.error })),
    });
  }

  // ── list_server_files ─────────────────────────────────────────────────────
  if (name === 'list_server_files') {
    const { readdir, stat } = await import('fs/promises');
    const { join, extname } = await import('path');
    const { isIngestable } = await import('./ingest.js');

    const dirPath    = args.path as string;
    const extFilter  = args.extensions
      ? new Set((args.extensions as string[]).map(e => e.startsWith('.') ? e : `.${e}`))
      : null;

    const entries = await readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.')) return null;
      const full = join(dirPath, e.name);
      if (e.isDirectory()) return { name: e.name, type: 'dir', path: full };
      const ext = extname(e.name).toLowerCase();
      if (extFilter && !extFilter.has(ext)) return null;
      const s = await stat(full).catch(() => null);
      return {
        name: e.name, type: 'file', path: full, ext,
        size_kb:   s ? +(s.size / 1024).toFixed(1) : null,
        supported: isIngestable(ext),
      };
    }));

    return txt({ path: dirPath, count: items.filter(Boolean).length, entries: items.filter(Boolean) });
  }

  // ── ping_ollama ───────────────────────────────────────────────────────────
  if (name === 'ping_ollama') {
    return txt(await pingOllama());
  }

  // ── save_graph ────────────────────────────────────────────────────────────
  if (name === 'save_graph') {
    const r = await saveGraph(docDb, graphDb, args.path as string, {
      collection:      args.collection      as string  | undefined,
      include_content: args.include_content as boolean | undefined,
    });
    return txt({ ok: true, ...r });
  }

  // ── load_graph ────────────────────────────────────────────────────────────
  if (name === 'load_graph') {
    const r = await loadGraph(docDb, graphDb, args.path as string, {
      on_conflict: args.on_conflict as any,
      dry_run:     args.dry_run     as boolean | undefined,
    });
    return txt({ ok: true, ...(args.dry_run ? { dry_run: true } : {}), ...r });
  }

  // ── export_edges ──────────────────────────────────────────────────────────
  if (name === 'export_edges') {
    if (args.format === 'csv') {
      return txt({ ok: true, format: 'csv', ...await exportEdgesCsv(graphDb, args.path as string) });
    }
    if (args.format === 'dot') {
      return txt({ ok: true, format: 'dot', ...await exportGraphDot(graphDb, docDb, args.path as string) });
    }
    throw new McpError(ErrorCode.InvalidParams, `Неизвестный формат: ${args.format}`);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Неизвестный инструмент: ${name}`);
}
