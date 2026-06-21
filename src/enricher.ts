/**
 * enricher.ts (v2) — обогащение через Ollama (Qwen3:14b) или Anthropic
 *
 * Приоритет выбора бэкенда:
 *   1. Ollama  — если задан OLLAMA_HOST
 *   2. Anthropic — если задан ANTHROPIC_API_KEY
 *   3. Ошибка  — если ни то, ни другое
 *
 * Для надёжного JSON из Qwen3 нужны:
 *   • format: 'json'  в запросе к Ollama
 *   • /no_think       (отключает цепочку размышлений)
 *   • temperature: 0.1
 */
import { ollamaChat, extractJson, ollamaGenerate } from './ollama.js';
import type { GraphDB } from './graph.js';
import type { Connection, Fact, Relation, EnrichmentResult } from './graph-types.js';

// ─── Backend router ───────────────────────────────────────────────────────────

const USE_OLLAMA    = Boolean(process.env.OLLAMA_HOST);
const USE_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

async function callLLM(system: string, user: string, numCtx = 8192): Promise<string> {
  if (USE_OLLAMA) {
    return ollamaChat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { json: true, temperature: 0.1, think: false, numCtx }
    );
  }
  if (USE_ANTHROPIC) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const res = await client.messages.create({
      model:      process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      messages:   [{ role: 'user', content: user }],
    });
    return res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }
  throw new Error('Не задан ни OLLAMA_HOST, ни ANTHROPIC_API_KEY');
}

// ─── Системные промпты ────────────────────────────────────────────────────────

const SYS_EXTRACT = `Ты — строитель графа знаний. Извлекай сущности и факты из текста.
Отвечай ТОЛЬКО валидным JSON без markdown-блоков и комментариев.`;

const SYS_CONNECT = `Ты — строитель графа знаний. Ищи смысловые связи между документами.
Отвечай ТОЛЬКО валидным JSON без markdown-блоков и комментариев.`;

// ─── Шаг 1: сущности + факты ─────────────────────────────────────────────────

async function extractEntitiesAndFacts(title: string, content: string): Promise<{
  entities: string[];
  facts: Array<{ claim: string; entities: string[]; span: string; confidence: number }>;
}> {
  const prompt = `Извлеки из документа именованные сущности и атомарные факты.

Заголовок: ${title}
Текст (до 4000 символов):
${content.slice(0, 4000)}

Верни JSON:
{
  "entities": ["нормализованные сущности: персоны, орг., алгоритмы, метрики..."],
  "facts": [
    {
      "claim": "конкретное, проверяемое атомарное утверждение",
      "entities": ["сущность1"],
      "span": "цитата из текста до 150 символов",
      "confidence": 0.9
    }
  ]
}

Правила: entities — lowercase, 5–25 штук; facts — до 10, конкретные.`;

  try {
    const text = await callLLM(SYS_EXTRACT, prompt);
    return extractJson(text);
  } catch {
    return { entities: [], facts: [] };
  }
}

// ─── Шаг 2: связи с существующими документами ────────────────────────────────

