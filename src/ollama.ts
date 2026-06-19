/**
 * ollama.ts — HTTP-клиент для Ollama (Qwen3:14b на Windows PC)
 *
 * Конфиг через .env:
 *   OLLAMA_HOST=http://192.168.x.x:11434   ← IP Windows-машины
 *   OLLAMA_MODEL=qwen3:14b
 */

export const OLLAMA_HOST  = process.env.OLLAMA_HOST  ?? 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen3:14b';

export interface OllamaMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  model:   string;
  message: { role: string; content: string };
  done:    boolean;
  eval_count?:   number;
  prompt_eval_count?: number;
}

interface OllamaChatOpts {
  /** Формат ответа. 'json' — принудительный JSON (рекомендуется для структурных задач) */
  json?:        boolean;
  /** Температура. Для JSON-извлечения держим низкой (0.1) */
  temperature?: number;
  /** Размер контекста. Qwen3:14b поддерживает до 32k */
  numCtx?:      number;
  /**
   * Думать или нет (Qwen3 thinking tokens).
   * Для структурных JSON-задач отключаем — добавляет /no_think в конец запроса.
   * Для синтеза/анализа можно включить (think: true).
   */
  think?:       boolean;
  /** Таймаут в мс (по умолчанию 2 минуты — 14B модель медленная) */
  timeoutMs?:   number;
}

// ─── Основной вызов ───────────────────────────────────────────────────────────

export async function ollamaChat(
  messages: OllamaMessage[],
  opts: OllamaChatOpts = {}
): Promise<string> {
  const {
    json        = false,
    temperature = 0.1,
    numCtx      = 8192,
    think       = false,
    timeoutMs   = 120_000,
  } = opts;

  // Qwen3: добавляем /no_think в последнее сообщение пользователя
  // чтобы отключить режим размышлений для детерминированных задач
  let processedMessages = [...messages];
  if (!think) {
    const lastUserIdx = [...processedMessages].reverse()
      .findIndex(m => m.role === 'user');
    if (lastUserIdx !== -1) {
      const idx = processedMessages.length - 1 - lastUserIdx;
      processedMessages[idx] = {
        ...processedMessages[idx],
        content: processedMessages[idx].content + '\n\n/no_think',
      };
    }
  }

  const body: Record<string, unknown> = {
    model:    OLLAMA_MODEL,
    messages: processedMessages,
    stream:   false,
    options: {
      temperature,
      num_ctx: numCtx,
    },
  };

  // JSON mode — Ollama передаёт это в llama.cpp grammar
  if (json) body.format = 'json';

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json() as OllamaChatResponse;
  let content = data.message?.content ?? '';

  // Убираем <think>...</think> блоки если они всё же появились
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  return content;
}

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/** Извлекает первый валидный JSON-объект из строки */
export function extractJson<T = unknown>(text: string): T {
  // Убираем markdown-обёртки
  const clean = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Находим JSON-объект или массив
  const match = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error(`JSON не найден в ответе: ${clean.slice(0, 200)}`);

  try {
    return JSON.parse(match[1]) as T;
  } catch (e) {
    throw new Error(`JSON невалиден: ${String(e)}\nТекст: ${match[1].slice(0, 300)}`);
  }
}

/** Проверяет соединение с Ollama и возвращает список доступных моделей */
export async function pingOllama(): Promise<{
  ok:      boolean;
  host:    string;
  models:  string[];
  current: string;
  error?:  string;
}> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, host: OLLAMA_HOST, models: [], current: OLLAMA_MODEL,
               error: `HTTP ${res.status}` };
    }
    const data = await res.json() as { models: { name: string }[] };
    const models = data.models?.map(m => m.name) ?? [];
    return { ok: true, host: OLLAMA_HOST, models, current: OLLAMA_MODEL };
  } catch (e) {
    return { ok: false, host: OLLAMA_HOST, models: [], current: OLLAMA_MODEL,
             error: String(e) };
  }
}

/** Простой текстовый запрос (не JSON) — для синтеза, объяснений */
export async function ollamaGenerate(prompt: string, opts: OllamaChatOpts = {}): Promise<string> {
  return ollamaChat([{ role: 'user', content: prompt }], { think: true, ...opts });
}
