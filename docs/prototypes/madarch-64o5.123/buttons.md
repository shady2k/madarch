# The catalogue's press goes on, and a disabled press says why

Mockup for madarch-64o5.123, drawn from the catalogue's selection mode and the preparation page after the
change.

Catalogue, selection mode, nothing chosen:

    [x] Файлы       2 записи · В продукте · Заполнит: Файловая система, История git
    [ ] Циклы       0 записей · Кольцо зависимостей · Заполнит агент: Уровень, Состав, Размер · Нужно для «Сценарии»
    [ ] Модули      0 записей · Модуль кода · Заполнит агент: Имя · Нужно для «Циклы»

    Выбран 1 вид · добавлено 4 зависимости           [ К настройке запуска ] Выберите хотя бы один вид

The press is off only while nothing is chosen, and the words beside it say so. A prerequisite the agent
alone fills is marked «Заполнит агент» and travels with the selection to the preparation page.

Preparation page with `code.cycle` and `code.module`, «Только плагины»:

    Что будет заполнено
      1. Репозитории · нужно для «Файлы»      Плагины заполнят: Файловая система, История git
      ...
    Кто заполнит
      ( ) Только плагины
      ( ) Claude Code
    Останутся пустыми 3 поля в 2 видах   (opens)
      Модули: Имя
      Циклы: Уровень, Состав, Размер

    [ Начать заполнение ] ≈ 1 мин

Choosing an agent makes those kinds the agent's own work: no plan error stands and the press is on.
