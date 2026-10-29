"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Flame, Wrench, Landmark } from "lucide-react";
import dynamic from "next/dynamic";
export { classifyDirectionName } from "@/lib/request-directions";
const CreateTaskDialog = dynamic(()=>import("@/components/task/CreateTaskDialog").then(mod=>mod.CreateTaskDialog),{ssr:false});

export type QuickStartDirection = {
  projectId: string;
  projectName: string;
};

export type QuickStartDirections = {
  support?: QuickStartDirection;
  claim?: QuickStartDirection;
  beznal?: QuickStartDirection;
};

export type QuickStartProps = {
  directions: QuickStartDirections;
  /** Only global admins can create the missing direction from /projects. */
  canSetupDirections: boolean;
  onDirectionSelect?: (direction: QuickStartDirection) => void;
};

export const SUPPORT_HINT = "Сбой программы, телефонии, компьютера, доступы";
export const CLAIM_HINT = "Жалоба на мастера, возврат, срочный звонок ОЗОК";

/**
 * Classifies a readable board name into the two approved destinations.
 * Names come from real boards; this never invents a direction and never
 * becomes a permission check - the board's own creation policy decides access.
 */
export function QuickStart({ directions, canSetupDirections, onDirectionSelect }: QuickStartProps) {
  const [openDirection, setOpenDirection] = React.useState<QuickStartDirection | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const close = () => setOpenDirection(null);
  const select = onDirectionSelect ?? setOpenDirection;

  return (
    <>
      <div className="quick-start-grid">
        <QuickStartCard kind="beznal" title="Обращение в Безнал ОП" hint="Выставить счёт, определить платёж, передать информацию" direction={directions.beznal} canSetupDirections={canSetupDirections} triggerRef={triggerRef} onOpen={select} />
        <QuickStartCard
          kind="support"
          title="Написать в Техподдержку"
          hint={SUPPORT_HINT}
          direction={directions.support}
          canSetupDirections={canSetupDirections}
          triggerRef={triggerRef}
          onOpen={select}
        />
        <QuickStartCard
          kind="claim"
          title="Передать недовольного клиента"
          hint={CLAIM_HINT}
          direction={directions.claim}
          canSetupDirections={canSetupDirections}
          triggerRef={triggerRef}
          onOpen={select}
        />
      </div>
      {openDirection && (
        <CreateTaskDialog
          projectId={openDirection.projectId}
          projectName={openDirection.projectName}
          canCreate
          open
          onClose={close}
          returnFocusRef={triggerRef}
        />
      )}
    </>
  );
}

function QuickStartCard({
  kind,
  title,
  hint,
  direction,
  canSetupDirections,
  onOpen,
  triggerRef,
}: {
  kind: "support" | "claim" | "beznal";
  title: string;
  hint: string;
  direction?: QuickStartDirection;
  canSetupDirections: boolean;
  onOpen: (direction: QuickStartDirection) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const tile = kind === "beznal" ? <Landmark className="h-6 w-6" aria-hidden="true" /> : kind === "support" ? <Wrench className="h-6 w-6" aria-hidden="true" /> : <Flame className="h-6 w-6" aria-hidden="true" />;

  if (!direction) {
    return (
      <div className={`quick-start-card quick-start-card--unavailable${kind === "claim" ? " quick-start-card--claim" : ""}`}>
        <span className="quick-start-tile">{tile}</span>
        <span className="quick-start-title">{title}</span>
        <span className="quick-start-hint">{hint}</span>
        <span className="quick-start-setup">
          {canSetupDirections
            ? "Направление пока не настроено."
            : "Направление пока не настроено. Обратитесь к администратору."}
        </span>
        {canSetupDirections && (
          <Link href="/projects">Настроить направления в разделе «Запросы в отделы»</Link>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`quick-start-card${kind === "claim" ? " quick-start-card--claim" : ""}`}
      onClick={event => { triggerRef.current=event.currentTarget; onOpen(direction); }}
      aria-label={`${title}. ${hint}`}
    >
      <span className="quick-start-tile">{tile}</span>
      <span className="quick-start-title">{title}</span>
      <span className="quick-start-hint">{hint}</span>
      <span className="quick-start-action">
        Добавить обращение
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </button>
  );
}
