/**
 * ingest.ts — чтение файлов с диска и конвертация в PinnedDocument
 *
 * Поддерживаемые форматы:
 *   PDF  → pdf-parse (npm install pdf-parse)
 *   DOCX → mammoth   (npm install mammoth)
 *   Всё остальное (txt, md, py, js, json, csv, yaml...) → readFile utf-8
 */
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { extname, basename, join, resolve, sep } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { ContentType } from './types.js';

// ─── Карта расширений → ContentType ──────────────────────────────────────────

const EXT_CONTENT_TYPE: Record<string, ContentType> = {
  '.py':   'code', '.js':   'code', '.ts':   'code', '.jsx':  'code', '.tsx':  'code',
  '.go':   'code', '.rs':   'code', '.rb':   'code', '.java': 'code', '.cpp':  'code',
  '.c':    'code', '.h':    'code', '.cs':   'code', '.php':  'code', '.swift':'code',
  '.kt':   'code', '.sh':   'code', '.bash': 'code', '.zsh':  'code', '.fish': 'code',
  '.json': 'data', '.csv':  'data', '.xml':  'data', '.yaml': 'data', '.yml':  'data',
  '.toml': 'data', '.sql':  'data', '.ndjson':'data',
  '.md':   'note', '.txt':  'note', '.rst':  'note', '.org':  'note',
  '.pdf':  'reference', '.docx': 'reference', '.doc': 'reference',
  '.html': 'article',   '.htm':  'article',
};

export const SUPPORTED_EXT = new Set(Object.keys(EXT_CONTENT_TYPE));

/**
 * Файл можно прочитать, если у него известное расширение из EXT_CONTENT_TYPE,
 * либо расширения нет вовсе. Дампы технической документации (как у тебя — install core,
 * multiapn и т.п.) часто приходят без расширений — такие файлы трактуются как обычный текст,
 * а не отбрасываются.
 */
export function isIngestable(ext: string): boolean {
  return ext === '' || SUPPORTED_EXT.has(ext);
}

// ─── Динамические экстракторы (pdf-parse / mammoth необязательны) ─────────────

async function extractPdf(buf: Buffer): Promise<{ text: string; pages: number; title?: string }> {
  try {
    const mod = await import('pdf-parse');
    const pdfParse = (mod as any).default ?? mod;
    const data = await pdfParse(buf);
    return { text: data.text, pages: data.numpages, title: data.info?.Title || undefined };
  } catch (e: any) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message?.includes('Cannot find'))
      throw new Error('pdf-parse не установлен: npm install pdf-parse');
    throw e;
  }
}

async function extractDocx(filePath: string): Promise<string> {
  try {
    const mod  = await import('mammoth');
    const mamm = (mod as any).default ?? mod;
    const res  = await mamm.extractRawText({ path: filePath });
    return res.value as string;
  } catch (e: any) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message?.includes('Cannot find'))
      throw new Error('mammoth не установлен: npm install mammoth');
    throw e;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

function autoSummary(text: string, max = 280): string {
  const c = text.replace(/\s+/g, ' ').trim();
  return c.length <= max ? c : c.slice(0, max).replace(/\s\S+$/, '') + '…';
}

// ─── Защита пути (directory traversal) ────────────────────────────────────────

export function safePath(filePath: string, allowedRoots?: string[]): string {
  const abs = resolve(filePath);
  if (allowedRoots?.length) {
    const ok = allowedRoots.some(root => {
      const r = resolve(root);
      return abs === r || abs.startsWith(r + sep);
    });
    if (!ok) throw new Error(`Путь за пределами разрешённых директорий: ${abs}`);
  }
  return abs;
}

// ─── Главная функция ──────────────────────────────────────────────────────────

export interface IngestedFile {
  id:           string;
  title:        string;
  source:       string;
  source_type:  'file';
  content_type: ContentType;
  content:      string;
  summary:      string;
  tags:         string[];
  collection:   string | null;
  metadata:     Record<string, unknown>;
  pinned_at:    string;
  updated_at:   string;
}

