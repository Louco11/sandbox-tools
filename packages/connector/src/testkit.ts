/**
 * Описание проверки коннектора: connectors/<имя>/test.ts экспортирует defineConnectorTest({...}).
 * Проверка (validate.ts) поднимает тестовую систему, запускает коннектор против неё и говорит с ним так же, как гейтвей.
 * Боевых учётных данных здесь нет и быть не может: только тестовая копия, фикстуры, временные базы.
 */
import type { Params, Row } from './index.ts';

export interface ConnectorTestSystem {
  /** Окружение коннектора для тестовой системы: адреса, тестовые пароли. */
  env: Record<string, string>;
  /** Снимок данных тестовой системы — по нему видно, что describe ничего не меняет, а apply меняет ожидаемое. */
  snapshot(): Promise<unknown>;
  stop(): Promise<void>;
}

export interface WriteScenario {
  write: string;
  params: Params;
  /** Что должен сделать apply: сравнить снимки до и после. Вернуть текст ошибки или ничего. */
  expect?: (before: any, after: any, result: Row) => string | void;
}

/** Один источник реестра, который обслуживает коннектор (у connectors/postgres их несколько — по SOURCE). */
export interface ConnectorVariant {
  source: string;
  env?: Record<string, string>;
  scenarios: WriteScenario[];
}

export interface ConnectorTest {
  /** Поднять тестовую систему (временная БД, фикстуры). Вызывается один раз на все варианты. */
  start(): Promise<ConnectorTestSystem>;
  variants: ConnectorVariant[];
  /** Хосты, к которым коннектор ходит в бою, — проверка кода на чужие адреса. Настоящая граница — сеть compose. */
  hosts?: string[];
}

export const defineConnectorTest = (t: ConnectorTest): ConnectorTest => t;
