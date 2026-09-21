/** Коннектор CRM через её MCP-сервер: весь код — файл соответствий config.yaml. */
import { join } from 'node:path';
import { startMcpConnector } from '../../packages/connector/src/mcp.ts';

await startMcpConnector(join(import.meta.dirname, 'config.yaml'));
