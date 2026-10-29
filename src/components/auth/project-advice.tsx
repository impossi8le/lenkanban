"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";

// Advice is editorial content, not generated quotations. Only the named
// Tarasov principle has an attribution; its application below is our wording.
const advice = [
  {
    id: "facts",
    title: "Приблизься к оленю",
    text: "Прежде чем ставить задачу, уточните факты: что происходит сейчас, какой результат нужен и какие есть ограничения. Посмотрите на проблему сами, попросите пример или скриншот.",
    source: "Принцип Владимира Тарасова",
    href: "https://www.livelib.ru/book/179078/readpart-iskusstvo-upravlencheskoj-borby-vladimir-tarasov/~10",
  },
  {
    id: "decompose",
    title: "Разделите слона на части",
    text: "Большую задачу разбейте на шаги, каждый с отдельным результатом. Вместо «запустить сервис»: описать процесс, подготовить инструкции, провести пробный запуск. Начните с первого шага.",
  },
  {
    id: "done",
    title: "Опишите, что значит «готово»",
    text: "Договоритесь, как будете принимать работу. Вместо «улучшить инструкции» напишите: «Добавить пять примеров сложных случаев и согласовать с руководителем». Результат должен быть проверяемым.",
  },
  {
    id: "owner",
    title: "У задачи должен быть ответственный",
    text: "Участников может быть несколько, но назначьте одного человека, который следит за результатом. Уточните, кто помогает, кто принимает работу и к кому обращаться с вопросами.",
  },
  {
    id: "context",
    title: "Объясните, зачем нужна задача",
    text: "Добавьте к описанию цель и пользу для клиента или команды. Когда исполнитель понимает причину, он может предложить более подходящее решение, а не просто выполнить список действий.",
  },
  {
    id: "deadline",
    title: "Срок нужно согласовать",
    text: "Обсудите с исполнителем объём работы и зависимости до назначения срока. Если дата жёсткая, договоритесь, какой результат обязателен к ней, а что можно сделать следующим этапом.",
  },
  {
    id: "focus",
    title: "Заканчивайте, прежде чем начинать новое",
    text: "Посмотрите на задачи в работе перед тем, как брать следующую. Помочь завершить начатое часто полезнее, чем открыть ещё один фронт. Если всё срочно, договоритесь о порядке с руководителем.",
  },
  {
    id: "blocker",
    title: "О препятствиях сообщайте сразу",
    text: "Если задача остановилась, оставьте комментарий: что мешает, чья помощь нужна и какой следующий шаг. Не ждите срока сдачи, чтобы рассказать, что доступ или согласование так и не получили.",
  },
  {
    id: "decisions",
    title: "Сохраните договорённость в задаче",
    text: "После звонка или встречи запишите решение в карточке: что делаем, кто отвечает и к какому сроку. Приложите нужные ссылки и файлы, чтобы коллегам не пришлось искать их в переписке.",
  },
  {
    id: "feedback",
    title: "Покажите промежуточный результат",
    text: "Согласуйте черновик, макет или один готовый пример до выполнения всей работы. Короткая проверка в начале помогает заметить разное понимание задачи, пока исправления ещё недороги.",
  },
];

const storageKey = "lenkanban:advice:v1";

export function ProjectAdvice() {
  const [index, setIndex] = useState(0);
  const initialized = useRef(false);

  function showAdvice(next: number) {
    setIndex(next);
    try {
      window.localStorage.setItem(storageKey, advice[next].id);
    } catch {
      // Advice remains usable in browsers with storage disabled.
    }
  }

  useEffect(() => {
    // Stable server markup, and no double advancement in React Strict Mode.
    if (initialized.current) return;
    initialized.current = true;
    let previous = -1;
    try {
      const saved = window.localStorage.getItem(storageKey);
      previous = advice.findIndex((item) => item.id === saved);
    } catch {
      // The first tip is also the no-storage fallback.
    }
    showAdvice((previous + 1) % advice.length);
  }, []);

  const tip = advice[index];

  return (
    <section aria-label="Совет для работы" className="max-w-md border-t border-border pt-6 min-w-0 [overflow-wrap:anywhere]">
      <p className="mb-4 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />Совет для работы
      </p>
      <div aria-live="polite" aria-atomic="true" className="min-h-52 sm:min-h-48">
        <h3 className="text-xl font-semibold leading-snug tracking-tight break-words">{tip.title}</h3>
        <p className="mt-3 text-sm leading-6 text-muted-foreground break-words">{tip.text}</p>
        {tip.href && <a className="mt-3 inline-block text-xs text-primary underline underline-offset-4 break-words" href={tip.href} target="_blank" rel="noopener noreferrer">{tip.source}</a>}
      </div>
      <Button type="button" variant="ghost" size="sm" className="-ml-3 mt-2 min-h-11 text-primary" onClick={() => showAdvice((index + 1) % advice.length)}>
        Другой совет<ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </section>
  );
}
