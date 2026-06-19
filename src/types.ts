// Единый стандарт документа в пинборде

export type SourceType = 'url' | 'text';
export type ContentType = 'article' | 'note' | 'code' | 'reference' | 'data' | 'other';

export interface PinnedDocument {
  id: string;              // UUID v4
  title: string;           // Заголовок (авто или ручной)
  source: string;          // URL или "manual"
  source_type: SourceType;
  content_type: ContentType;
  content: string;         // Основной текст
  summary: string;         // Краткое описание (авто)
  tags: string[];          // Плоские теги
  collection: string | null; // Папка / коллекция
  metadata: Record<string, unknown>; // Доп. данные (word_count, url, notes…)
  pinned_at: string;       // ISO 8601
  updated_at: string;      // ISO 8601
}

export interface SearchResult extends PinnedDocument {
  rank?: number;
}

export interface ListResult {
  items: PinnedDocument[];
  total: number;
  offset: number;
  limit: number;
}
