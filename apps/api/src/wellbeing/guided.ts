import type { SessionPhase } from "@marlon/shared";

/**
 * Meditaciones guiadas y rutinas de estiramientos. El texto se muestra paso a
 * paso y se lee en voz alta (salvo en modo solo texto). Sin guiones como
 * puntuación, frases cortas para escucharlas.
 */

const step = (label: string, seconds: number, text: string): SessionPhase => ({ label, seconds, kind: "step", text });

export const MEDITATIONS: Record<3 | 5 | 10, { title: string; phases: SessionPhase[] }> = {
  3: {
    title: "Pausa de 3 minutos",
    phases: [
      step("Llegar", 30, "Siéntate cómodo, con la espalda recta y los hombros sueltos. Cierra los ojos o baja la mirada."),
      step("Respirar", 60, "Lleva la atención a la respiración. Nota cómo entra el aire por la nariz y cómo sale. No hace falta cambiar nada."),
      step("Contar", 60, "Cuenta cada exhalación del uno al cinco y vuelve a empezar. Si te pierdes, no pasa nada: vuelve al uno."),
      step("Volver", 30, "Abre la atención a todo el cuerpo y a los sonidos de alrededor. Cuando quieras, abre los ojos."),
    ],
  },
  5: {
    title: "Respiración y cuerpo, 5 minutos",
    phases: [
      step("Llegar", 30, "Busca una postura cómoda. Deja las manos sobre las piernas y suelta la mandíbula."),
      step("Respiración lenta", 90, "Inspira contando hasta cuatro y espira contando hasta seis. Sin forzar. Deja que la espiración sea un poco más larga."),
      step("Recorrer el cuerpo", 90, "Lleva la atención a los pies, las piernas, la tripa, el pecho, los hombros y la cara. Donde notes tensión, suéltala al espirar."),
      step("Solo estar", 60, "Deja la respiración libre. Si aparecen pensamientos, obsérvalos pasar y vuelve a la respiración."),
      step("Volver", 30, "Mueve un poco los dedos, estira si te apetece y abre los ojos. Bien hecho."),
    ],
  },
  10: {
    title: "Meditación de 10 minutos",
    phases: [
      step("Llegar", 60, "Siéntate o túmbate. Nota los puntos de apoyo del cuerpo y deja que pese."),
      step("Respiración", 120, "Sigue la respiración en el punto donde más la notes: la nariz, el pecho o la tripa. Cuando la mente se vaya, vuelve con amabilidad."),
      step("Escaneo corporal", 150, "Recorre el cuerpo despacio desde los pies hasta la cabeza. Solo observa las sensaciones, sin juzgarlas."),
      step("Sonidos y pensamientos", 120, "Abre la atención a los sonidos. Luego a los pensamientos, como nubes que pasan. No tienes que seguirlos."),
      step("Gratitud", 90, "Piensa en algo pequeño de hoy por lo que estés agradecido. Quédate un momento con esa sensación."),
      step("Volver", 60, "Respira un poco más hondo, mueve el cuerpo y abre los ojos cuando quieras. Llévate esta calma al resto del día."),
    ],
  },
};

export function pickMeditation(freeMinutes: number | null, wanted?: number): 3 | 5 | 10 {
  if (wanted === 3 || wanted === 5 || wanted === 10) return wanted;
  if (freeMinutes === null) return 5;
  if (freeMinutes >= 20) return 10;
  if (freeMinutes >= 8) return 5;
  return 3;
}

export const STRETCH_ROUTINES = {
  post_gym: {
    title: "Estiramientos después del gimnasio",
    phases: [
      step("Cuádriceps derecho", 30, "De pie, coge el pie derecho por detrás y acerca el talón al glúteo. Rodillas juntas, cadera hacia delante."),
      step("Cuádriceps izquierdo", 30, "Ahora el pie izquierdo. Si hace falta, apóyate en la pared."),
      step("Isquiotibiales", 40, "Pierna estirada sobre un banco bajo, espalda recta, inclínate desde la cadera hasta notar tensión suave detrás del muslo. Cambia de pierna a mitad."),
      step("Flexor de cadera", 40, "Rodilla derecha en el suelo, pie izquierdo delante. Mete la pelvis y empuja la cadera hacia delante. Cambia de lado a mitad."),
      step("Glúteo", 40, "Tumbado, cruza el tobillo derecho sobre la rodilla izquierda y acerca la pierna al pecho. Cambia de lado a mitad."),
      step("Gemelos", 30, "Manos en la pared, una pierna atrás con el talón en el suelo y la rodilla estirada. Cambia de lado a mitad."),
      step("Pecho", 30, "Antebrazo en el marco de una puerta a la altura del hombro y gira el cuerpo hacia el otro lado. Cambia de lado a mitad."),
      step("Dorsal", 30, "Agárrate a algo fijo con los brazos estirados y lleva la cadera hacia atrás, dejando caer el pecho."),
      step("Tríceps y hombro", 30, "Brazo por detrás de la cabeza y empuja suavemente el codo con la otra mano. Cambia de brazo a mitad."),
      step("Respirar", 20, "Unas respiraciones lentas. Buen entrenamiento."),
    ],
  },
  desk: {
    title: "Estiramientos tras muchas horas programando",
    phases: [
      step("Cuello", 30, "Inclina la oreja derecha hacia el hombro sin subirlo. A mitad, cambia de lado."),
      step("Barbilla atrás", 20, "Mete la barbilla como haciendo papada, con la nuca larga. Mantén dos segundos y suelta, varias veces."),
      step("Hombros", 20, "Rueda los hombros hacia atrás despacio, en círculos grandes."),
      step("Muñecas y antebrazos", 40, "Brazo estirado, palma hacia fuera, tira suavemente de los dedos hacia ti. Luego palma hacia abajo. Cambia de brazo a mitad."),
      step("Espalda alta", 30, "Sentado, entrelaza las manos delante y empuja hacia fuera redondeando la espalda. Luego abre el pecho mirando un poco arriba."),
      step("Giro", 30, "Sentado, gira el tronco hacia la derecha agarrándote al respaldo. A mitad, hacia la izquierda."),
      step("Cadera", 30, "De pie, un pie adelantado, mete la pelvis y empuja la cadera hacia delante. Cambia de lado a mitad."),
      step("Ojos", 20, "Mira algo lejano por la ventana durante veinte segundos. Parpadea despacio."),
    ],
  },
} as const;

export type StretchRoutine = keyof typeof STRETCH_ROUTINES;

export const STRETCH_DISCLAIMER = "Estira sin dolor, solo tensión suave. Si algo duele de verdad, para y consúltalo con un fisioterapeuta.";
