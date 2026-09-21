export const css = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --border: #e3e2dd;
  --accent: #2f5bd3; --accent-text: #ffffff;
  --ok: #1f7a4d; --ok-bg: #e5f4ec; --warn: #8a5a00; --warn-bg: #fdf1d8; --bad: #b3261e; --bad-bg: #fbe7e5;
  --info: #3b4a6b; --info-bg: #e9edf5;
  --radius: 8px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #9c9b95; --border: #33332f;
    --accent: #7c9bff; --accent-text: #0f0f0e;
    --ok: #6fd3a0; --ok-bg: #173325; --warn: #f0c060; --warn-bg: #3a2f14; --bad: #ff8a80; --bad-bg: #3d1c1a;
    --info: #b7c3e0; --info-bg: #252b38;
  }
}
:root[data-theme="dark"] {
  --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #9c9b95; --border: #33332f;
  --accent: #7c9bff; --accent-text: #0f0f0e;
  --ok: #6fd3a0; --ok-bg: #173325; --warn: #f0c060; --warn-bg: #3a2f14; --bad: #ff8a80; --bad-bg: #3d1c1a;
  --info: #b7c3e0; --info-bg: #252b38;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.sx-page { max-width: 1200px; margin: 0 auto; padding: 20px 16px 40px; }
.sx-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.sx-header h1 { font-size: 20px; margin: 0; }
.sx-header p { margin: 2px 0 0; color: var(--muted); }
.sx-user { color: var(--muted); font-size: 13px; }
.sx-user a { color: var(--accent); }
.sx-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
.sx-stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.sx-stat b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.sx-stat span { color: var(--muted); font-size: 12px; }
.sx-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.sx-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.sx-table-wrap { overflow-x: auto; }
table.sx-table { width: 100%; border-collapse: collapse; }
.sx-table th, .sx-table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.sx-table th { font-size: 12px; font-weight: 600; color: var(--muted); background: var(--surface); position: sticky; top: 0; }
.sx-table td.num, .sx-table th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sx-table tr:last-child td { border-bottom: 0; }
.sx-muted { color: var(--muted); font-size: 12px; }
.sx-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; margin: 0 4px 4px 0; white-space: nowrap; }
.sx-badge.ok { color: var(--ok); background: var(--ok-bg); }
.sx-badge.warn { color: var(--warn); background: var(--warn-bg); }
.sx-badge.bad { color: var(--bad); background: var(--bad-bg); }
.sx-badge.info { color: var(--info); background: var(--info-bg); }
.sx-btn { font: inherit; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 5px 11px; cursor: pointer; }
.sx-btn:hover:not(:disabled) { border-color: var(--muted); }
.sx-btn:disabled { opacity: .5; cursor: default; }
.sx-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.sx-btn.active { background: var(--text); color: var(--bg); border-color: var(--text); }
.sx-row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.sx-confirm { border: 1px solid var(--accent); border-radius: var(--radius); padding: 10px 12px; margin-top: 8px; background: var(--surface); }
.sx-confirm textarea { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); resize: vertical; }
.sx-confirm .sx-row-actions { margin-top: 8px; }
.sx-error { color: var(--bad); background: var(--bad-bg); padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
.sx-notice { color: var(--ok); background: var(--ok-bg); padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
.sx-empty { padding: 32px; text-align: center; color: var(--muted); }
`;