export async function ingestFile(
  filePath: string,
  opts: {
    title?:        string;
    tags?:         string[];
    collection?:   string | null;
    content_type?: ContentType;
    allowedRoots?: string[];
  } = {}
): Promise<IngestedFile> {
  const safe = safePath(filePath, opts.allowedRoots);
  const ext  = extname(safe).toLowerCase();
  const stem = basename(safe, ext);

  if (!existsSync(safe))   throw new Error(`Файл не найден: ${safe}`);
  if (!isIngestable(ext)) {
    throw new Error(
      `Формат не поддерживается: ${ext}\nПоддерживаются: ${[...SUPPORTED_EXT].join(' ')}, а также файлы без расширения (читаются как обычный текст)`
    );
  }

  const fileStat = await stat(safe);
  const now      = new Date().toISOString();
  let content    = '';
  let autoTitle: string | undefined;
  let extraMeta: Record<string, unknown> = {};

  // ── Извлечение по формату ────────────────────────────────────────────────
  if (ext === '.pdf') {
    const buf    = await readFile(safe);
    const parsed = await extractPdf(buf);
    content   = parsed.text;
    autoTitle = parsed.title;
    extraMeta = { pages: parsed.pages };

  } else if (ext === '.docx' || ext === '.doc') {
    content = await extractDocx(safe);

  } else if (ext === '.html' || ext === '.htm') {
    content = htmlToText(await readFile(safe, 'utf-8'));

  } else {
    content = await readFile(safe, 'utf-8');
  }

  return {
    id:           uuidv4(),
    title:        opts.title ?? autoTitle ?? stem,
    source:       safe,
    source_type:  'file',
    content_type: opts.content_type ?? EXT_CONTENT_TYPE[ext] ?? (ext === '' ? 'note' : 'other'),
    content,
    summary:      autoSummary(content),
    tags:         opts.tags ?? [],
    collection:   opts.collection ?? null,
    metadata: {
      file_path:     safe,
      extension:     ext,
      no_extension:  ext === '',
      size_bytes:    fileStat.size,
      modified_at:   fileStat.mtime.toISOString(),
      word_count:    content.split(/\s+/).filter(Boolean).length,
      ...extraMeta,
    },
    pinned_at:  now,
    updated_at: now,
  };
}

// ─── Сканирование директории ──────────────────────────────────────────────────

export interface CollectResult {
  files:         string[];
  skipped:       string[];   // неподдерживаемые форматы
  total_scanned: number;
}

export async function collectFiles(
  dirPath: string,
  opts: {
    recursive?:    boolean;
    extensions?:   string[];
    maxFiles?:     number;
    allowedRoots?: string[];
  } = {}
): Promise<CollectResult> {
  const { recursive = false, maxFiles = 500 } = opts;
  const safe = safePath(dirPath, opts.allowedRoots);

  const extFilter: Set<string> | null = opts.extensions
    ? new Set(opts.extensions.map(e => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
    : null;

  async function walk(dir: string, depth = 0): Promise<{ ok: string[]; skip: string[] }> {
    if (depth > 8) return { ok: [], skip: [] };
    const ok: string[] = [], skip: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory() && recursive) {
        const sub = await walk(full, depth + 1);
        ok.push(...sub.ok); skip.push(...sub.skip);
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        // Без явного фильтра расширений: подхватываем известные форматы + файлы без
        // расширения (как текст). С явным фильтром extensions — только точное совпадение,
        // чтобы пользователь полностью контролировал, что попадёт в массовый импорт.
        const supported = extFilter ? extFilter.has(ext) : isIngestable(ext);
        if (supported) ok.push(full); else skip.push(full);
      }
    }
    return { ok, skip };
  }

  const { ok, skip } = await walk(safe);
  return {
    files:         ok.slice(0, maxFiles),
    skipped:       skip,
    total_scanned: ok.length + skip.length,
  };
}
