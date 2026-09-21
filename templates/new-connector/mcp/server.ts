/** Коннектор «__TITLE__» через MCP-сервер системы: весь код — файл соответствий config.yaml. */
import { join } from 'node:path';
import { startMcpConnector } from '../../packages/connector/src/mcp.ts';

await startMcpConnector(join(import.meta.dirname, 'config.yaml'));
