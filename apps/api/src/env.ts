export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  // Variables (wrangler.toml [vars])
  LLM_PROVIDER?: string; // "openai-compatible" | "mock"
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_VISION_MODEL?: string;

  // Secretos (wrangler secret put / .dev.vars)
  LLM_API_KEY?: string;
  /** Clave de una cuenta de pago (los datos no se usan para entrenar). Opcional. */
  LLM_PAID_API_KEY?: string;
  LLM_PAID_BASE_URL?: string;
  LLM_PAID_MODEL?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;

  /** Clave de Google Maps Platform (Routes API). Opcional: sin ella se estima el trayecto. */
  GOOGLE_MAPS_API_KEY?: string;
  /** URL iCal de Lukkari. Su parámetro hash= es una contraseña: solo como secreto. */
  UNIVERSITY_ICAL_URL?: string;

  SESSION_SECRET?: string;
  SETUP_TOKEN?: string;

  /** Solo desarrollo local: desactiva la autenticación. Nunca en producción. */
  DEV_AUTH_BYPASS?: string;
}
