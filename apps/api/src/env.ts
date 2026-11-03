export interface Env {
  DB: D1Database;
  /** Durable Object con alarmas al segundo para los avisos (temporizadores). */
  SCHEDULER?: DurableObjectNamespace;
  ASSETS?: Fetcher;

  // Variables (wrangler.toml [vars])
  LLM_PROVIDER?: string; // "openai-compatible" | "mock"
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_VISION_MODEL?: string;
  /** Modelos de reserva separados por comas si el principal está saturado. "none" los desactiva. */
  LLM_FALLBACK_MODELS?: string;
  /** "1" para enviar temperature (los modelos Gemini 3.x ya no la usan). */
  LLM_SEND_TEMPERATURE?: string;

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
  /** YouTube Data API v3 (búsqueda de vídeos de batch cooking). */
  YOUTUBE_API_KEY?: string;
  /**
   * Clave de Gemini para la API nativa (entender vídeos de YouTube). Si no se pone y
   * LLM_BASE_URL es de Gemini, se usa LLM_API_KEY.
   */
  GEMINI_API_KEY?: string;
  LLM_VIDEO_MODEL?: string;

  /** URL iCal de Lukkari. Su parámetro hash= es una contraseña: solo como secreto. */
  UNIVERSITY_ICAL_URL?: string;

  /** Claves VAPID para Web Push (genéralas con `pnpm vapid:generate`). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Contacto para los servicios de push, p. ej. "mailto:tu@correo". */
  VAPID_SUBJECT?: string;

  /** Voz del proveedor (opcional), API compatible con OpenAI /audio/speech. */
  TTS_BASE_URL?: string;
  TTS_API_KEY?: string;
  TTS_MODEL?: string;
  TTS_VOICE?: string;

  SESSION_SECRET?: string;
  SETUP_TOKEN?: string;

  /** Solo desarrollo local: desactiva la autenticación. Nunca en producción. */
  DEV_AUTH_BYPASS?: string;
}
