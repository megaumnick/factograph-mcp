# 🧠 Factograph MCP v3

Граф знаний с файловым вводом и AI-обогащением через локальный Ollama (Qwen3:14b) или Anthropic API.

**Архитектура:** MCP-сервер живёт на Ubuntu-сервере, читает файлы локально, а LLM-инференс уходит по сети на Windows-машину с видеокартой (Ollama).

---

## Установка на Ubuntu Server

```bash
git clone <repo> factograph-mcp   # или просто распакуй архив
cd factograph-mcp
npm install
npm run build
cp .env.example .env
nano .env   # вписать IP Windows-машины и разрешённые папки
```

### Зависимости для PDF/DOCX (опционально)

`pdf-parse` и `mammoth` лежат в `optionalDependencies` — если `npm install` их не поставил:

```bash
npm install pdf-parse mammoth
```

---

## Настройка Ollama на Windows 11

1. Установи Ollama, стяни модель:
   ```powershell
   ollama pull qwen3:14b
   ```

2. **Разреши сетевой доступ** (по умолчанию Ollama слушает только localhost):

   Через переменную окружения перед запуском —
   ```powershell
   $env:OLLAMA_HOST = "0.0.0.0:11434"
   ollama serve
   ```
   Или навсегда: Win+R → `sysdm.cpl` → Advanced → Environment Variables →
   добавить `OLLAMA_HOST=0.0.0.0:11434` → перезапустить Ollama.

3. **Открой порт в Windows Firewall**:
   ```powershell
   New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow
   ```

4. Узнай IP машины: `ipconfig` → IPv4 Address (например `192.168.1.50`).

5. Проверь с Ubuntu-сервера:
   ```bash
   curl http://192.168.1.50:11434/api/tags
   ```
   Должен вернуться список моделей.

---

## Конфигурация `.env`

```bash
OLLAMA_HOST=http://192.168.1.50:11434
OLLAMA_MODEL=qwen3:14b

# Папки, из которых MCP разрешено читать файлы (через :)
ALLOWED_ROOTS=/home/user/documents:/mnt/data

# Авто-сохранение графа на диск при старте/остановке сервера
AUTO_SAVE_PATH=/home/user/.document-pinboard/graph.json
```

Если `OLLAMA_HOST` не задан, но задан `ANTHROPIC_API_KEY` — сервер автоматически переключится на Claude API как fallback.

---

## Подключение к Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "factograph": {
      "command": "node",
      "args": ["/home/user/factograph-mcp/dist/index.js"],
      "env": {
        "OLLAMA_HOST": "http://192.168.1.50:11434",
        "OLLAMA_MODEL": "qwen3:14b",
        "ALLOWED_ROOTS": "/home/user/documents:/mnt/data",
        "AUTO_SAVE_PATH": "/home/user/.document-pinboard/graph.json"
      }
    }
  }
}
```

---

## Все инструменты (21 штука)

### Слой 1 — Пинборд
`pin_document` · `list_pins` · `search_pins` · `get_pin` · `update_pin` · `unpin` · `list_collections` · `export_collection`

### Слой 2 — Граф знаний
`link_documents` · `get_connections` · `traverse_graph` · `enrich_document` · `find_by_entity` · `find_related` · `get_facts` · `synthesize_cluster` · `graph_stats`

### Слой 3 — Файлы на сервере + диск-хранилище
| Инструмент | Описание |
|---|---|
| `ingest_file` | Прочитать файл (PDF/DOCX/код/текст) и добавить в базу |
| `ingest_directory` | Массовый импорт папки (рекурсивно, с фильтром расширений) |
| `list_server_files` | Посмотреть содержимое директории на сервере |
| `ping_ollama` | Проверить связь с Windows-машиной и список моделей |
| `save_graph` | Сохранить весь граф (узлы+связи+факты) в JSON на диск |
| `load_graph` | Загрузить граф из JSON (merge, skip/overwrite конфликтов) |
| `export_edges` | Связи → CSV (Excel) или DOT (Graphviz-визуализация) |

---

## Типичный рабочий процесс

```
1. Узнать что лежит на сервере
   list_server_files { path: "/mnt/data/papers" }

2. Массовый импорт с AI-обогащением
   ingest_directory {
     path: "/mnt/data/papers",
     recursive: true,
     extensions: ["pdf", "md"],
     collection: "research",
     auto_enrich: true     ← каждый файл идёт на Qwen3 через Ollama
   }

3. Исследовать граф
   traverse_graph { doc_id: "...", max_depth: 3 }
   find_by_entity { entity: "transformer" }

4. Сохранить граф на диск (бэкап / версионирование)
   save_graph { path: "/home/user/backups/graph-2026-06-19.json" }

5. Визуализировать
   export_edges { path: "/tmp/graph.dot", format: "dot" }
   # затем на сервере: dot -Tsvg /tmp/graph.dot > graph.svg
```

---

## Диск-хранилище графа: как это устроено

Граф **всегда** живёт в SQLite (`~/.document-pinboard/pins.db`) — это основной источник истины.
JSON-снэпшоты через `save_graph`/`load_graph` — это:

- **Бэкапы** — на случай порчи БД
- **Версионирование** — `git add graph.json` для истории изменений графа
- **Перенос** — скопировать граф на другую машину без переноса всего SQLite-файла
- **AUTO_SAVE_PATH** — если задан в `.env`, граф автоматически грузится при старте сервера и сохраняется при остановке (SIGINT/SIGTERM)

`load_graph` по умолчанию работает в режиме `skip` — не трогает существующие записи при совпадении ID, что делает его безопасным для повторного запуска.

---

## Безопасность

- `ALLOWED_ROOTS` ограничивает `ingest_file`/`ingest_directory`/`list_server_files` только указанными директориями. Если оставить пустым — доступ к всей файловой системе сервера (не рекомендуется на боевом сервере).
- Все пути проходят через `safePath()`, который резолвит `..`-трюки и directory traversal.

---

## Структура файлов

```
src/
├── types.ts          ← PinnedDocument schema
├── pdf-parse.d.ts     ← минимальные типы для pdf-parse (он их не публикует)
├── db.ts             ← DocumentDB (docs + FTS5)
├── processor.ts      ← URL fetch, HTML→text
├── ingest.ts          ← чтение файлов с диска (PDF/DOCX/код/текст) + сканирование папок
├── graph-types.ts    ← Connection, Fact, Relation
├── graph.ts          ← GraphDB (связи, сущности, факты, BFS, Jaccard)
├── ollama.ts          ← HTTP-клиент Ollama (JSON mode, /no_think для Qwen3)
├── enricher.ts        ← AI-обогащение (Ollama приоритетно, Anthropic fallback)
├── graph-store.ts     ← save/load графа в JSON, экспорт CSV/DOT
├── file-tools.ts      ← MCP-инструменты слоя 3 (ingest_*, save_graph, ...)
└── index.ts          ← MCP-сервер, все 21 инструмент
```
