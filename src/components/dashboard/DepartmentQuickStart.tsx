import Link from "next/link";
import { ArrowRight, Flame, Wrench, Landmark } from "lucide-react";
import { REQUEST_DEPARTMENTS, departmentHref } from "@/lib/request-directions";

/** Static destinations carry intent, never authorization or a deployment-specific ID. */
export function DepartmentQuickStart() {
  return <div className="quick-start-grid">{REQUEST_DEPARTMENTS.map(department => {
    const Icon = department.kind === "beznal" ? Landmark : department.kind === "support" ? Wrench : Flame;
    return <Link key={department.kind} href={departmentHref(department.kind, true)} prefetch={false}
      aria-label={`${department.title}. ${department.hint}`}
      className={`quick-start-card hover:border-primary hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${department.kind === "claim" ? " quick-start-card--claim" : ""}`}>
      <span className="quick-start-tile"><Icon className="h-6 w-6" aria-hidden="true" /></span>
      <span className="quick-start-title">{department.title}</span>
      <span className="quick-start-hint">{department.hint}</span>
      <span className="quick-start-action">Добавить обращение<ArrowRight className="h-4 w-4" aria-hidden="true" /></span>
    </Link>;
  })}</div>;
}
