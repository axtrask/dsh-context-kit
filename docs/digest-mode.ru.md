# Режим `digest`: как сжимать сами сжатия

Документ отвечает на один вопрос: почему повторное сжатие **добавляет** контекст, и что
именно надо поменять, чтобы оно его **уменьшало**. Все примеры JSON — реальные, снятые
с диска (`~/.dsh/context-kit/dcp-state/`) и из кода (`lib/dcp.js`,
`lib/dcp-block-placeholders.js`).

---

## 1. Коротко: сейчас и как предлагаю

| | **Сейчас (`carry`)** | **Предлагаю (`digest`)** |
|---|---|---|
| Что делает сжатие, накрывшее старый блок | Переносит **весь текст** старого блока в новый | Переносит **одну строку-оглавление** (стаб) |
| Кто решает | Политика инструмента, выбора нет | Флаг `digest: true` в записи `content[]` |
| Старый блок | `active: false` (в запрос не едет) | `active: false` (так же) |
| Текст старого блока | Живёт внутри нового блока → пирамида | Остаётся только в state-файле → плоско |
| Рост контекста | Треугольное число: 400 → 900 → 1500 → … | Почти линейный: 400 → 530 → 660 → … |
| Обратимость | `decompress` фактически не нужен (текст и так в запросе) | `/dcp decompress bN` возвращает текст из state-файла |
| Риск | Раздувание окна | Модель может потерять деталь (текст есть в логе и state) |
| Совместимость | Паритет с upstream | Новый необязательный ключ; по умолчанию `carry` |

---

## 2. Три слоя «внутрянки» — где что лежит

| Слой | Где | Кто читает | Переживает перезапуск |
|---|---|---|---|
| **Журнал сессии** (всё, что было) | `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd` | только аудит/восстановление | да |
| **Состояние DCP** (блоки, пруны) | `~/.dsh/context-kit/dcp-state/<session>.json` | движок, `/dcp` команды | да |
| **Запрос к модели** (то, что реально видит LLM) | собирается на каждый запрос | — | нет |

Ключевое: **журнал не меняется никогда**. Сжатие живёт между «состоянием» и «запросом».
`active: false` у блока = «не подставлять его текст в запрос», при этом `summary` блока
остаётся в state-файле и никуда не девается.

---

## 3. Как выглядит блок в state-файле (реальный JSON)

`~/.dsh/context-kit/dcp-state/compress-mtymbvgvg301-20.json` — два блока: внутренний `b1`
(2 сообщения) и внешний `b2`, который его поглотил. Поля сокращены только для
`shadowedMessageIds`.

```json
{
  "nextBlockId": 3,
  "prunedToolIds": {},
  "prunedNodes": {},
  "blocks": [
    {
      "blockId": "1",
      "topic": "inner pass",
      "start": 2, "end": 3,
      "coverage": { "start": 2, "end": 3 },
      "shadowedSeqs": [2, 3],
      "anchorMessageId": "1d990373-…",
      "summary": "[Compressed conversation section]\nINNER-BLOCK-BODY: the interior work is done.\n<dcp-message-id>b1</dcp-message-id>",
      "summaryChars": 114,
      "consumedBlockIds": [],
      "appendedBlockIds": [],
      "active": false,            // <— поглощён: в запрос НЕ едет
      "nodeSeq": 10,
      "deactivatedByUser": false
    },
    {
      "blockId": "2",
      "topic": "outer pass",
      "start": 1, "end": 8,
      "coverage": { "start": 1, "end": 8 },
      "shadowedSeqs": [1, 10, 4, 5, 6, 7, 8, 9],
      "anchorMessageId": "dc4aca99-…",
      "summary": "[Compressed conversation section]\nOuter summary.\n\nINNER-BLOCK-BODY: the interior work is done.\n\nOuter tail.\n<dcp-message-id>b2</dcp-message-id>",
      "summaryChars": 143,
      "consumedBlockIds": ["1"],   // <— чей текст вклеен внутрь
      "appendedBlockIds": [],
      "active": true,
      "nodeSeq": 12,
      "deactivatedByUser": false
    }
  ]
}
```

Смотри на две строки: `b1.active = false`, но его тело `INNER-BLOCK-BODY…` сидит внутри
`b2.summary`. **Блок выключен, а его текст всё равно в запросе.** Вот это и есть механизм
накопления.

Код, который так делает:

- `lib/dcp-block-placeholders.js:166` — `injectBlockPlaceholders`: ставит текст блока на место `(bN)`.
- `lib/dcp-block-placeholders.js:245` — если плейсхолдера не было, текст **дописывается принудительно**:
  ```js
  missing.push(`\n### (b${blockId})\n${restoreBlockSummary(target)}`);
  ```
  и заголовок к нему — `:250`: `'\n\nThe following previously compressed summaries were also part of this conversation section:'`.
- `lib/dcp.js:2481` — `absorbedIds`: какие блоки попали внутрь диапазона.
- `lib/dcp.js:2483,2488` — проверка плейсхолдеров и подстановка текста.
- `lib/dcp.js:2568` — здесь поглощённые блоки гасятся (`active: false`), но **уже после** того,
  как их текст вклеен в новый блок.
- `lib/dcp.js:2592-2593` — в новый блок пишутся `consumedBlockIds` и `appendedBlockIds`.

Пирамида в чистом виде — `~/.dsh/context-kit/dcp-state/session-fixture-8.json`, блок 3
(`summaryChars: 279` при исходном блоке в 115 символов):

```
[Compressed conversation section]
The first two steps were probed and are done.

