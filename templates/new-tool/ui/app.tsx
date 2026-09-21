import { ErrorBox, Page, Table, mount, useAction, type Column } from '@sandbox/ui-kit';

type Row = Record<string, unknown>;

function App() {
  const { data, error, loading } = useAction<{ fields: Record<string, string>; items: Row[] }>('list_items', { limit: 50 });
  const columns: Column<Row>[] = Object.keys(data?.fields ?? {}).map((f) => ({
    key: f,
    title: f,
    render: (r) => String(r[f] ?? ''),
  }));

  return (
    <Page subtitle="__DESCRIPTION__">
      <ErrorBox error={error} />
      {loading && !data ? (
        <div class="sx-card sx-empty">Загружаю…</div>
      ) : (
        <Table columns={columns} rows={data?.items ?? []} rowKey={(r) => String(r.id ?? JSON.stringify(r))} />
      )}
    </Page>
  );
}

void mount(App);
