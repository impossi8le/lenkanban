/** The only board preset offered by the product. Safe to import in clients. */
export const SUPPORT_TEMPLATE_ID = "builtin-project-template-tech-support";
export const SUPPORT_TEMPLATE_KEY = "tech-support";
export const SUPPORT_BOARD_NAME = "Техническая поддержка";

export function isRetiredProjectTemplate(template: { id?: string; templateData: unknown }): boolean {
  if (template.id?.startsWith("builtin-project-template-") && template.id !== SUPPORT_TEMPLATE_ID) return true;
  const data = template.templateData;
  return typeof data === "object" && data !== null && "key" in data && data.key !== SUPPORT_TEMPLATE_KEY;
}
