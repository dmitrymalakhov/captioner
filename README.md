# LoRA Caption Studio

Локальное веб-приложение для разметки изображений под Stable Diffusion LoRA. Бэкенд подключается к LM Studio по OpenAI-compatible API, отправляет изображения в vision-модель, сохраняет подписи и собирает ZIP-архив с LoRA-ready датасетом.

## Что получается в ZIP

```text
lora-dataset/
  README.txt
  training-notes.txt
  kohya_ss_dataset_guide.md
  dataset.toml
  captions.csv
  captions.jsonl
  metadata.json
  train/
    10_sks_person-person/
      0001_image.jpg
      0001_image.txt
      0002_image.png
      0002_image.txt
```

У каждой картинки рядом лежит `.txt` с тем же basename. Для Kohya folder mode указывайте папку `lora-dataset/train`. Для dataset config mode используйте `dataset.toml` из архива.

Подробная инструкция по подготовке датасета для `kohya_ss`, структуре папок, trigger phrase, repeats и captions лежит в [docs/kohya_ss_dataset_guide.md](docs/kohya_ss_dataset_guide.md).

## Запуск

1. Установите Node.js 20 или новее.
2. В LM Studio загрузите vision-capable модель.
3. В LM Studio включите локальный OpenAI-compatible server. Обычно адрес такой:

```text
http://127.0.0.1:1234/v1
```

4. Запустите приложение:

```bash
npm start
```

5. Откройте:

```text
http://127.0.0.1:5177
```

## Workflow

1. Нажмите `Проверить LM Studio`, чтобы приложение увидело модель из LM Studio.
2. Выберите модель и тип LoRA: персонаж, стиль, предмет или общее.
3. Укажите название LoRA. Приложение само подготовит trigger token, repeats и папку архива.
4. Добавьте изображения: выберите файлы, перетащите их в окно или вставьте из буфера обмена.
5. Нажмите `Разметить`.
6. Проверьте подписи в карточках. При необходимости исправьте текст и нажмите `Сохранить правки`.
7. Скачайте архив.

После перезагрузки страницы последний готовый датасет можно открыть снова через панель `Последний датасет`.

По умолчанию интерфейс открыт в простом режиме. Кнопка `Расширенные настройки` показывает технические поля для опытных пользователей: адрес/API key LM Studio, class token, профиль caption, trigger token, repeats, имя ZIP-папки, temperature, max tokens, timeout, retries и дополнительный prompt.

`Бюджет генерации` в расширенных настройках - это не context window модели. Он задает, сколько output-токенов LM Studio может потратить на ответ через API. Для reasoning-моделей этот бюджет включает скрытые reasoning tokens, поэтому дефолт стоит 2048 даже для коротких captions.

## Логика caption для LoRA

Caption prompt уже настроен под подготовку LoRA-датасетов:

- первый comma-separated tag всегда содержит trigger phrase, например `sks_person person`;
- `dataset.toml` использует `shuffle_caption = true`, `keep_tokens = 1` и `caption_extension = ".txt"`, поэтому trigger остается закрепленным при shuffle captions;
- модель получает профильную стратегию для `Персонаж`, `Стиль`, `Предмет` или `Общее`;
- captions описывают только видимые training-relevant детали: позу, ракурс, одежду, материалы, цвета, фон, свет, medium/style и композицию;
- дефолтный caption целится примерно в 16-24 полезных тега, без длинной простыни повторов;
- для character LoRA trigger используется как якорь личности, а изменяемые детали описываются, чтобы они не запекались в концепт;
- для style LoRA описываются и содержимое кадра, и стиль, чтобы стиль не привязался к одному объекту;
- для product/object LoRA описываются форма, материал, цвет, угол, окружение и свет;
- из ответа модели автоматически вычищаются низкоценные booster-теги вроде `masterpiece`, `best quality`, `8k`, `highres`, `watermark`;
- backend дополнительно сжимает near-duplicate теги по группам: одежда, обувь, сумки, фон, архитектура, свет, depth-of-field и стиль съемки;
- дополнительный промпт в интерфейсе может уточнять словарь, но базовый формат `trigger, tag, tag...` сохраняется.

## Как готовить хорошие описания

Хороший caption объясняет модели, что является концептом LoRA, а что является
переменной деталью конкретной картинки. Пиши описание как набор проверяемых
визуальных фактов, а не как красивый prompt для генерации.

Практические правила:

- один тег - одна основная визуальная мысль: `red leather jacket`, `three-quarter view`, `soft window light`;
- переменные детали нужно подписывать явно, чтобы они не прилипали к trigger: одежда, выражение, поза, кадрирование, фон, свет, материал, цвет;
- если деталь не очевидна, выбирай нейтральный видимый термин: `person`, `printed text`, `storefront`, `device`, `patterned fabric`;
- не угадывай имена, бренды, точный OCR-текст, место, художника или скрытый контекст;
- не смешивай синонимы и противоречия: лучше `tan oversized blazer`, чем `camel blazer, oversized jacket, coat`;
- не добавляй отсутствующие признаки вроде `no logo`, `no background`, `not visible`;
- не используй `maybe`, `probably`, `looks like`, `appears to be` - такие теги путают и локальную LLM, и обучаемую LoRA.

Пример хорошего caption:

```text
sks_person person, close-up portrait, looking at camera, red leather jacket, short dark hair, blurred city background, soft daylight, photo
```

Плохой вариант:

```text
sks_person person, beautiful, best quality, maybe celebrity, looks like a brand jacket, no logo, ultra detailed
```

## Надежность

- Jobs сохраняются на диск в `.captioner/jobs/` и completed-архивы доступны после перезапуска сервера.
- Если сервер перезапустился во время обработки, уже готовые captions сохраняются, а незавершенные изображения помечаются ошибкой.
- Обработка идет через одну глобальную очередь, чтобы несколько batch-задач не перегружали локальную LM Studio модель.
- Временные ошибки LM Studio повторяются автоматически. Количество повторов задается в `Retries`.
- Активную очередь можно отменить кнопкой `Отменить`; новые изображения после отмены не обрабатываются.

## Настройки окружения

```bash
HOST=127.0.0.1 npm start
PORT=5177 npm start
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1 npm start
LMSTUDIO_API_KEY=local-key npm start
MAX_UPLOAD_MB=1200 npm start
MAX_FILES=500 npm start
```

Загруженные job-файлы и архивы хранятся локально в `.captioner/jobs/`. Эта папка добавлена в `.gitignore`.

## Проверки

```bash
npm test
```
