type Props = {
  specimenCount: number;
  linkCount: number;
};

export default function HudCorners({ specimenCount, linkCount }: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[2]">
      <div className="absolute left-4 top-[14px] font-mono text-[9.5px] uppercase tracking-[0.22em] text-[rgba(140,200,255,0.45)]">
        BASIN 04 · <span className="text-[rgba(0,229,255,0.75)]">N 24°.18</span>{" "}
        <span className="text-[rgba(0,229,255,0.75)]">W 106°.42</span>
      </div>
      <div className="absolute right-4 top-[14px] text-right font-mono text-[9.5px] uppercase tracking-[0.22em] text-[rgba(140,200,255,0.45)]">
        Specimens <span className="text-[rgba(0,229,255,0.75)]">{specimenCount}</span>{" "}
        · Links <span className="text-[rgba(0,229,255,0.75)]">{linkCount}</span>
      </div>
      <div className="absolute bottom-[14px] left-4 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[rgba(140,200,255,0.45)]">
        Drift <span className="text-[rgba(0,229,255,0.75)]">0.4 kn</span> · Lumens 0.02 lx
      </div>
      <div className="absolute bottom-[14px] right-4 text-right font-mono text-[9.5px] uppercase tracking-[0.22em] text-[rgba(140,200,255,0.45)]">
        Drag to pan · Scroll to zoom · Click to lock
      </div>
    </div>
  );
}
