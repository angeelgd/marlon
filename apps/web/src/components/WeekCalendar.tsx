import type { CalendarEvent, PreviewEvent, SchedulePreview } from "@marlon/shared";
import { toLocalParts } from "@marlon/shared";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { dayLabel, monthLabel, segmentsOf, timeLabel, weekDays, type Segment } from "../lib/week";

const HOUR_PX = 44;
const SCROLL_TO_HOUR = 7;

interface Props {
  tz: string;
  monday: string;
  events: CalendarEvent[];
  preview: SchedulePreview | null;
  /** Ids de eventos que acaban de cambiar, para resaltarlos. */
  highlight: Set<string>;
  visible: boolean;
  loading: boolean;
  onPrev(): void;
  onNext(): void;
  onToday(): void;
  onConfirmPreview(): void;
  onDiscardPreview(): void;
}

interface Block {
  id: string;
  title: string;
  start: string;
  end: string;
  kind: string;
  ghost?: PreviewEvent["status"];
  location?: string | null;
}

interface Placed extends Block {
  seg: Segment;
  lane: number;
  lanes: number;
}

/** Reparte en carriles los bloques que se solapan dentro de un mismo día. */
function layoutDay(items: { block: Block; seg: Segment }[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.seg.startMin - b.seg.startMin || b.seg.endMin - a.seg.endMin);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
  };
  for (const { block, seg } of sorted) {
    if (seg.startMin >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const used = new Set(cluster.filter((p) => p.seg.endMin > seg.startMin).map((p) => p.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    const p: Placed = { ...block, seg, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, seg.endMin);
  }
  flush();
  return placed;
}

export function WeekCalendar(props: Props) {
  const { tz, monday, visible } = props;
  const days = useMemo(() => weekDays(monday), [monday]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mientras la vista está oculta (pestaña de chat en móvil) se congela lo que se pinta.
  // Al volver a mostrarse, se pasa a los datos nuevos y Framer Motion anima el movimiento.
  const [shown, setShown] = useState(props.events);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setShown(props.events), 180);
    return () => clearTimeout(t);
  }, [props.events, visible]);

  // El scroll inicial solo se puede fijar cuando la vista es visible (en móvil empieza oculta).
  const scrolled = useRef(false);
  useEffect(() => {
    if (!visible || scrolled.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_PX;
    scrolled.current = true;
  }, [visible]);

  const blocks: Block[] = useMemo(() => {
    const list: Block[] = shown
      .filter((e) => !e.allDay)
      .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, kind: e.kind, location: e.location }));
    if (props.preview?.status === "pending") {
      for (const p of props.preview.events) {
        if (p.status === "unchanged") continue;
        list.push({ id: `preview:${p.key}`, title: p.title, start: p.start, end: p.end, kind: "work_planned", ghost: p.status });
      }
    }
    return list;
  }, [shown, props.preview]);

  const allDay = shown.filter((e) => e.allDay);

  const byDay = useMemo(() => {
    const map = new Map<string, { block: Block; seg: Segment }[]>();
    for (const d of days) map.set(d, []);
    for (const b of blocks) {
      for (const seg of segmentsOf(b.start, b.end, tz, days)) map.get(seg.date)?.push({ block: b, seg });
    }
    return new Map([...map].map(([d, items]) => [d, layoutDay(items)]));
  }, [blocks, days, tz]);

  const today = toLocalParts(Date.now(), tz).date;
  const nowMin = (() => {
    const p = toLocalParts(Date.now(), tz);
    return Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3, 5));
  })();

  const pending = props.preview?.status === "pending" ? props.preview : null;

  return (
    <section className="week" aria-label="Calendario semanal">
      <header className="week-head">
        <button className="icon-btn" onClick={props.onPrev} aria-label="Semana anterior">‹</button>
        <button className="week-title" onClick={props.onToday}>
          {monthLabel(monday)}
          {props.loading && <span className="dot-loading" aria-hidden />}
        </button>
        <button className="icon-btn" onClick={props.onNext} aria-label="Semana siguiente">›</button>
      </header>

      {pending && (
        <div className="preview-bar" role="status">
          <div>
            <strong>Vista previa del horario</strong>
            <span>
              {pending.shifts.length} turnos, {pending.daysOff.length} días libres
              {pending.issues.length > 0 && `, ${pending.issues.length} dudas`}
            </span>
          </div>
          <div className="preview-actions">
            <button className="btn ghost" onClick={props.onDiscardPreview}>Descartar</button>
            <button className="btn" onClick={props.onConfirmPreview} disabled={pending.issues.length > 0} title={pending.issues.length ? "Resuelve las dudas en el chat" : undefined}>
              Guardar
            </button>
          </div>
        </div>
      )}

      <div className="week-days">
        <div className="gutter" />
        {days.map((d) => {
          const l = dayLabel(d);
          return (
            <div key={d} className={`day-head ${d === today ? "is-today" : ""}`}>
              <span>{l.short}</span>
              <b>{l.num}</b>
            </div>
          );
        })}
      </div>

      {allDay.length > 0 && (
        <div className="week-allday">
          <div className="gutter" />
          {days.map((d) => (
            <div key={d} className="allday-cell">
              {allDay
                .filter((e) => e.start.slice(0, 10) <= d && d < e.end.slice(0, 10))
                .map((e) => (
                  <div key={e.id} className={`allday kind-${e.kind}`}>{e.title}</div>
                ))}
            </div>
          ))}
        </div>
      )}

      <div className="week-scroll" ref={scrollRef}>
        <div className="week-grid" style={{ height: 24 * HOUR_PX }}>
          <div className="gutter hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="hour-label" style={{ top: h * HOUR_PX }}>
                {h > 0 ? `${String(h).padStart(2, "0")}:00` : ""}
              </div>
            ))}
          </div>
          <LayoutGroup>
            {days.map((d) => (
              <div key={d} className={`day-col ${d === today ? "is-today" : ""}`}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="hour-line" style={{ top: h * HOUR_PX }} />
                ))}
                {d === today && <div className="now-line" style={{ top: (nowMin / 60) * HOUR_PX }} />}
                <AnimatePresence>
                  {byDay.get(d)?.map((p) => {
                    const top = (p.seg.startMin / 60) * HOUR_PX;
                    const height = Math.max(18, ((p.seg.endMin - p.seg.startMin) / 60) * HOUR_PX - 2);
                    const isNew = props.highlight.has(p.id);
                    return (
                      <motion.div
                        key={`${p.id}:${p.seg.key}`}
                        layoutId={p.seg.first ? p.id : undefined}
                        layout
                        initial={{ opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ type: "spring", stiffness: 260, damping: 28 }}
                        className={`event kind-${p.kind} ${p.ghost ? `ghost ghost-${p.ghost}` : ""} ${isNew ? "flash" : ""}`}
                        style={{
                          top,
                          height,
                          left: `calc(${(p.lane / p.lanes) * 100}% + 2px)`,
                          width: `calc(${100 / p.lanes}% - 4px)`,
                        }}
                        title={`${p.title} ${timeLabel(p.start, tz)} a ${timeLabel(p.end, tz)}`}
                      >
                        <span className="event-title">{p.title}</span>
                        {height > 30 && (
                          <span className="event-time">
                            {timeLabel(p.start, tz)} a {timeLabel(p.end, tz)}
                          </span>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            ))}
          </LayoutGroup>
        </div>
      </div>
    </section>
  );
}
