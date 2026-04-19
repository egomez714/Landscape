type Props = {
  specimenCount: number;
  linkCount: number;
};

export default function TelemetryChips({ specimenCount, linkCount }: Props) {
  return (
    <div className="flex items-center gap-[10px] font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--fg-faint)]">
      <span className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(8,14,30,0.55)] px-[10px] py-[5px] text-[var(--fg-dim)] backdrop-blur">
        <span
          className="h-[6px] w-[6px] rounded-full bg-[var(--cyan)]"
          style={{ boxShadow: "0 0 8px var(--cyan)" }}
        />
        <b className="font-medium text-[var(--fg)]">SONAR</b>
        &nbsp;active
      </span>
      <span className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(8,14,30,0.55)] px-[10px] py-[5px] text-[var(--fg-dim)] backdrop-blur">
        Specimens <b className="font-medium text-[var(--fg)]">{specimenCount}</b>
      </span>
      <span className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(8,14,30,0.55)] px-[10px] py-[5px] text-[var(--fg-dim)] backdrop-blur">
        Links <b className="font-medium text-[var(--fg)]">{linkCount}</b>
      </span>
    </div>
  );
}
