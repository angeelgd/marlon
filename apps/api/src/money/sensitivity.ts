/**
 * ¿Lleva datos económicos este mensaje? Heurística deliberadamente amplia:
 * es mejor preguntar de más que mandar un sueldo por la capa gratuita.
 */

const AMOUNT = /\b\d+(?:[.,]\d{1,2})?\s?(?:€|eur\b|euros?\b|e\b)|€\s?\d/i;
const WORDS = [
  "gast", // gasté, gasto, gastado, gastos
  "sueldo",
  "salario",
  "nómina",
  "nomina",
  "cobr", // cobré, cobrar, cobro
  "ganado",
  "ganaré",
  "ganare",
  "cuánto gano",
  "cuanto gano",
  "pagué",
  "pague ",
  "alquiler",
  "ahorr",
  "presupuesto",
  "ticket",
  "recibo",
  "factura",
  "dinero",
  "deuda",
  "cuenta del banco",
  "50/30/20",
  "spent",
  "spend",
  "salary",
  "paycheck",
  "payslip",
  "rent",
  "money",
  "budget",
  "expense",
  "receipt",
  "savings",
];

const norm = (s: string) => s.toLowerCase();

export function looksFinancial(text: string): boolean {
  if (!text) return false;
  if (AMOUNT.test(text)) return true;
  const t = norm(text);
  return WORDS.some((w) => t.includes(w));
}

export const CONSENT_ONCE = "Enviar esta vez";
export const CONSENT_ALWAYS = "Enviar siempre";
export const CONSENT_NO = "No enviar";

export function consentAnswer(text: string): "once" | "always" | "no" | null {
  const t = norm(text.trim()).replace(/[.!¡¿?]/g, "");
  if (t === norm(CONSENT_ONCE)) return "once";
  if (t === norm(CONSENT_ALWAYS)) return "always";
  if (t === norm(CONSENT_NO)) return "no";
  return null;
}

export const CONSENT_QUESTION =
  "Esto lleva datos económicos y ahora mismo solo tengo la capa gratuita del modelo, donde Google puede usar lo que envío para entrenar. ¿Lo envío igualmente?";
