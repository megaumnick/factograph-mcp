# 🧠 Factograph MCP v4

Граф знаний с файловым вводом и AI-обогащением через локальный Ollama (Qwen3:14b) или Anthropic API.

**Архитектура:** MCP-сервер живёт на Ubuntu-сервере, читает файлы локально, а LLM-инференс уходит по сети на Windows-машину с видеокартой (Ollama).

---

## Что нового в v4

Три изменения, сделанные по итогам реальной сессии в `mcphost`:

1. **Файлы без расширения больше не отбрасываются.** Раньше `ingest_file`/`ingest_directory`/`list_server_files` помечали такие файлы как `supported: false`. Дампы технической документации (например `install core`, `multiapn` без `.txt`) теперь читаются как обычный текст автоматически — расширение не обязательно.

2. **Новый инструмент `auto_link_collection`** — массовое связывание документов одним вызовом. Решает конкретный сценарий: пользователь просит *"установи связи между всеми документами"*, а модели нужно было самой спланировать цикл "обогатить каждый → сравнить" — задача, с которой 14B-модель не справлялась. Теперь это один детерминированный вызов на сервере.

3. **Описания `enrich_document`/`find_related` обновлены** — явно указывают, что для массового связывания нужно использовать `auto_link_collection`, а не вызывать их в цикле по одному документу.

### Если у тебя 0 связей после импорта

Это не баг и не "функция не поддерживается" (как иногда отвечает модель) — это значит, что у документов ещё не извлечены сущности, а без них Jaccard-сравнению просто не с чем работать. Раньше для этого нужно было вызвать `enrich_document` на каждый документ вручную; теперь `auto_link_collection` делает это сама перед расчётом связей.

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

   Либо тем же самым через MCP-инструмент:
   ```
   ping_ollama {}
   ```

---

## Установка mcphost (хост на Ubuntu Server)

> **Важно:** разработка `mcphost` остановлена, репозиторий заархивирован автором — проект пометили как замороженный (без новых фич и фиксов), а преемником назван `Kit` (тот же автор, более новая архитектура). Для текущей задачи `mcphost` всё ещё рабочий вариант — последний релиз стабилен и именно его используют примеры в этом README — но если в будущем что-то перестанет собираться или захочется новых возможностей, стоит посмотреть на `Kit` в репозиториях `mark3labs` на GitHub.

### 1. Установи Go (если ещё нет)

```bash
sudo apt update
sudo apt install golang-go
go version   # проверка
```

### 2. Установи mcphost

```bash
go install github.com/mark3labs/mcphost@latest
```

Бинарник ставится в `~/go/bin`. Добавь эту папку в `PATH`, если её там нет:

```bash
echo 'export PATH=$PATH:~/go/bin' >> ~/.bashrc
source ~/.bashrc
mcphost --help   # проверка, что бинарник нашёлся
```

