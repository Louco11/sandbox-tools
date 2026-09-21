import { h, render, type ComponentType } from 'preact';
import { connect } from './bridge.ts';
import { css } from './styles.ts';

export { boot, call, isApp, tellAgent, ActionError } from './bridge.ts';
export * from './components.tsx';
export { useState, useEffect, useMemo, useCallback } from 'preact/hooks';

/** Точка входа UI тула: стили, подключение к хосту (в режиме MCP App), рендер. */
export async function mount(Root: ComponentType): Promise<void> {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  await connect();
  render(h(Root, {}), document.getElementById('app')!);
}
