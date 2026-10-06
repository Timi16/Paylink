interface Props {
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}

/** One settings card: title, optional line under it, then the content. */
export function Section({ title, sub, children }: Props) {
  return (
    <section className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800 }}>{title}</h2>
        {sub ? <span className="sub">{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}

export const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, alignItems: "start" };