Альтернатива без сборки — скачать готовый бинарник со страницы [Releases](https://github.com/mark3labs/mcphost/releases) под свою архитектуру, не устанавливая Go вовсе.

### 3. Настрой подключение к Ollama для самого mcphost

Это **отдельная** переменная окружения от той, что в `.env` нашего MCP-сервера — `mcphost` сам общается с Ollama напрямую для самого чата с моделью, а `.env` факторграфа отвечает только за то, как `enrich_document`/`synthesize_cluster` достают Ollama. Их обычно указывают на один и тот же адрес, но задаются они раздельно:

```bash
export OLLAMA_HOST=http://192.168.1.50:11434
```

Для других провайдеров (если когда-нибудь понадобятся) — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` тем же способом.

### 4. Создай конфиг `~/.mcp.json`

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

### 5. Запусти

```bash
mcphost --model ollama:qwen3:14b --config ~/.mcp.json
```

При старте в логе должно появиться что-то вроде `Loaded 25 tools from MCP servers` — если число другое, проверь, не упал ли factograph-сервер при старте (смотри stderr — там пишет `[factograph-mcp] запущен`).

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

## Подключение к Claude Desktop

Если хочешь использовать тот же MCP-сервер не через `mcphost`, а из Claude Desktop:

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

Конфиг для `mcphost` (`~/.mcp.json`) — смотри раздел «Установка mcphost» выше, формат `mcpServers` идентичен.

---

## Все инструменты (25 штук)

### Слой 1 — Пинборд (8)
`pin_document` · `list_pins` · `search_pins` · `get_pin` · `update_pin` · `unpin` · `list_collections` · `export_collection`

### Слой 2 — Граф знаний (10)
`link_documents` · `get_connections` · `traverse_graph` · `enrich_document` · `find_by_entity` · `find_related` · **`auto_link_collection`** · `get_facts` · `synthesize_cluster` · `graph_stats`

### Слой 3 — Файлы на сервере + диск-хранилище (7)
| Инструмент | Описание |
|---|---|
| `ingest_file` | Прочитать файл (PDF/DOCX/код/текст, в т.ч. без расширения) и добавить в базу |
| `ingest_directory` | Массовый импорт папки (рекурсивно, с фильтром расширений) |
| `list_server_files` | Посмотреть содержимое директории на сервере |
| `ping_ollama` | Проверить связь с Windows-машиной и список моделей |
| `save_graph` | Сохранить весь граф (узлы+связи+факты) в JSON на диск |
| `load_graph` | Загрузить граф из JSON (merge, skip/overwrite конфликтов) |
| `export_edges` | Связи → CSV (Excel) или DOT (Graphviz-визуализация) |

---

## auto_link_collection — как это работает

```
auto_link_collection {
  collection:  "research",   // опционально — иначе вся база
  use_ai:      true,         // обогатить документы без сущностей перед связыванием
  min_jaccard: 0.1           // порог схожести для авто-связей
}
```

Шаг 1 — для каждого документа в наборе проверяется, есть ли у него извлечённые сущности. Если нет и `use_ai: true` — документ прогоняется через `enrich_document` (Ollama/Anthropic) автоматически.

Шаг 2 — для всех документов набора считается Jaccard-пересечение сущностей, создаются связи `similar_to` (Jaccard ≥ 0.25) или `shares_topic` (ниже).

Возвращает сводку: сколько документов обогащено, сколько связей создано, и сами связи (до 50 штук в ответе). Если связей всё равно 0 — подсказка в поле `hint` рекомендует понизить `min_jaccard`.

---

## Типичный рабочий процесс

```
1. Узнать что лежит на сервере
   list_server_files { path: "/mnt/data/papers" }

2. Массовый импорт (без авто-обогащения на этом шаге — дешевле и быстрее)
   ingest_directory {
     path: "/mnt/data/papers",
     recursive: true,
     extensions: ["pdf", "md"],   // не указывать — заберёт и файлы без расширения
     collection: "research"
   }

3. Связать все документы коллекции одним вызовом
   auto_link_collection { collection: "research" }

4. Исследовать граф
   traverse_graph { doc_id: "...", max_depth: 3 }
   find_by_entity { entity: "transformer" }

5. Сохранить граф на диск (бэкап / версионирование)
   save_graph { path: "/home/user/backups/graph-2026-06-19.json" }

6. Визуализировать
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

## Известные ограничения

- **Tool-calling у Qwen3:14b не идеален.** Модель иногда домысливает параметры, которых нет в схеме (например, пыталась вызвать `ingest_file` с `paths` вместо `path`). `mcphost` сам отдаёт ошибку обратно модели и она обычно восстанавливается на следующей попытке — но это вероятностное поведение, не гарантия.
- **Описания тулов — это намёк, а не команда.** Несмотря на явные формулировки в `auto_link_collection` про "не вызывай по одному", модель технически может всё равно выбрать ручной цикл по `enrich_document`. Если заметишь такое поведение — попроси прямо: *"используй auto_link_collection"*.
- Авто-связи (`similar_to`/`shares_topic`) считаются только по пересечению сущностей. Если у документов мало общих именованных сущностей, но они тематически близки — Jaccard может не найти связь. В этом случае выручит `synthesize_cluster` или ручной `link_documents`.

---

## Структура файлов

```
src/
├── types.ts          ← PinnedDocument schema
├── pdf-parse.d.ts    ← минимальные типы для pdf-parse (он их не публикует)
├── db.ts             ← DocumentDB (docs + FTS5)
├── processor.ts      ← URL fetch, HTML→text
├── ingest.ts         ← чтение файлов с диска (PDF/DOCX/код/текст, поддержка файлов без расширения) + сканирование папок
├── graph-types.ts    ← Connection, Fact, Relation
├── graph.ts          ← GraphDB (связи, сущности, факты, BFS, Jaccard, настраиваемый autoConnectByEntities)
├── ollama.ts         ← HTTP-клиент Ollama (JSON mode, /no_think для Qwen3)
├── enricher.ts       ← AI-обогащение (Ollama приоритетно, Anthropic fallback)
├── graph-store.ts    ← save/load графа в JSON, экспорт CSV/DOT
├── file-tools.ts     ← MCP-инструменты слоя 3 (ingest_*, save_graph, ...)
└── index.ts          ← MCP-сервер, все 25 инструментов (включая auto_link_collection)
```
