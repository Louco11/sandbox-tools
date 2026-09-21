import { service } from './db.ts';
import { HttpError } from './errors.ts';

export interface AuditEntry {
  requestId: string;
  actor: string;
  tool: string;
  source?: string;
  operation: string;
  fields?: string[];
  agentInChain: boolean;
  allowed: boolean;
  reason?: string;
}

/**
 * Пишет строку аудита в stdout и в audit.calls.
 * Для разрешённых вызовов аудит обязателен: не смогли записать — операция не выполняется.
 */
export async function audit(e: AuditEntry): Promise<void> {
  console.log(JSON.stringify({ type: 'audit', at: new Date().toISOString(), ...e }));
  try {
    await service.query(
      `INSERT INTO audit.calls (request_id, actor, tool, source, operation, fields, agent_in_chain, allowed, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.requestId, e.actor, e.tool, e.source ?? null, e.operation, e.fields ?? null, e.agentInChain, e.allowed, e.reason ?? null],
    );
  } catch (err) {
    console.error(JSON.stringify({ type: 'audit_write_failed', requestId: e.requestId, error: String(err) }));
    if (e.allowed) throw new HttpError(503, 'audit_unavailable', 'аудит недоступен, операция не выполнена');
  }
}