summary body

b

The following previously compressed summaries were also part of this conversation section:
### (b1)
The first two steps we…          <— 115 символов b1 целиком
```

---

## 4. Поэтапный пример: три сжатия подряд

Числа ниже — иллюстрация (реальные размеры зависят от сессии), форматы JSON — настоящие.

### Шаг 1. Сжимаем свежий кусок A

**Модель вызывает:**

```json
{
  "topic": "Разбор DCP",
  "content": [
    { "startId": "m0012", "endId": "m0040", "summary": "Разобрали слой 1: …\nРешение: …" }
  ]
}
```

**Что появляется в state:**

```json
{
  "blockId": "1",
  "topic": "Разбор DCP",
  "start": 12, "end": 40,
  "summary": "[Compressed conversation section]\nРазобрали слой 1: …\n<dcp-message-id>b1</dcp-message-id>",
  "summaryChars": 1600,
  "consumedBlockIds": [],
  "appendedBlockIds": [],
  "active": true
}
```

**В запрос уезжает:** 1600 символов ≈ **400 токенов**. Было 8000 — сэкономили 7600. ✅

### Шаг 2. Сжимаем кусок B (диапазон накрывает b1)

**Модель вызывает:**

```json
{
  "topic": "Сжатие DCP и KB",
  "content": [
    { "startId": "m0012", "endId": "m0095", "summary": "Сжатие — политика переноса; KB держит сырьё.\n(b1)" }
  ]
}
```

**Сейчас (`carry`)** — плейсхолдер `(b1)` разворачивается в полный текст:

```json
{
  "blockId": "2",
  "summaryChars": 3600,
  "summary": "[Compressed conversation section]\nСжатие — политика переноса; KB держит сырьё.\n\nРазобрали слой 1: …\n…весь текст b1 (1600 симв.)…\n<dcp-message-id>b2</dcp-message-id>",
  "consumedBlockIds": ["1"],
  "appendedBlockIds": [],
  "active": true
}
```
→ в запрос уезжает ≈ **900 токенов** (2000 своих + 1600 унаследованных).

**Как предлагаю (`digest: true`)** — тот же вызов, один добавленный ключ:

```json
{
  "topic": "Сжатие DCP и KB",
  "content": [
    { "startId": "m0012", "endId": "m0095", "digest": true,
      "summary": "Сжатие — политика переноса; KB держит сырьё." }
  ]
}
```

```json
{
  "blockId": "2",
  "summaryChars": 2120,
  "summary": "[Compressed conversation section]\nСжатие — политика переноса; KB держит сырьё.\n\nРанее сжатые разделы (текст по /dcp decompress bN):\n- b1 «Разбор DCP», 12..40, 1600 симв.\n<dcp-message-id>b2</dcp-message-id>",
  "consumedBlockIds": ["1"],
  "absorbedBlockIds": ["1"],
  "active": true
}
```
→ в запрос уезжает ≈ **530 токенов** (2000 своих + 120 стаба). Разница с `carry` — 370 токенов
на одном шаге.

### Шаг 3. Сжимаем кусок C (накрывает b2, а тот — b1)

| | `carry` (сейчас) | `digest` |
|---|---|---|
| Свой текст | 2400 симв. (600 ток.) | 2400 симв. (600 ток.) |
| Унаследовано | b2 целиком = 3600 симв. (900 ток.) | стабы b1 + b2 = 240 симв. (60 ток.) |
| **Итого в запросе** | **1500 токенов** | **660 токенов** |
| Что в state | b1, b2 `active:false`, b3 `active:true` | то же, но у b3 тело плоское |

Дальше расхождение только растёт: `carry` на каждом шаге тащит сумму всех предыдущих
сжатий, `digest` — фиксированную шапку.

Формула, которой живёт движок (`lib/dcp.js:1186`):

```js
const summaryTokens = this.activeBlocks().reduce((total, block) => total + Math.ceil(block.summaryChars / 4), 0);
```

То есть стоимость блоков в запросе = сумма `summaryChars` **активных** блоков. `digest`
уменьшает именно `summaryChars` нового блока, а не только гасит старые.

---

## 5. Где именно менять код

| # | Файл:строка | Что сейчас | Что станет |
|---|---|---|---|
| 1 | `lib/dcp.js` (схема `content[]`) | `startId`, `endId`, `summary` | Для `digest` потребуется явное расширение строгой схемы. |
| 2 | `lib/dcp.js:2481-2488` (развилка validate→inject) | всегда `injectBlockPlaceholders` | при `digest` — `injectBlockStubs` (строка-оглавление вместо тела) |
| 3 | `lib/dcp-block-placeholders.js:166,245` | `injectBlockPlaceholders` + принудительный append | режим `stub`: плейсхолдер → `- bN «topic», start..end, N симв.` |
| 4 | `lib/dcp.js:2568` (гашение поглощённых) | гасит **после** вклейки текста | без изменений — блок так же становится `active:false` |
| 5 | `lib/dcp.js:2592-2593` (запись блока) | `consumedBlockIds`, `appendedBlockIds` | `+ absorbedBlockIds` (для аудита и отчёта) |
| 6 | `lib/dcp.js:2208-2221` (текст результата) | `— carried forward without a placeholder: (b1)` | `— absorbed as digest: (b1) [текст: /dcp decompress b1]` |
| 7 | `lib/dcp-prompts.js:124-167` (описание инструмента) | «will be replaced with the full stored compressed block content» | абзац: «с `digest: true` старые блоки заменяются оглавлением; их текст доступен `/dcp decompress bN`» |
| 8 | `lib/dcp.js:2990` (`/dcp recompress`) | блок, поглощённый сжатием, «не user-decompressed» | учесть `absorbedBlockIds`: позволить вернуть поглощённый блок в запрос |

Отдельно — конфиг:

```jsonc
// ~/.dsh/dcp.jsonc
{
  "compress": {
    "absorbedBlocks": "carry"   // "carry" (по умолчанию, паритет) | "digest"
  }
}
```

Флаг в конфиге задаёт поведение по умолчанию, `digest: true` в конкретном вызове —
разовое переопределение. Оба варианта нужны: конфиг для «хочу так всегда», ключ — чтобы
модель могла выбрать по ситуации.

---

## 6. Что нельзя сломать (паритет и тесты)

| Проверка | Что охраняет | Как поступить |
|---|---|---|
| `scripts/verify-dcp-prompts.mjs` | дословный текст промптов против upstream | новый абзац про `digest` придётся учитывать как явное отклонение от буквального upstream-текста |
| `scripts/verify-parity.mjs` | поверхность порта | должна остаться зелёной: поведение по умолчанию не меняется |
| `scripts/test-dcp-compress.mjs:594-599,672,720` | перенос текста блока, обёртка `[Compressed conversation section]` | добавить зеркальные кейсы для `digest` (стаб вместо тела, `absorbedBlockIds`, `decompress` возвращает текст) |
| `scripts/test-dcp-materialization.mjs`, `test-dcp-range.mjs` | что уезжает в запрос | прогнать, убедиться, что `carry` не тронут |

Правило: **по умолчанию — как в upstream**. `digest` включается осознанно и его результат
явно печатается в ответе инструмента, чтобы «тихой потери текста» не было.

---

## 7. Предохранители (чтобы digest не съел нужное)

1. **Стаб, а не пустота.** По умолчанию в оглавление идёт `topic`, диапазон и размер блока —
   модель видит, что текст существует, и может запросить его.
2. **`/dcp decompress bN` остаётся.** Полный текст лежит в state-файле и в журнале сессии;
   `digest` не удаляет данные, а убирает их из запроса.
3. **Явный отчёт.** В результате: `absorbed as digest: (b1), (b2) — вернуть: /dcp decompress b1`.
4. **Порог.** Не позволять `digest`, если новый текст короче ~10% поглощённого: это признак
   «сжали в никуда».
5. **`/dcp recompress` для поглощённых.** Возможность вернуть блок в запрос, если деталь
   понадобилась.

---

## 8. Инструменты вокруг (что уже есть и не требует кода)

| Инструмент | Что делает | Когда применять |
|---|---|---|
| `/compact` (`@deepseek-ai/dsh-command-compact`) | сворачивает всю поверхность в одно сообщение немедленно, обнуляет блоки | когда окно распухло и детали не жалко |
| Авто-сжатие (`dsh-compaction-basic`) | при 80% окна сворачивает самый старый участок, новый хвост (16%) оставляет дословно | постоянно, фоном; настраивается `thresholdRatio`, `retainRatio`, `auto: false` |
| `dsh-compaction-tool-result-pruner` | подрезает крупные результаты инструментов без вызова модели | всегда |
| DCP `/dcp compress` / `sweep` / `manual` | сжатие и прунинг на уровне запроса, журнал не трогает | основная работа с контекстом |
| DCP `/dcp decompress bN` / `recompress` | вернуть текст блока / вернуть блок в запрос | когда деталь понадобилась |
| KB context-mode (`ctx_index`, `ctx_search`, `ctx_batch_execute`, `ctx_execute`) | сырьё на диск (243k строк, ~7.3M токенов вне окна), в окно — попадания | любая разведка, логи, дампы |
| `subagent` / `workflow` / `ralph` | работа в отдельном контексте, в окно возвращается дистиллят | «пошерсти 8 агентами» |
| `todo_write`, goal | план и цель сессии — компрессией не сворачиваются | длинная задача |
