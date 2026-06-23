# Подготовка датасета для kohya_ss LoRA

Эта инструкция описывает, как готовить датасет для обучения LoRA в
`kohya_ss` / `sd-scripts`, зачем нужны отдельные файлы датасета и куда их
указывать в интерфейсе обучения.

Полезные ссылки:

- kohya_ss GUI: <https://github.com/bmaltais/kohya_ss>
- sd-scripts: <https://github.com/kohya-ss/sd-scripts>
- LoRA в AUTOMATIC1111: <https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Features#lora>

## Главное

AUTOMATIC1111 обычно используют для генерации и проверки LoRA, а обучают LoRA
в отдельном интерфейсе `kohya_ss`.

LoRA-датасет - это не просто набор картинок. Для хорошего результата нужны:

- изображения с нужным персонажем, стилем, предметом или общей концепцией;
- `.txt` caption рядом с каждой картинкой;
- стабильный trigger phrase в начале каждого caption;
- структура папок, которую понимает kohya_ss;
- достаточно разнообразия, чтобы модель выучила именно концепт, а не случайный
  фон, одежду, ракурс или освещение.

## Что создает LoRA Caption Studio

После разметки приложение собирает ZIP примерно такой структуры:

```text
lora-dataset/
  README.txt
  training-notes.txt
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

Для `kohya_ss` важнее всего:

- `train/` - папка с training subsets;
- `10_sks_person-person/` - папка одного subset;
- `*.jpg`, `*.png`, `*.webp` - training images;
- `*.txt` - captions с тем же basename, что и картинка;
- `dataset.toml` - готовый dataset config для config mode.

## Куда класть датасет

Датасет можно распаковать в любое удобное место, например:

```text
~/sd-datasets/my-lora/lora-dataset/
```

Важно не класть рабочий датасет внутрь папки с результатами обучения. Удобная
разводка такая:

```text
~/sd-datasets/
  my-character/lora-dataset/

~/sd-training-output/
  my-character/

stable-diffusion-webui/
  models/
    Stable-diffusion/
    Lora/
```

В `kohya_ss` затем указывают либо папку `train`, либо файл `dataset.toml`.

## Два режима подключения датасета в kohya_ss

### Вариант 1. Folder mode

Укажи в `kohya_ss` папку:

```text
lora-dataset/train
```

Не внутреннюю папку `10_sks_person-person`, а именно родительскую `train`.
Kohya сам прочитает вложенную папку с repeats и class/trigger в имени.

Этот вариант удобен, если датасет простой: один персонаж, один стиль или один
предмет.

### Вариант 2. Dataset config mode

Укажи файл:

```text
lora-dataset/dataset.toml
```

Этот вариант лучше, если:

- нужно несколько subsets;
- разные subsets имеют разные repeats;
- часть датасета должна иметь другие настройки;
- хочешь, чтобы обучение точно использовало параметры из архива.

Сгенерированный `dataset.toml` выглядит по смыслу так:

```toml
[general]
shuffle_caption = true
caption_extension = ".txt"
keep_tokens = 1
enable_bucket = true

[[datasets]]
resolution = 1024
batch_size = 1

  [[datasets.subsets]]
  image_dir = "./train/10_sks_person-person"
  num_repeats = 10
  class_tokens = "sks_person person"
  caption_extension = ".txt"
