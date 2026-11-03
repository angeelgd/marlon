import type { Env } from "../env";

/**
 * Avisa al Durable Object de que hay avisos nuevos para que reprograme su alarma.
 * Sin el binding (tests, o si no se ha desplegado) no hace nada: el cron envía igual.
 */
export async function pokeScheduler(env: Env): Promise<void> {
  if (!env.SCHEDULER) return;
  try {
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("notifications"));
    await stub.fetch("https://scheduler/poke");
  } catch (err) {
    console.warn("no se pudo avisar al programador de alarmas", err);
  }
}