async function detectConnections(
  newTitle:   string,
  newSummary: string,
  existing:   Array<{ id: string; title: string; summary: string; content_type: string }>
): Promise<Array<{ doc_id: string; relation: string; strength: number; reason: string }>> {
  if (existing.length === 0) return [];

  const docsBlock = existing
    .map(d => `ID: ${d.id}\nType: ${d.content_type}\nTitle: ${d.title}\nSummary: ${d.summary}`)
    .join('\n---\n');

  const prompt = `Найди смысловые связи нового документа с существующими.

=== НОВЫЙ ===
Title: ${newTitle}
Summary: ${newSummary}

=== СУЩЕСТВУЮЩИЕ ===
${docsBlock}

Верни JSON:
{
  "connections": [
    {
      "doc_id": "id из списка выше",
      "relation": "cites|extends|contradicts|is_part_of|supports|mentions|shares_topic|similar_to",
      "strength": 0.85,
      "reason": "одно предложение"
    }
  ]
}

Сила по типу:
• cites/extends/contradicts/is_part_of → 0.7–1.0
• supports/mentions/shares_topic       → 0.4–0.7
• similar_to                           → 0.1–0.4
Только реальные связи. Если связей нет — пустой массив.`;

  try {
    // Малая база (как в типичном auto_link_collection на пару десятков документов) —
    // 8192 достаточно и оставляет больше VRAM под сами веса модели.
    // Большая база — растим контекст, чтобы не обрезать список существующих документов.
    const ctx    = existing.length > 15 ? 16_384 : 8192;
    const text   = await callLLM(SYS_CONNECT, prompt, ctx);
    const parsed = extractJson<{ connections: any[] }>(text);
    return parsed.connections ?? [];
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function enrichDocument(
  docId:   string,
  graphDb: GraphDB,
  opts:    { maxContextDocs?: number } = {}
): Promise<EnrichmentResult> {
  const { maxContextDocs = 8 } = opts;

  const docRow = (graphDb as any).db.prepare(
    'SELECT id, title, content, content_type, summary FROM docs WHERE id = ?'
  ).get(docId) as {
    id: string; title: string; content: string; content_type: string; summary: string;
  } | undefined;

  if (!docRow) throw new Error(`Документ не найден: ${docId}`);

  // ── Шаг 1: сущности + факты ──────────────────────────────────────────────
  const step1 = await extractEntitiesAndFacts(docRow.title, docRow.content);

  graphDb.addEntities(docId, step1.entities ?? []);

  const facts: Fact[] = (step1.facts ?? []).map(f =>
    graphDb.addFact({
      doc_id:     docId,
      claim:      f.claim,
      entities:   f.entities ?? [],
      confidence: Math.max(0, Math.min(1, f.confidence ?? 0.8)),
      span:       f.span?.slice(0, 200) ?? null,
    })
  );

  // ── Шаг 2: связи с соседями ──────────────────────────────────────────────
  const existingDocs = (graphDb as any).db.prepare(
    'SELECT id, title, summary, content_type FROM docs WHERE id != ? LIMIT ?'
  ).all(docId, maxContextDocs) as any[];

  const suggested = await detectConnections(docRow.title, docRow.summary, existingDocs);

  const validIds = new Set(existingDocs.map((d: any) => d.id));
  const connections: Connection[] = suggested
    .filter(c => validIds.has(c.doc_id))
    .map(c => graphDb.addConnection({
      from_id:  docId,
      to_id:    c.doc_id,
      relation: sanitizeRelation(c.relation),
      strength: Math.max(0, Math.min(1, c.strength ?? 0.5)),
      note:     c.reason ?? null,
      source:   'ai',
    }));

  // Авто-определение URL-цитат
  const citations = graphDb.autoDetectCitations(docId);

  return { entities: step1.entities ?? [], facts, connections: [...connections, ...citations] };
}

export async function synthesizeCluster(
  docIds:  string[],
  graphDb: GraphDB
): Promise<string> {
  if (docIds.length === 0) return '';

  const docs = docIds.map(id => {
    const row = (graphDb as any).db.prepare(
      'SELECT title, summary, content_type FROM docs WHERE id = ?'
    ).get(id) as any;
    const facts = graphDb.getFacts(id).slice(0, 4);
    return row
      ? `## ${row.title} (${row.content_type})\n${row.summary}\n${facts.map((f: any) => `- ${f.claim}`).join('\n')}`
      : null;
  }).filter(Boolean).join('\n\n---\n\n');

  const edges = docIds.flatMap(id =>
    graphDb.getConnections(id, { direction: 'outbound', minStrength: 0.4 })
      .filter(c => docIds.includes(c.to_id))
      .map(c => `• "${c.other_title}" [${c.relation} / ${c.strength.toFixed(2)}]${c.note ? ': ' + c.note : ''}`)
  );

  const prompt = `Напиши аналитический синтез (3–5 абзацев) на основе этих документов.
Выдели: ключевые идеи, противоречия, пробелы в знаниях.

ДОКУМЕНТЫ:
${docs}

СВЯЗИ:
${edges.join('\n')}`;

  if (USE_OLLAMA) {
    return ollamaGenerate(prompt, { think: true, numCtx: 16_384, temperature: 0.3 });
  }
  if (USE_ANTHROPIC) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const res = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }
  throw new Error('Не задан ни OLLAMA_HOST, ни ANTHROPIC_API_KEY');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALL_RELATIONS = new Set([
  'cites','extends','contradicts','is_part_of',
  'supports','mentions','shares_topic',
  'similar_to','relates_to','co_referenced',
]);

function sanitizeRelation(rel: string): Relation {
  const n = (rel ?? '').toLowerCase().trim().replace(/[-\s]/g, '_');
  return ALL_RELATIONS.has(n) ? (n as Relation) : 'relates_to';
}
