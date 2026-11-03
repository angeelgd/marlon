import type { Book, CalendarEvent } from "@marlon/shared";
import { newId, nowIso } from "../lib/ids";
import { addDays, toLocalIso, toLocalParts } from "../lib/time";

/**
 * Lectura en Kindle. No hay API oficial, así que el seguimiento es semiautomático:
 * al acabar un trayecto, "voy por el 40 %". Con los minutos de cada trayecto se
 * calcula el ritmo, lo que falta y cuándo se terminará.
 */

interface BookRow {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  status: Book["status"];
  percent: number;
  started_at: string;
  finished_at: string | null;
  rating: number | null;
  opinion: string | null;
}

const toBook = (r: BookRow): Book => ({
  id: r.id,
  title: r.title,
  author: r.author,
  genre: r.genre,
  status: r.status,
  percent: r.percent,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  rating: r.rating,
  opinion: r.opinion,
});

export async function currentBook(db: D1Database): Promise<Book | null> {
  const r = await db.prepare(`SELECT * FROM books WHERE status = 'reading' ORDER BY started_at DESC LIMIT 1`).first<BookRow>();
  return r ? toBook(r) : null;
}

export async function listBooks(db: D1Database): Promise<Book[]> {
  const { results } = await db.prepare(`SELECT * FROM books ORDER BY started_at DESC`).all<BookRow>();
  return results.map(toBook);
}

export async function findBook(db: D1Database, title: string): Promise<Book | null> {
  const r = await db
    .prepare(`SELECT * FROM books WHERE lower(title) LIKE '%' || lower(?) || '%' ORDER BY started_at DESC LIMIT 1`)
    .bind(title.trim())
    .first<BookRow>();
  return r ? toBook(r) : null;
}

/** Empieza un libro. El que se estuviera leyendo pasa a "abandonado" solo si se pide. */
export async function startBook(
  db: D1Database,
  input: { title: string; author?: string | null; genre?: string | null; percent?: number },
  now: number,
): Promise<Book> {
  const id = newId("book");
  const at = new Date(now).toISOString();
  await db
    .prepare(`INSERT INTO books (id, title, author, genre, status, percent, started_at) VALUES (?, ?, ?, ?, 'reading', ?, ?)`)
    .bind(id, input.title.trim(), input.author ?? null, input.genre ?? null, input.percent ?? 0, at)
    .run();
  if (input.percent) {
    await db.prepare(`INSERT INTO reading_logs (id, book_id, percent, minutes, logged_at) VALUES (?, ?, ?, NULL, ?)`)
      .bind(newId("rlog"), id, input.percent, at)
      .run();
  }
  return toBook((await db.prepare(`SELECT * FROM books WHERE id = ?`).bind(id).first<BookRow>())!);
}

export interface ReadingLog {
  percent: number;
  minutes: number | null;
  loggedAt: string;
}

export async function readingLogs(db: D1Database, bookId: string): Promise<ReadingLog[]> {
  const { results } = await db
    .prepare(`SELECT percent, minutes, logged_at FROM reading_logs WHERE book_id = ? ORDER BY logged_at`)
    .bind(bookId)
    .all<{ percent: number; minutes: number | null; logged_at: string }>();
  return results.map((r) => ({ percent: r.percent, minutes: r.minutes, loggedAt: r.logged_at }));
}

