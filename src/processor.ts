import { v4 as uuidv4 } from 'uuid';
import type { PinnedDocument, ContentType } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectContentType(url: string, text: string): ContentType {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['js','ts','py','go','rs','java','cpp','c','rb','sh','php','swift','kt'].includes(ext)) return 'code';
  if (['json','csv','xml','yaml','yml','toml','sql'].includes(ext)) return 'data';
  // Эвристика по содержимому
  if (/^(import |from |const |let |var |def |class |#include|package |fn )/m.test(text.slice(0, 300))) return 'code';
  return 'article';
}

function extractTitle(html: string, url: string): string {
  // OG-тег → <title> → <h1> → URL
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1];
  if (og) return og.trim();
  const title = html.match(/<title[^>]*>([^<]+)/i)?.[1];
  if (title) return title.replace(/\s*[|–—\-].*$/, '').trim();
  const h1 = html.match(/<h1[^>]*>([^<]+)/i)?.[1];
  if (h1) return h1.trim();
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.split('/').filter(Boolean).slice(-1)[0];
  } catch {
    return url;
  }
}

function htmlToText(html: string): string {
  return html
    // Убираем шумные блоки
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    // Блочные теги → переводы строк
    .replace(/<\/?(p|div|h[1-6]|li|br|tr|td|th|section|article)[^>]*>/gi, '\n')
    // Убираем оставшиеся теги
    .replace(/<[^>]+>/g, '')
    // Декодируем HTML-сущности
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // Нормализуем пробелы
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n');
}

function autoSummary(text: string, maxLen = 280): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen).replace(/\s\S+$/, '') + '…';
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Скачать URL, извлечь текст и нормализовать в PinnedDocument
 */
export async function processUrl(url: string, opts: {
  title?: string;
  tags?: string[];
  collection?: string | null;
  content_type?: ContentType;
} = {}): Promise<PinnedDocument> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DocumentPinboard/1.0 (MCP)' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const ctHeader = res.headers.get('content-type') ?? '';
  const rawBody  = await res.text();
  const isHtml   = ctHeader.includes('text/html') || rawBody.trimStart().startsWith('<');

  const content = isHtml ? htmlToText(rawBody) : rawBody;
  const title   = opts.title ?? (isHtml ? extractTitle(rawBody, url) : url.split('/').filter(Boolean).pop() ?? url);
  const now     = new Date().toISOString();

  return {
    id:           uuidv4(),
    title,
    source:       url,
    source_type:  'url',
    content_type: opts.content_type ?? (isHtml ? 'article' : detectContentType(url, content)),
    content,
    summary:      autoSummary(content),
    tags:         opts.tags ?? [],
    collection:   opts.collection ?? null,
    metadata:     { url, word_count: wordCount(content), content_type_header: ctHeader },
    pinned_at:    now,
    updated_at:   now,
  };
}

/**
 * Нормализовать произвольный текст в PinnedDocument
 */
export function processText(text: string, opts: {
  title?: string;
  tags?: string[];
  collection?: string | null;
  content_type?: ContentType;
} = {}): PinnedDocument {
  const now = new Date().toISOString();
  return {
    id:           uuidv4(),
    title:        opts.title ?? autoSummary(text, 60),
    source:       'manual',
    source_type:  'text',
    content_type: opts.content_type ?? detectContentType('', text),
    content:      text,
    summary:      autoSummary(text),
    tags:         opts.tags ?? [],
    collection:   opts.collection ?? null,
    metadata:     { word_count: wordCount(text) },
    pinned_at:    now,
    updated_at:   now,
  };
}