```

## Зачем нужен trigger phrase

Trigger phrase - это фраза, которой ты потом вызываешь LoRA в prompt.

Пример:

```text
sks_person person
```

После обучения prompt в AUTOMATIC1111 будет выглядеть так:

```text
<lora:my_lora:0.7>, sks_person person, portrait photo, soft light
```

Рекомендации:

- `trigger token` должен быть редким: `sks_person`, `dmt_style`, `zxv_bag`;
- `class token` должен быть обычным классом: `person`, `style`, `bag`,
  `jacket`, `car`, `subject`;
- первый тег caption должен быть ровно trigger phrase;
- если включен `shuffle_caption`, ставь `keep_tokens = 1`, чтобы trigger не
  перемешивался с остальными тегами.

Хорошо:

```text
sks_person person, close-up portrait, black jacket, city street, soft daylight
```

Плохо:

```text
close-up portrait, sks_person person, black jacket, masterpiece, best quality
```

## Зачем нужны repeats

Repeats говорят kohya_ss, сколько раз повторять изображения из subset за одну
эпоху.

В folder mode repeats обычно записаны в имени папки:

```text
10_sks_person-person
```

Здесь `10` означает `num_repeats = 10`.

Пример расчета:

```text
steps = images * repeats * epochs / batch_size
```

Если есть 25 картинок, repeats = 10, epochs = 10, batch size = 1:

```text
25 * 10 * 10 / 1 = 2500 steps
```

Для первого обучения обычно целятся примерно в:

- персонаж: 1500-3000 steps;
- предмет: 1200-2500 steps;
- стиль: 2500-6000 steps, зависит от разнообразия;
- маленький тестовый прогон: 500-1000 steps.

## Как выбирать изображения

Цель датасета - показать модели, что должно повторяться, а что должно меняться.

Для лица / портрета:

- 20-35 изображений для первого нормального прогона;
- большая часть кадров должна хорошо показывать лицо: close-up, headshot,
  портрет по плечи;
- добавь разные ракурсы лица: анфас, три четверти, профиль, взгляд в камеру и
  в сторону;
- меняй выражение, свет, фон, одежду и аксессуары, чтобы LoRA не закрепила
  один портретный кадр как единственный возможный;
- убирай кадры, где лицо маленькое, сильно размыто, закрыто рукой, маской,
  интерфейсом или другим человеком.

Для персонажа:

- 15-40 изображений для первого нормального прогона;
- разные ракурсы: лицо, полурост, полный рост;
- разная одежда, фон и свет;
- без повторов почти одинаковых кадров;
- не все картинки из одной фотосессии.

Для предмета:

- 10-30 изображений;
- разные углы и масштабы;
- разные фоны;
- видимые важные детали формы, материала, цвета, логотипов;
- не обрезать объект так, чтобы модель не видела его форму целиком.

Для стиля:

- 30-100+ изображений;
- разные сюжеты, композиции и объекты;
- общий стиль должен повторяться, содержимое кадра должно меняться;
- если все картинки только с одним типом объекта, LoRA может выучить объект
  вместо стиля.

Для SDXL:

- не обязательно приводить все изображения к квадрату;
- полезно иметь достаточно крупные изображения;
- включай buckets, чтобы kohya_ss сам группировал aspect ratios;
- базовая training resolution чаще всего `1024`.

Из датасета лучше убрать:

- watermark, подписи, интерфейсные элементы;
- совсем размытые и битые картинки;
- дубликаты и near-duplicates;
- изображения с чужими сильными стилевыми артефактами, если они не часть
  целевого стиля;
- картинки, где нужный объект слишком маленький или закрыт.

## Как писать captions

Caption должен помогать модели отделить концепт от переменных деталей.

Общее правило:

```text
trigger phrase, visible subject details, pose/view, clothing/material/color, background, lighting, medium/style
```

Хорошее описание - это не красивый prompt, а компактная карта видимых признаков
для обучения:

- один тег описывает одну основную визуальную мысль;
- каждый тег должен быть понятен сам по себе после `shuffle_caption`;
- переменные детали, которые не должны стать частью trigger, нужно писать явно:
  одежда, выражение, поза, кадрирование, фон, свет, материал и цвет;
- если деталь неочевидна, используй нейтральный видимый термин: `person`,
  `printed text`, `storefront`, `device`, `patterned fabric`;
- не угадывай имя человека, бренд, точный OCR-текст, место, художника или
  скрытый контекст;
- не добавляй отсутствующие признаки: `no logo`, `no background`,
  `not visible`;
- не используй неопределенность: `maybe`, `probably`, `looks like`,
  `appears to be`.

Хорошо:

```text
sks_person person, close-up portrait, looking at camera, red leather jacket, short dark hair, blurred city background, soft daylight, photo
```

Плохо:

```text
sks_person person, beautiful, best quality, maybe celebrity, looks like a brand jacket, no logo, ultra detailed
```

### Персонаж

Описывай изменяемые детали, чтобы они не запекались в персонажа:

```text
sks_person person, close-up portrait, looking at camera, black leather jacket, blurred city background, soft daylight, photo
```

Если у персонажа в датасете всегда черная куртка, но ты не хочешь, чтобы LoRA
всегда генерировала черную куртку, обязательно пиши `black leather jacket` в
caption. Так модель понимает, что это отдельное условие, а не часть личности.

### Лицо / портрет

Используй этот профиль, когда LoRA должна точнее держать лицо и портретную
похожесть:

```text
sks_person person, close-up portrait, three-quarter face view, looking at camera, slight smile, short dark hair, soft side light, blurred indoor background, photo
```

В captions для лица приоритетны портретное кадрирование, ракурс лица, взгляд,
выражение, волосы у лица, борода, очки, макияж, перекрытия и свет на лице.
Одежду и фон тоже можно писать, но компактно и только если они видимы.

### Предмет

Описывай форму, материал, цвет, ракурс и окружение:

```text
zxv_bag bag, red leather handbag, gold clasp, front view, on wooden table, studio lighting, product photo
```

### Стиль

Описывай и содержимое кадра, и стилевые признаки:

```text
dmt_style style, mountain landscape, small cabin, muted colors, rough brush texture, atmospheric perspective, painterly illustration
```

Если caption содержит только `dmt_style style`, модель хуже понимает, что в
кадре является стилем, а что сюжетом.

## Что не писать в captions

Обычно не нужны:

- `masterpiece`;
- `best quality`;
- `8k`;
- `highres`;
- `ultra detailed`;
- `trending on artstation`;
- длинные повторы одного и того же смысла;
- теги, которых нет на изображении.

Caption должен описывать training-relevant видимые признаки, а не быть prompt
для красивой генерации.

## Workflow в LoRA Caption Studio

1. Запусти LM Studio с vision-capable моделью и OpenAI-compatible server.
2. Запусти приложение:

```bash
npm start
```

3. Открой:

```text
http://127.0.0.1:5177
```

4. Выбери тип LoRA: лицо, персонаж, стиль, предмет или общее.
5. Укажи название LoRA. Приложение подготовит trigger token, class token,
   repeats и имя ZIP-папки.
6. Добавь изображения.
7. Нажми `Разметить`.
8. Проверь captions вручную:
   - trigger phrase стоит первым тегом;
   - caption не состоит только из trigger;
   - важные переменные детали описаны;
   - мусорные booster-теги удалены;
   - нет выдуманных деталей.
9. Нажми `Сохранить правки`, если менял captions.
10. Скачай ZIP.
11. Распакуй ZIP в папку датасетов.
12. В kohya_ss укажи `lora-dataset/train` или `lora-dataset/dataset.toml`.

## Базовые настройки kohya_ss для SDXL LoRA

Для первого прогона на SDXL / JuggernautXL:

```text
Pretrained model name or path: путь к .safetensors checkpoint
Train data dir: lora-dataset/train
или Dataset config: lora-dataset/dataset.toml
Resolution: 1024
Enable buckets: on
Caption extension: .txt
Train batch size: 1
Network module: networks.lora
Network rank: 16 или 32
Network alpha: 16 или 32
UNet learning rate: 1e-4
Text encoder learning rate: 5e-6 или выключить text encoder для первого теста
Save model as: safetensors
Mixed precision: fp16 или bf16, если железо поддерживает
```

После обучения положи результат в:

```text
stable-diffusion-webui/models/Lora/
```

В AUTOMATIC1111 нажми refresh в Extra Networks или перезапусти WebUI.

Prompt:

```text
<lora:my_lora:0.7>, sks_person person, portrait photo
```

## Чеклист перед обучением

- Все изображения открываются и не битые.
- Рядом с каждой картинкой есть `.txt` с тем же basename.
- Первый comma-separated tag - trigger phrase.
- `dataset.toml` указывает на существующую папку внутри распакованного архива.
- В folder mode выбран `lora-dataset/train`, а не внутренняя subset-папка.
- Для SDXL стоит resolution `1024` и включены buckets.
- В captions нет watermark/booster/quality мусора.
- Датасет содержит разнообразие фонов, ракурсов и освещения.
- Output dir в kohya_ss не совпадает с папкой датасета.
- Финальная LoRA сохраняется в `.safetensors`.

## Частые ошибки

### LoRA копирует фон или одежду

Причина: мало разнообразия или captions не описывают переменные детали.

Что сделать:

- добавить картинки с другими фонами и одеждой;
- явно подписать одежду, фон и свет;
- уменьшить steps, если LoRA уже переобучилась.

### LoRA плохо вызывает персонажа

Причина: trigger phrase не закреплен или слишком мало чистых изображений.

Что сделать:

- проверить, что trigger phrase стоит первым тегом в каждом `.txt`;
- использовать `keep_tokens = 1`;
- добавить крупные портреты и изображения с хорошей видимостью лица;
- попробовать rank 32 вместо 16.

### LoRA слишком жесткая

Признаки: всегда один ракурс, одежда, фон или выражение.

Что сделать:

- снизить weight в prompt, например с `1.0` до `0.6-0.8`;
- уменьшить steps;
- добавить разнообразные картинки;
- убрать near-duplicates.

### kohya_ss не видит captions

Проверь:

- расширение `.txt`, а не `.caption` или `.text`;
- имена совпадают: `0001_image.jpg` и `0001_image.txt`;
- в настройках указано `caption_extension = ".txt"`;
- выбран правильный путь к `train` или `dataset.toml`.

### SDXL LoRA странно работает в A1111

Проверь, что:

- LoRA обучалась на SDXL checkpoint;
- в A1111 выбран SDXL checkpoint;
- LoRA лежит в `models/Lora`;
- prompt содержит `<lora:name:weight>` и trigger phrase.

SDXL LoRA не нужно использовать с SD 1.5 checkpoint, и наоборот.
