/** Engine-owned contracts. Product declarations inherit these; they never replace them.
 * These are admission declarations, not installed operational contracts or
 * durable graph version activation records.
 */

const DECLARATIONS = [
  ['run', 'Run', 'Runs', 'Прогон', 'Прогоны', 'One execution of work.', "Одно выполнение работы."],
  ['unit', 'Unit', 'Units', 'Единица работы', 'Единицы работы', 'One bounded piece of work in an execution.', "Одна ограниченная часть работы в прогоне."],
  ['event', 'Event', 'Events', 'Событие', 'События', 'One durable named happening; raw telemetry is not an entity.', "Одно именованное долговременное событие; сырая телеметрия не является сущностью."],
  ['agent-usage', 'Agent usage', 'Agent usage', 'Расход агента', 'Расходы агента', 'Recorded resource usage of agent work.', "Учтённый расход ресурсов агентской работы."],
  ['operation', 'Operation', 'Operations', 'Операция', 'Операции', 'One accepted change to graph facts.', "Одно принятое изменение фактов графа."],
  ['problem', 'Problem', 'Problems', 'Проблема', 'Проблемы', 'A condition requiring resolution.', "Условие, требующее разрешения."],
  ['question', 'Question', 'Questions', 'Вопрос', 'Вопросы', 'An unresolved question requiring an answer.', "Нерешённый вопрос, требующий ответа."],
  ['person', 'Person', 'People', 'Человек', 'Люди', 'A person who participates in the product.', "Человек, участвующий в продукте."],
  ['role', 'Role', 'Roles', 'Роль', 'Роли', 'A declared role of a participant.', "Объявленная роль участника."],
  ['plugin', 'Plugin', 'Plugins', 'Плагин', 'Плагины', 'An installed producer or reader of graph facts.', "Установленный поставщик или читатель фактов графа."],
  ['setting', 'Setting', 'Settings', 'Настройка', 'Настройки', 'A declared configurable setting.', "Объявленная настраиваемая величина."],
  ['kind', 'Kind', 'Kinds', 'Вид', 'Виды', 'A declared contract for entities in the graph.', "Объявленный контракт сущностей графа."],
] as const;

/** A fresh declaration prevents a caller from changing the trusted catalogue.
 * `label` is optional display text, never an identity or an entity reference.
 * Operational fields and relations belong to their typed contracts, not guessed
 * string references in this admission foundation.
 */
export function systemKindDeclaration(name: string): Record<string, unknown> | undefined {
  const entry = DECLARATIONS.find((entry) => entry[0] === name);
  if (entry === undefined) return undefined;
  return {
    source: 'graph', title: 'label',
    labels: { en: { one: entry[1], many: entry[2] }, ru: { one: entry[3], many: entry[4] } },
    description: { en: entry[5], ru: entry[6] },
    fields: [{ name: 'label', type: 'text', nullable: true, producers: ['system'], labels: { en: 'Label', ru: 'Название' } }],
  };
}