export async function logReading(db: D1Database, bookId: string, percent: number, minutes: number | null, now: number) {
  if (percent < 0 || percent > 100) throw new Error("El porcentaje va de 0 a 100.");
  const book = (await db.prepare(`SELECT * FROM books WHERE id = ?`).bind(bookId).first<BookRow>())!;
  if (percent < book.percent - 0.5) throw new Error(`Antes ibas por el ${book.percent} %. ¿Seguro que es el ${percent} %?`);
  await db.prepare(`INSERT INTO reading_logs (id, book_id, percent, minutes, logged_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(newId("rlog"), bookId, percent, minutes, new Date(now).toISOString())
    .run();
  await db.prepare(`UPDATE books SET percent = ? WHERE id = ?`).bind(percent, bookId).run();
}

export async function finishBook(db: D1Database, bookId: string, rating: number | null, opinion: string | null, now: number) {
  await db
    .prepare(`UPDATE books SET status = 'finished', percent = 100, finished_at = ?, rating = ?, opinion = ? WHERE id = ?`)
    .bind(new Date(now).toISOString(), rating, opinion, bookId)
    .run();
}

export async function rateBook(db: D1Database, bookId: string, rating: number | null, opinion: string | null) {
  await db.prepare(`UPDATE books SET rating = COALESCE(?, rating), opinion = COALESCE(?, opinion) WHERE id = ?`)
    .bind(rating, opinion, bookId)
    .run();
}

export async function abandonBook(db: D1Database, bookId: string) {
  await db.prepare(`UPDATE books SET status = 'abandoned', finished_at = ? WHERE id = ?`).bind(nowIso(), bookId).run();
}

/* ------------------------------------------------------------------ */
/* Ritmo y fecha estimada                                              */
/* ------------------------------------------------------------------ */

/** % por minuto, a partir de los registros con minutos conocidos. */
export function readingPace(logs: ReadingLog[]): number | null {
  let prev = 0;
  let pct = 0;
  let mins = 0;
  for (const l of logs) {
    const delta = l.percent - prev;
    if (l.minutes && l.minutes > 0 && delta > 0) {
      pct += delta;
      mins += l.minutes;
    }
    prev = Math.max(prev, l.percent);
  }
  return mins > 0 && pct > 0 ? pct / mins : null;
}

const TRAVEL_KINDS: CalendarEvent["kind"][] = ["work_planned", "university"];

/**
 * Cuándo se acabará el libro: se recorren los próximos días sumando los minutos de
 * bus (ida y vuelta en los días con trabajo o clase) hasta cubrir lo que falta.
 */
export function estimateFinish(opts: {
  percent: number;
  pace: number | null;
  events: CalendarEvent[];
  tz: string;
  now: number;
  tripMinutes: number;
  horizonDays?: number;
}): { remainingMinutes: number | null; remainingTrips: number | null; finishDate: string | null } {
  if (opts.pace === null) return { remainingMinutes: null, remainingTrips: null, finishDate: null };
  const remainingMinutes = Math.ceil((100 - opts.percent) / opts.pace);
  const remainingTrips = opts.tripMinutes > 0 ? Math.ceil(remainingMinutes / opts.tripMinutes) : null;
  const today = toLocalIso(opts.now, opts.tz).slice(0, 10);
  const daysWithTrips = new Set(
    opts.events
      .filter((e) => TRAVEL_KINDS.includes(e.kind) && Date.parse(e.start) > opts.now)
      .map((e) => toLocalParts(Date.parse(e.start), opts.tz).date),
  );
  let left = remainingMinutes;
  for (let i = 0, d = today; i < (opts.horizonDays ?? 60); i++, d = addDays(d, 1)) {
    if (daysWithTrips.has(d)) left -= 2 * opts.tripMinutes;
    if (left <= 0) return { remainingMinutes, remainingTrips, finishDate: d };
  }
  return { remainingMinutes, remainingTrips, finishDate: null };
}

/* ------------------------------------------------------------------ */
/* Gustos y géneros para explorar                                       */
/* ------------------------------------------------------------------ */

/** Géneros variados con dos ejemplos accesibles cada uno, para empezar a leer. */
export const GENRES: { genre: string; examples: string[] }[] = [
  { genre: "Ciencia ficción", examples: ["El marciano (Andy Weir)", "Proyecto Hail Mary (Andy Weir)"] },
  { genre: "Novela negra y thriller", examples: ["Los hombres que no amaban a las mujeres (Stieg Larsson)", "La chica del tren (Paula Hawkins)"] },
  { genre: "Fantasía", examples: ["El hobbit (J. R. R. Tolkien)", "El nombre del viento (Patrick Rothfuss)"] },
  { genre: "Divulgación", examples: ["Sapiens (Yuval Noah Harari)", "Una breve historia de casi todo (Bill Bryson)"] },
  { genre: "Hábitos y productividad", examples: ["Hábitos atómicos (James Clear)", "Deep Work (Cal Newport)"] },
  { genre: "Biografías y memorias", examples: ["Open (Andre Agassi)", "Steve Jobs (Walter Isaacson)"] },
  { genre: "Clásicos cortos", examples: ["El viejo y el mar (Ernest Hemingway)", "Rebelión en la granja (George Orwell)"] },
  { genre: "Novela contemporánea en español", examples: ["La sombra del viento (Carlos Ruiz Zafón)", "Patria (Fernando Aramburu)"] },
  { genre: "Humor", examples: ["Sin noticias de Gurb (Eduardo Mendoza)", "Guía del autoestopista galáctico (Douglas Adams)"] },
  { genre: "Novela gráfica", examples: ["Persépolis (Marjane Satrapi)", "Maus (Art Spiegelman)"] },
  { genre: "Literatura finlandesa", examples: ["El libro del verano (Tove Jansson)", "El año de la liebre (Arto Paasilinna)"] },
  { genre: "Ensayo y pensamiento", examples: ["El hombre en busca de sentido (Viktor Frankl)", "Meditaciones (Marco Aurelio)"] },
  { genre: "Programación y oficio", examples: ["El programador pragmático (Andrew Hunt y David Thomas)", "Código limpio (Robert C. Martin)"] },
];

export async function tasteProfile(db: D1Database) {
  const books = await listBooks(db);
  const finished = books.filter((b) => b.status === "finished");
  const byGenre = new Map<string, number[]>();
  for (const b of finished) {
    if (!b.genre) continue;
    const list = byGenre.get(b.genre) ?? [];
    if (b.rating) list.push(b.rating);
    byGenre.set(b.genre, list);
  }
  const tried = new Set(books.map((b) => (b.genre ?? "").toLowerCase()).filter(Boolean));
  return {
    phase: finished.length < 3 ? ("explore" as const) : ("refine" as const),
    finished: finished.map((b) => ({ title: b.title, author: b.author, genre: b.genre, rating: b.rating, opinion: b.opinion })),
    abandoned: books.filter((b) => b.status === "abandoned").map((b) => ({ title: b.title, genre: b.genre })),
    genre_ratings: [...byGenre].map(([genre, r]) => ({ genre, avg: r.length ? Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10 : null })),
    genres_to_try: GENRES.filter((g) => !tried.has(g.genre.toLowerCase())).slice(0, 6),
  };
}
