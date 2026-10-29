import { digest } from '../../scripts/mail/transfer-plan.mjs';

export function importPlan(projectId = 'project', authorId = 'admin', key = 'synthetic-card') {
  const plan = {
    schema_version: 'mail-transfer-1', mode: 'dry-run', database_import_enabled: false,
    scope: { confirmed: true },
    cards: [{ card_key: key, title: 'Synthetic import', board_id: projectId, selected: true, status: 'ready', messages: [{
      message_key: `message-${key}`, author_id: authorId, body_text: 'Synthetic message',
      sent_at: '2026-10-22T12:00:00.000Z', attachments: [],
    }] }],
  };
  return { ...plan, plan_sha256: digest(plan) };
}
