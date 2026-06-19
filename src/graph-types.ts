// Типы связей — от сильных (явных) к слабым (вычисленным)
export const STRONG_RELATIONS   = ['cites', 'extends', 'contradicts', 'is_part_of'] as const;
export const MEDIUM_RELATIONS   = ['supports', 'mentions', 'shares_topic'] as const;
export const WEAK_RELATIONS     = ['similar_to', 'relates_to', 'co_referenced'] as const;

export type StrongRelation = typeof STRONG_RELATIONS[number];
export type MediumRelation = typeof MEDIUM_RELATIONS[number];
export type WeakRelation   = typeof WEAK_RELATIONS[number];
export type Relation       = StrongRelation | MediumRelation | WeakRelation;

export const DEFAULT_STRENGTH: Record<Relation, number> = {
  // сильные — явные, верифицированные
  cites:         0.95,
  extends:       0.90,
  contradicts:   0.90,
  is_part_of:    0.95,
  // средние — выведенные из сущностей / контента
  supports:      0.65,
  mentions:      0.55,
  shares_topic:  0.50,
  // слабые — вычисленные / семантические
  similar_to:    0.35,
  relates_to:    0.25,
  co_referenced: 0.20,
};

export interface Connection {
  id:         string;
  from_id:    string;
  to_id:      string;
  relation:   Relation;
  strength:   number;        // 0.0–1.0
  note:       string | null;
  // как связь была создана
  source:     'manual' | 'auto-citation' | 'auto-entity' | 'auto-semantic' | 'ai';
  created_at: string;
}

// Атомарный факт, извлечённый из документа
export interface Fact {
  id:         string;
  doc_id:     string;
  claim:      string;        // «GPT-4 достигает 87% на MMLU»
  entities:   string[];      // ['GPT-4', 'MMLU']
  confidence: number;        // 0.0–1.0
  span:       string | null; // цитата из источника (до 200 символов)
  created_at: string;
}

// Узел в результате обхода графа
export interface GraphNode {
  doc_id:       string;
  title:        string;
  content_type: string;
  depth:        number;
  connections:  (Connection & { other_title: string; other_type: string })[];
}

// Результат обогащения документа через AI
export interface EnrichmentResult {
  entities:    string[];
  facts:       Fact[];
  connections: Connection[];
}
