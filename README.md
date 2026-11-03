# Marlon

Agente personal de organización para una sola persona. Es una PWA que se instala en el iPhone y habla con un agente de IA que organiza la semana sobre Google Calendar.

> **Estado: las 5 fases.**
> - Fase 1 (núcleo): PWA, chat, capa de IA intercambiable, Google Calendar, calendario semanal animado con historial y deshacer, y foto del horario de trabajo.
> - Fase 2 (planificación): calendario de la uni, gimnasio y sueño, rutas en bus y buenos días.
> - Fase 3 (voz y pendientes): voz con botón, modo solo texto, pendientes, recordatorios y notificaciones push.
> - Fase 4 (dinero y comida): horas reales y sueldo, gastos, vídeos de batch cooking, menú y lista de la compra.
> - Fase 5 (bienestar y lectura): temporizadores, meditación, estiramientos, lectura, memoria y base de conocimiento.

## Índice

- [Qué hace ya](#qué-hace-ya)
- [Arquitectura](#arquitectura)
- [Desarrollo local](#desarrollo-local)
- [Despliegue](#despliegue)
- [Secretos y privacidad](#secretos-y-privacidad)
- [Límites de las capas gratuitas](#límites-de-las-capas-gratuitas)
- [Limitaciones de iOS](#limitaciones-de-ios)
- [Tests](#tests)

## Qué hace ya

- **Chat con Marlon**, que usa herramientas para leer, crear, mover y borrar eventos y para buscar huecos libres.
- **Calendario semanal** junto al chat (vista dividida en escritorio, pestañas en móvil, con cambio rápido deslizando). Cuando Marlon mueve algo, el evento se desplaza con una animación y se resalta.
- **Historial de cambios** con botón de deshacer por cambio o por grupo (por ejemplo, toda una importación del horario).
- **Foto del horario de trabajo:**
  - Se adjunta desde el chat ("este es mi horario de las próximas semanas") y se puede recortar antes de enviarla.
  - Marlon lee solo la columna configurada ("Angel").
  - Infiere el año más cercano, valida salida menos entrada contra la columna de horas decimales (`6,25` son 6 h 15 min) y detecta los turnos que cruzan la medianoche y los días libres (`0,00`).
  - Si todo cuadra, guarda los turnos y te avisa. Si hay dudas, enseña una vista previa en el calendario y pregunta con botones.
  - Una foto nueva sobrescribe solo el **horario planificado** de esas fechas. No toca nada más.
- **Sincronización con Google Calendar** por `syncToken`: al abrir la app, al volver a ella y cada 15 minutos (cron). Así se recogen también los cambios que hagas a mano desde el iPhone.
- **Modo local**: si no hay credenciales de Google, el calendario vive solo en D1. Sirve para probar la app sin configurar nada.
- **Acceso con passkey** (Face ID / Touch ID) y sesión en una cookie `HttpOnly`, `Secure`, `SameSite=Strict`.

### Fase 2: planificación

- **Calendario de la uni.** La URL iCal de Lukkari se guarda como secreto y un cron la sincroniza cada 3 horas, o desde Ajustes con "Sincronizar la uni ahora".
  - Cada clase se identifica por su UID, y en las series también por el inicio original. Así no se duplica: si cambia de hora se mueve, si se cancela o desaparece del iCal se quita.
  - Marlon detecta los turnos de trabajo que se solapan con clases y dice cuáles son.
  - El parser (`apps/api/src/university/ical.ts`) admite zonas `TZID`, días completos, `RRULE` semanales y diarias (`INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`), `EXDATE` y `RECURRENCE-ID`.
- **Gimnasio** (`apps/api/src/planning/gym.ts`).
  - Planifica entre 3 y 4 sesiones por semana, por la mañana si cabe y si no por la tarde o la noche, evitando días seguidos.
  - Cada sesión es un bloque de 1h20 a 2h20 que incluye 10 minutos de trayecto en cada sentido.
  - Si el hueco es justo, pregunta cuánto vas a estar, con botones.
  - Cuando llega un horario nuevo (foto o cambios en la uni), reajusta las sesiones solo y lo cuenta después. Los turnos y el gimnasio se deshacen juntos.
  - Solo toca sesiones futuras que creó él.
- **Sueño** (`apps/api/src/planning/sleep.ts`). Las 8 horas son intocables (los ajustes no aceptan menos).
  - La hora de levantarse se calcula hacia atrás desde el primer compromiso: trayecto y rutina de mañana, o la preparación si el día empieza en el gimnasio.
  - La de acostarse, 8 horas antes.
  - Si lo que acaba tarde la noche anterior no lo permite, lo avisa con los minutos que faltan y propone alternativas. Nunca recorta el sueño.
- **Rutas** (`apps/api/src/integrations/routes.ts`).
  - Calcula en transporte público con la Routes API la hora de salir de casa para llegar con el margen configurado. Es la salida del primer bus menos lo que se camina hasta la parada.
  - La bici solo se propone en los meses configurados (abril a octubre por defecto), con buen tiempo (sin lluvia, más de 5 °C, poco viento) y si el trayecto es corto.
  - Sin clave de Maps, o si la API falla, estima con el trayecto de los ajustes y lo dice.
  - Las rutas se guardan en caché para ahorrar cuota: las de transporte público 12 horas y las de bici una semana.
- **Buenos días y repaso de la noche** (`apps/api/src/planning/briefing.ts`).
  - Con "buenos días", Marlon saluda y resume el tiempo (Open-Meteo, sin clave), la hora, cómo de cargado está el día y a qué hora salir. Cierra con una frase motivadora y te pregunta si tienes dudas.
  - Con "buenas noches", repasa el día siguiente y a qué hora acostarte y levantarte.
  - Los dos se pueden desactivar en Ajustes. Los avisos automáticos por push llegan en la fase 3.

### Fase 3: voz y pendientes

- **Voz con botón**: mantienes pulsado el micro, hablas y sueltas (deslizar hacia arriba cancela). No hay modo llamada.
  - La PWA graba con MediaRecorder (en iOS, `audio/mp4`) y convierte el audio a WAV de 16 kHz en mono antes de enviarlo (`apps/web/src/lib/recorder.ts`). No se usa el reconocimiento de voz del navegador, que en iOS no es fiable.
  - El modelo transcribe el audio (`input_audio`) y la transcripción pasa al agente como un mensaje más. En el chat ves lo que entendió.
  - Las respuestas a una nota de voz se leen en voz alta con la síntesis del navegador (gratis), con voz en español o en inglés según el idioma. Opcionalmente se puede usar la voz del proveedor (`TTS_*`).
- **Modo solo texto**: interruptor 🔊/🔇 siempre visible arriba. Quita el micrófono, nunca habla y las notificaciones se envían con `silent`. iOS decide si lo respeta: si quieres silencio total, usa también un modo de concentración.
- **Pendientes** (pestaña Pendientes y herramientas `add_pending`, `close_pending`, `list_pendings`, `snooze_pending`): recordatorios ("recuérdame contestar a Mateo"), tareas del trabajo o la uni, planes a corto y largo plazo, y cumpleaños.
  - Todo lo cuentas tú por voz o texto. Marlon no lee chats ni correos.
  - **Insistencia gradual** (`apps/api/src/pendings/nudges.ts`):
    - El primer aviso llega una hora después de apuntarlo, o a la hora indicada.
    - Los siguientes llegan cada vez antes (3 h, 2 h, 1 h 30, 1 h…) y con un tono distinto, hasta que dices que ya está.
    - Nunca avisa en mitad de un turno o una clase, ni a partir de la hora de irte a dormir.
    - Lo que queda sin hacer se recuerda al día siguiente, como mucho dos veces.
  - Los cumpleaños avisan una semana antes (configurable) y el mismo día, y se repiten cada año.
- **Notificaciones push** (`apps/api/src/push`). Un cron cada 5 minutos programa y envía:
  - El buenos días a la hora de levantarte. Al tocarlo, Marlon te da el resumen.
  - El repaso de la noche, 45 minutos antes de acostarte.
  - "Sal a las…", 10 minutos antes de la hora de salida, con la ruta.
  - Los avisos de los pendientes y los cumpleaños.

  Cada aviso tiene una clave única, así que nunca llega dos veces, y si se retrasa más de 30 minutos se descarta.
  - Web Push está implementado con WebCrypto (RFC 8291 y VAPID, RFC 8292), sin librerías de Node. Se prueba con los vectores oficiales del RFC 8291 y descifrando con la librería de referencia.
  - En iOS solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4 o superior). El permiso se pide al tocar "Activar notificaciones" en Ajustes.

### Fase 4: dinero y comida

- **Horas reales y sueldo** (`apps/api/src/money`).
  - El horario planificado (la foto) y las horas reales se guardan en tablas separadas: una foto nueva nunca toca lo real.
  - "Hoy salí a las 21:00" actualiza solo ese día. Si no dices nada, se cuenta la hora planificada.
  - A fin de mes, Marlon calcula lo ganado con las horas reales y con el horario completo, la diferencia, y lista los días que difieren para que los confirmes. También puedes editarlos en *Más > Dinero*.
  - Es una **estimación bruta**, y siempre lo recuerda: hay que contrastarla con la nómina.
- **Reglas de pago**: tabla editable en *Más > Dinero* con fecha de vigencia. Nada de importes en el código: la tabla inicial la crea la migración `0004`.
  - El turno se parte por tramos en los límites de las 06:00, las 15:00 (víspera), las 18:00 y las 24:00.
  - Domingos y festivos: base y suplementos ×2. El suplemento de noche en domingo se marca "por confirmar" hasta que lo confirmes en la tabla.
  - Víspera de festivo (Nochevieja, Sábado Santo, 30 de abril, víspera de San Juan y Nochebuena, salvo si cae en domingo): desde las 15:00, +50 %.
    - Modo "probable" (por defecto): el 50 % sube también la base.
    - Modo "mínimo": solo sube el suplemento.
    - Al cambiar de modo se recalcula todo. Esos días salen como "importe por confirmar".
  - **Turnos que cruzan la medianoche hacia un domingo o festivo**: no se supone nada. Quedan sin calcular, con las dos opciones a la vista, hasta que eliges la regla.
  - **Redondeo**: todo se calcula en céntimos·minuto, que es exacto. El importe de cada turno se muestra con 3 decimales sin redondear (15:45 a 22:00 = 91,225 €) y solo se redondea el total del mes, a céntimos y mitad hacia arriba, una única vez. Así no se acumulan errores de redondeo turno a turno.
  - **Vigencia**: la tabla vale hasta el 30 de junio de 2027. Un mes antes llega un aviso para añadir la nueva.
  - **Festivos de Finlandia**: se calculan en el propio código (Pascua por el algoritmo gregoriano y las fechas fijas o móviles de la ley) en lugar de con una API. Son reglas estables, así no hay dependencia de red y queda cubierto por tests.
- **Gastos** (`log_expense`, `parse_receipt_photo`, `set_budget_item`, `expense_summary`).
  - Se registran por voz o texto ("me acabo de gastar 4,50 en un café"), por foto del ticket o a mano en *Más > Dinero*.
  - También guardas el sueldo neto, el alquiler y los gastos fijos.
  - El resumen usa la regla 50/30/20 y te dice cuánto apartar este mes según el ritmo que llevas.
  - Incluye comparaciones concretas, por ejemplo: "este mes llevas 45 € en 10 cafés; con un termo y un paquete habrías ahorrado unos 16,50 €".
  - Recuerda que no es asesor financiero.
- **Privacidad de los datos económicos** (`apps/api/src/money/sensitivity.ts`):
  - Si hay clave de pago (`LLM_PAID_API_KEY`), todo turno con dinero, y la transcripción de las notas de voz, va por ella.
  - Si solo hay capa gratuita, Marlon **pregunta antes de enviar**: "Enviar esta vez", "Enviar siempre" o "No enviar".
  - Los mensajes con datos económicos quedan marcados y **nunca se reenvían en el historial** por la capa gratuita.
  - Las herramientas de dinero se niegan a funcionar en la capa gratuita sin permiso, aunque el mensaje no pareciera económico.
- **Comida** (`apps/api/src/food`).
  - El día antes del día de cocinar (el sábado por defecto) llega un aviso con ideas de batch cooking. Marlon busca uno o dos vídeos veganos y altos en proteína con la YouTube Data API, sin repetir los ya propuestos, y resume lo que aporta cada uno.
  - Entiende la receta **viendo el vídeo**: Gemini acepta URLs de YouTube en su API nativa.
  - **Plan B**: si eso falla, usa el título y la descripción del vídeo. La API oficial no permite descargar subtítulos de vídeos ajenos sin permiso de su dueño, así que la descripción es la alternativa viable y legal. Muchos canales ponen ahí la receta.
  - Con varias recetas arma el **menú semanal**: reparte las raciones alternando recetas, marca lo que conviene congelar y pone la cena en táper los días de turno de tarde.
  - También hace la **lista de la compra** por secciones, con casillas para ir tachando en *Más > Comida*, y comprueba el **presupuesto**.
  - Reserva la **sesión de cocina** en el calendario: el domingo antes si hay hueco, y si no el sábado o el lunes.
  - Revisa proteína, B12, hierro, omega 3, calcio, yodo y vitamina D, y recuerda que no sustituye a un profesional.

### Fase 5: bienestar y lectura

- **Temporizadores por intervalos** por voz o texto: "30 minutos de estudio, 5 de descanso, 4 veces" o "40 segundos de ejercicio, 20 de descanso, 8 rondas".
  - Con la pantalla encendida, la PWA muestra la cuenta atrás exacta y suena un pitido en cada fase (salvo en modo solo texto). También pide a iOS que no apague la pantalla (Wake Lock).
  - Se puede pausar, seguir, minimizar o terminar.
- **Bloques de estudio** (`plan_study_blocks`): se colocan en el calendario buscando huecos y se reparten entre varios días, porque estudiar espaciado funciona mejor. Llevan descansos proporcionales: 50 minutos y 10 de descanso por defecto, configurable.
- **Meditaciones guiadas** de 3, 5 o 10 minutos. Si no dices cuánto, Marlon elige según el tiempo libre hasta tu siguiente compromiso. El texto de cada paso se muestra y se lee en voz alta.
- **Estiramientos guiados** paso a paso: después del gimnasio, o tras muchas horas programando (cuello, muñecas, espalda, ojos).
- **Lectura** (Kindle, sobre todo en el bus). El seguimiento es semiautomático:
  - Al acabar un trayecto le dices "voy por el 40 %". Si no lo has dicho, **Marlon pregunta al llegar al trabajo o la clase, y al volver a casa**.
  - Con los minutos de cada trayecto calcula tu ritmo, cuántos trayectos te quedan y **qué día lo terminarás**, recorriendo tus próximos días con trabajo o clase en el calendario.
  - Al acabar, te pide una nota del 1 al 5 y tu opinión con tus palabras. Con eso aprende tus gustos.
  - Mientras hayas terminado menos de 3 libros, propone géneros variados, con dos ejemplos accesibles de cada uno.
- **Memoria** (`remember_fact`, `forget_fact`): lo que Marlon aprende de ti (gustos, rutinas, preferencias de horario, personas). Puedes verla, editarla y borrarla en *Ajustes > Lo que Marlon sabe de ti*. Lo que parece económico se marca como sensible y no se envía por la capa gratuita.
- **Base de conocimiento** (`apps/api/knowledge/*.md`): guías sobre sueño, entrenamiento, nutrición vegana, estudio, finanzas personales, y meditación y estiramientos.
  - Las fuentes son conocidas: consenso AASM, OMS, metaanálisis de Schoenfeld y Morton, la Academy of Nutrition and Dietetics, Dunlosky y otras.
  - Marlon detecta el tema del mensaje por palabras clave, **carga esa guía en el contexto** y **cita la fuente de cada consejo**. No hay base de datos vectorial.
  - Para añadir una guía, crea otro `.md` con la misma cabecera (`title`, `keywords`, `sources`) y regístralo en `apps/api/src/knowledge/index.ts`.
  - Son resúmenes generales: no sustituyen a un profesional.

## Arquitectura

```
apps/
  api/      Cloudflare Worker (Hono) + D1 + cron. Sirve también la PWA (mismo origen).
  web/      PWA en React + Vite + vite-plugin-pwa. Animaciones con Framer Motion.
packages/
  shared/   Tipos, esquemas zod y utilidades de zona horaria comunes.
scripts/
  google-auth.ts   Obtiene una vez el refresh token de Google.
```

### Decisiones

| Decisión | Motivo |
|---|---|
| **Workers Static Assets** en lugar de Cloudflare Pages | La PWA y la API comparten origen: no hace falta CORS, la cookie puede ser `SameSite=Strict` y hay un único despliegue. También es gratis. |
| **Capa de IA con formato OpenAI** (`apps/api/src/llm`) | Gemini, OpenRouter, Groq, Ollama o un modelo propio se cambian tocando solo variables de entorno. La lógica del agente no se toca. |
| **El modelo transcribe y el código interpreta** | El modelo de visión devuelve las celdas tal cual (`"Oct-19"`, `"15.45"`, `"6,25"`). Un parser determinista con tests (`apps/api/src/schedule/parse.ts`) calcula las fechas y valida las horas. |
| **Refresh token de Google como secreto** | Se obtiene una sola vez con `pnpm google:auth`. La base de datos no guarda tokens. |
| **Sincronización por sondeo con `syncToken`** | Los canales *watch* de Google caducan y hay que renovarlos. Sondear cada 15 minutos sobra para un solo usuario. |
| **Durable Object con alarmas** para los avisos | El cron mira cada 5 minutos, que no sirve para un descanso de 20 segundos. Un Durable Object (con SQLite, disponible en el plan gratuito) pone una alarma justo para el siguiente aviso. El cron sigue enviando como respaldo, y una reserva atómica evita mandar un aviso dos veces. |
| **Escrituras en lote** con la API batch de Google Calendar | Importar el calendario de la uni puede suponer más de cien eventos. Agrupados de 50 en 50, caben en el límite de subpeticiones del plan gratuito de Workers. |
| **Planificador determinista** | El gimnasio y el sueño se calculan con código probado, no con el modelo. El modelo solo los explica y pregunta. |
| **La imagen no se guarda** | Se guarda temporalmente en D1 para procesarla, se borra al usarla y, si no se usa, el cron la elimina a las 24 h. |

### Modelo de datos (D1)

Ver `apps/api/migrations/0001_init.sql`. Tablas principales:

- `settings`: ajustes editables desde la app, incluidas las direcciones, que nunca van en el código.
- `events_cache` y `sync_state`: copia local de Google Calendar.
- `change_log`: historial con el estado anterior y posterior de cada cambio, para poder deshacer.
- `planned_shifts`: horario planificado que sale de la foto. Las horas reales irán en otra tabla en la fase 4.
- `schedule_uploads`: lecturas de la foto pendientes de confirmar.
- `messages`: historial del chat.
- `api_cache`: caché del tiempo y de las rutas.
- `pendings`: recordatorios, tareas, planes y cumpleaños, con el estado de la insistencia del día.
- `push_subscriptions` y `notifications`: dispositivos suscritos y la cola de avisos.
- `pay_rule_sets`: tablas de sueldo con vigencia.
- `actual_shifts`: horas reales, separadas de `planned_shifts`.
- `expenses` y `budget_items`: gastos, sueldo y gastos fijos.
- `pending_consents`: mensaje con datos económicos esperando permiso.
- `recipes` y `meal_plans`: recetas, menús y listas de la compra.
- `sessions_wellbeing`: temporizadores, meditaciones y estiramientos (fases y pausas).
- `books` y `reading_logs`: libros, progreso por trayecto, notas y opiniones.
- `memories`: la memoria editable de Marlon.
- `credentials` y `sessions`: passkeys y sesiones.

### Herramientas del agente

- Fase 1: `list_events`, `create_event`, `move_event`, `delete_event`, `find_free_slots`, `parse_schedule_photo` y `confirm_schedule_import`.
- Fase 2: `import_university_calendar`, `find_conflicts`, `plan_gym_week`, `get_sleep_plan`, `get_route`, `get_weather`, `get_daily_briefing` y `get_evening_review`.
- Fase 3: `add_pending`, `close_pending`, `list_pendings` y `snooze_pending`.
- Fase 5: `start_timer`, `stop_timer`, `start_meditation`, `start_stretching`, `plan_study_blocks`, `start_book`, `log_reading`, `finish_book`, `reading_status`, `suggest_books`, `remember_fact`, `forget_fact` y `consult_knowledge`.
- Fase 4: `log_actual_shift`, `calc_monthly_pay`, `set_pay_option`, `log_expense`, `parse_receipt_photo`, `delete_expense`, `set_budget_item`, `expense_summary`, `find_cooking_videos`, `analyze_cooking_video` y `build_menu_and_shopping_list`.

Cada herramienta tiene un esquema zod. Si el modelo envía argumentos que no pasan la validación, recibe el error con una pista y puede corregirse.

## Desarrollo local

Requisitos: Node 22 o superior y pnpm 10.

1. Instala las dependencias:

   ```bash
   pnpm install
   ```

2. Crea los secretos locales. Para probar sin claves usa el proveedor de prueba:

   ```bash
   cp .env.example apps/api/.dev.vars
   ```

   En `apps/api/.dev.vars` pon `LLM_PROVIDER=mock`, `DEV_AUTH_BYPASS=1` y un `SESSION_SECRET` de 32 caracteres o más.

3. Aplica las migraciones en la base de datos local:

   ```bash
   pnpm db:migrate:local
   ```

4. Compila la PWA y arranca el Worker:

   ```bash
   pnpm build
   ```

   ```bash
   pnpm --filter @marlon/api dev
   ```

   Abre <http://localhost:8787>. Para desarrollar el frontend con recarga en caliente, ejecuta también `pnpm --filter @marlon/web dev` y abre <http://localhost:5173>. Hace de proxy de `/api` al Worker.

Con `LLM_PROVIDER=mock`, Marlon responde con reglas fijas. Si adjuntas cualquier imagen, la trata como un horario de ejemplo, lo que permite probar la vista previa, el guardado, la animación y el deshacer sin gastar cuota.

`DEV_AUTH_BYPASS=1` solo funciona cuando la URL es `localhost`. Nunca lo pongas en producción.

## Despliegue

Todo cabe en las capas gratuitas de Cloudflare, Google Cloud y Google AI Studio.

### 1. Cloudflare

1. Inicia sesión:

   ```bash
   pnpm --filter @marlon/api exec wrangler login
   ```

2. Crea la base de datos y copia el `database_id` que devuelve en `apps/api/wrangler.toml`:

   ```bash
   pnpm --filter @marlon/api exec wrangler d1 create marlon
   ```

3. Aplica las migraciones en la base de datos remota:

   ```bash
   pnpm db:migrate:remote
   ```

### 2. Modelo de IA (Gemini por defecto)

1. Crea una clave en Google AI Studio.
2. **Comprueba en la consola de AI Studio qué modelos Flash o Flash‑Lite tienen cuota gratuita hoy** y sus límites (ahora dependen de cada proyecto). Pon el nombre en `LLM_MODEL`, en `apps/api/wrangler.toml` (`[vars]`).
3. Sube la clave como secreto:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put LLM_API_KEY
   ```

4. Opcional: si tienes una clave de una cuenta de pago (sus datos no se usan para entrenar), súbela también. Con ella, la foto del horario, los datos económicos y la transcripción de las notas de voz irán siempre por esa clave.

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put LLM_PAID_API_KEY
   ```

Para usar otro proveedor compatible con OpenAI, cambia `LLM_BASE_URL` y `LLM_MODEL` y sube su clave. No hay que tocar código.

### 3. Google Calendar

1. En Google Cloud Console, crea un proyecto y **activa la Google Calendar API**.
2. Configura la **pantalla de consentimiento OAuth**:
   - Tipo *External*.
   - Añádete como usuario de prueba.
   - **Publícala (*In production*)**. En modo *Testing* el refresh token caduca a los 7 días. Para uso personal no hace falta verificar la app: solo verás un aviso de "app no verificada" al autorizar.
3. Crea un **ID de cliente OAuth de tipo "Aplicación de escritorio"**.
4. Obtén el refresh token. El permiso pedido es solo `calendar.events`.

   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... pnpm google:auth
   ```

5. Sube los tres valores como secretos, uno por comando:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put GOOGLE_CLIENT_ID
   ```

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put GOOGLE_REFRESH_TOKEN
   ```

6. En el iPhone, añade esa cuenta de Google en *Ajustes > Calendario > Cuentas* para ver los eventos en la app Calendario y en el widget.

Si Google revoca el token, Marlon lo indica en la app. Repite el paso 4 y actualiza el secreto.

### 4. Calendario de la uni y rutas

1. En Lukkari, copia la URL iCal de tu calendario y súbela como secreto. El parámetro `hash=` de la URL funciona como una contraseña.

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put UNIVERSITY_ICAL_URL
   ```

2. Opcional, para las horas de salida en bus: en Google Cloud Console activa la **Routes API**, crea una clave de API **restringida a la Routes API** y súbela como secreto. Sin ella, Marlon usa el trayecto estimado de los ajustes.

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put GOOGLE_MAPS_API_KEY
   ```

3. Rellena en Ajustes las direcciones de casa, el trabajo, la uni y el gimnasio, y si hace falta la ciudad con sus coordenadas para el tiempo (por defecto, Turku).

### 5. Vídeos de batch cooking (opcional)

1. En Google Cloud Console, activa la **YouTube Data API v3** y crea una clave restringida a esa API. Súbela como secreto:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put YOUTUBE_API_KEY
   ```

2. Si tu modelo es Gemini, la misma `LLM_API_KEY` sirve para que Gemini vea los vídeos. Si usas otro proveedor, sube una clave de Gemini aparte:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put GEMINI_API_KEY
   ```

### 6. Notificaciones push

1. Genera las claves VAPID. El comando imprime los valores, pero no los guarda en ningún archivo.

   ```bash
   pnpm vapid:generate
   ```

2. Súbelas como secretos, una por comando:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put VAPID_PUBLIC_KEY
   ```

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put VAPID_PRIVATE_KEY
   ```

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put VAPID_SUBJECT
   ```

3. En el iPhone, abre Marlon **desde el icono de la pantalla de inicio**, ve a *Ajustes > Activar notificaciones* y pulsa "Enviar una de prueba".

### 7. Acceso

1. Genera un secreto de sesión de al menos 32 caracteres:

   ```bash
   openssl rand -base64 48
   ```

2. Súbelo como `SESSION_SECRET`:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put SESSION_SECRET
   ```

3. Genera el código para registrar la primera passkey:

   ```bash
   openssl rand -hex 16
   ```

4. Súbelo como `SETUP_TOKEN`:

   ```bash
   pnpm --filter @marlon/api exec wrangler secret put SETUP_TOKEN
   ```

Una vez registrada la primera passkey, el código ya no basta: para añadir otra hay que estar dentro.

### 8. Publicar

```bash
pnpm deploy
```

El primer despliegue crea también el Durable Object de los avisos (migración `v1` en `apps/api/wrangler.toml`). No hay que hacer nada más.

En el iPhone, abre la URL en Safari, ve a *Compartir > Añadir a pantalla de inicio* y abre Marlon desde el icono. La primera vez escribe el `SETUP_TOKEN` y crea la passkey.

## Secretos y privacidad

- Ningún secreto vive en el repositorio ni en el frontend. Todos están en los secretos de Workers (o en `apps/api/.dev.vars` en local, que está en `.gitignore`). La plantilla es `.env.example`.
- Las direcciones de casa, el trabajo, la universidad y el gimnasio se guardan en los ajustes de la app (D1), nunca en el código.
- **Capa gratuita del modelo:** Google puede usar esos datos para entrenar.
  - Los envíos se clasifican como `normal`, `third_party` (por ejemplo, la foto del horario, que lleva nombres de compañeros) o `financial`.
  - Si hay clave de pago, los dos últimos van siempre por ella.
  - Si no la hay, los datos económicos piden permiso antes de enviarse.
  - Para la foto del horario hay un ajuste ("Permitir enviar la foto por la capa gratuita"). Además, la foto se puede **recortar en el móvil** antes de enviarla, para mandar solo la columna de fechas y la tuya.
- Las fotos se reducen en el navegador (lado mayor de 1600 px) antes de enviarse.
- Marlon no lee chats ni correos y no envía datos a ningún servicio que no esté configurado aquí.

## Límites de las capas gratuitas

Los límites cambian. **Compruébalos en la documentación oficial antes de desplegar.** Esto es lo que condiciona el diseño:

- **Workers (plan gratuito):** el tiempo de CPU por petición es corto. La espera a Google y al modelo no cuenta como CPU, por eso las imágenes se procesan en el navegador. El número de subpeticiones por invocación también está limitado, así que importar un horario solo crea, mueve o borra los turnos que cambian.
- **D1 y Cron Triggers:** el uso de un solo usuario queda muy por debajo de los límites gratuitos. Marlon usa dos crons: cada 5 minutos (Google Calendar y notificaciones) y cada 3 horas (calendario de la uni). Por eso un aviso puede llegar hasta 5 minutos tarde.
- **Routes API:** en la tarifa actual de Google Maps Platform cada SKU tiene llamadas gratuitas al mes (las de nivel Essentials, unas 10 000). Comprueba en la consola qué SKU usan las rutas en transporte público y en bici. Con la caché y sin consultar la bici en invierno, el uso de una persona queda muy por debajo.
- **Durable Objects:** en el plan gratuito solo existen con almacenamiento SQLite, con límites diarios de peticiones. Marlon usa uno solo, con una alarma por aviso pendiente.
- **YouTube Data API:** cada búsqueda cuesta 100 unidades de una cuota diaria limitada; consultar los detalles de un vídeo, 1. Marlon hace como mucho dos búsquedas por semana y las guarda en caché.
- **Gemini con vídeos de YouTube:** en la capa gratuita hay un límite de horas de vídeo al día (8 horas según la documentación actual). Solo vídeos públicos. Cada receta se analiza una vez y se guarda.
- **Open-Meteo:** gratis para uso no comercial, sin clave, con un uso razonable de unas 10 000 llamadas al día. Marlon guarda la previsión una hora en caché.
- **Gemini (AI Studio):** los límites de peticiones por minuto y por día dependen del modelo y del proyecto. Los errores 429 se reintentan con espera y, si persisten, Marlon lo dice con naturalidad.

## Limitaciones de iOS

- Las notificaciones push solo funcionan con la PWA instalada en la pantalla de inicio, en iOS 16.4 o superior, y el permiso se pide con un toque. Cada push tiene que mostrar una notificación visible: no hay avisos invisibles.
- El modo silencioso (`silent`) de las notificaciones depende de iOS. Para silencio total en clase o en el trabajo, combínalo con un modo de concentración.
- La voz del navegador solo puede hablar después de un gesto. Por eso el botón del micro la "desbloquea" al pulsarlo.
- Las notas de voz se transcriben antes de saber lo que dicen. Si hay clave de pago, la transcripción va siempre por ella. Si solo hay capa gratuita, el audio de una nota con datos económicos sí pasa por ella para transcribirse, aunque luego Marlon pide permiso antes de tratar su contenido. Para evitarlo del todo, configura la clave de pago o escribe esos datos.
- **Temporizadores con la pantalla bloqueada:** una PWA no puede mantener un temporizador exacto con la pantalla bloqueada, porque iOS congela la página.
  - Por eso **cada cambio de fase se programa en el servidor como una notificación push**, enviada a su hora por un Durable Object con alarmas al segundo.
  - Con la pantalla encendida, la cuenta atrás de la app es exacta. Bloqueada, depende de que llegue la notificación, que puede tardar unos segundos.
  - En los intervalos muy cortos (menos de 30 segundos) lo más fiable es dejar la app abierta. Marlon pide a iOS que no apague la pantalla (Wake Lock, que funciona en las apps instaladas desde iOS 18.4 según la información disponible).
- Las meditaciones solo avisan al final, para no interrumpir.
- iOS congela la app en segundo plano. Al volver, Marlon sincroniza con Google Calendar y anima lo que haya cambiado.

## Tests

```bash
pnpm test
```

```bash
pnpm typecheck
```

- `apps/api/test/parse.test.ts`: parser del horario (formatos de fecha, inferencia del año en el paso de diciembre a enero, `6,25`, medianoche, `24.00`, días libres, discrepancias y duplicados).
- `apps/api/test/slots.test.ts`: búsqueda de huecos (margen, varios días, eventos que cruzan la medianoche, cambio de hora).
- `apps/api/test/agent.test.ts`: validación de herramientas y bucle del agente, incluida la autocorrección tras argumentos erróneos.
- `apps/api/test/calendar.test.ts`: historial y deshacer, también por grupos.
- `apps/api/test/schedule-import.test.ts`: importación completa desde el chat, sobrescritura de solo lo planificado, correcciones y permiso para la capa gratuita.
- `apps/api/test/routes.test.ts`: autenticación, protección de rutas y flujo de la API.
- `apps/api/test/llm.test.ts`: proveedor compatible con OpenAI (reintentos y herramientas) y enrutado por sensibilidad.
- `apps/api/test/ical.test.ts`: iCal (zonas, días completos, RRULE con cambio de hora, EXDATE, RECURRENCE-ID).
- `apps/api/test/university.test.ts`: sincronización de la uni sin duplicados, cambios, cancelaciones, solapes y que la URL secreta no aparezca en los errores.
- `apps/api/test/batch.test.ts`: API batch de Google Calendar.
- `apps/api/test/planning.test.ts`: sueño (8 horas mínimo, avisos) y gimnasio (mañana, huecos justos, sin días seguidos, sin recortar sueño).
- `apps/api/test/routes-weather.test.ts`: Routes API, hora de salida, caché, estimación, tiempo y bici.
- `apps/api/test/phase2-tools.test.ts`: herramientas de la fase 2, buenos días, buenas noches y cron de la uni.
- `apps/api/test/webpush.test.ts`: cifrado Web Push idéntico al ejemplo del RFC 8291, descifrado con la implementación de referencia y JWT de VAPID verificado con `node:crypto`.
- `apps/api/test/pendings.test.ts`: insistencia gradual (intervalos, sin avisos en turnos ni de noche, máximo por día, vencidos, aplazados) y cumpleaños, incluido el 29 de febrero.
- `apps/api/test/phase3.test.ts`: planificador y envío de notificaciones, modo solo texto, suscripciones caducadas, nota de voz de punta a punta y rutas de la API.
- `apps/api/test/pay.test.ts`: **los tests obligatorios del calculador** (domingo de 12:45 a 20:00 = 204,25 €, domingo de 13:00 a 21:00 = 227,60 €, día normal de 15:45 a 22:00 = 91,225 €), suplementos de noche, vísperas en los dos modos, víspera en domingo, medianoche hacia domingo y festivos de Finlandia.
- `apps/api/test/payroll.test.ts`: horas reales frente a planificadas, días que difieren, turnos extra, por confirmar, tablas con vigencia y aviso de caducidad.
- `apps/api/test/money.test.ts`: detección de datos económicos, flujo de permiso (esta vez, siempre, no enviar), clave de pago, historial sin datos económicos, herramientas que se niegan y resumen 50/30/20 con comparaciones.
- `apps/api/test/food.test.ts`: YouTube, receta con Gemini (plan A) y desde la descripción (plan B), menú, lista de la compra, nutrición, presupuesto y sesión de cocina.
- `apps/api/test/phase4-routes.test.ts`: avisos de caducidad de la tabla y de batch cooking, y rutas de dinero y comida.
- `apps/api/test/wellbeing.test.ts`: intervalos ("30 + 5 × 4" y "40 s + 20 s × 8 rondas"), avisos a la hora exacta de cada fase, pausa y reanudación, meditaciones, estiramientos y bloques de estudio.
- `apps/api/test/reading-memory.test.ts`: ritmo de lectura, fecha estimada, gustos, pregunta al acabar el trayecto, memoria sin duplicados ni datos económicos, y guías con sus fuentes.
- `apps/api/test/phase5.test.ts`: dos despachos simultáneos no duplican avisos, temporizador y lectura desde el chat, guía y memoria en el contexto, y rutas.
- `apps/web/test/week.test.ts`: cálculo de la semana y turnos partidos por la medianoche.
- `apps/web/test/wav.test.ts`: conversión a WAV (cabecera, mono, remuestreo y base64).

Los tests de la API usan un D1 en memoria sobre `node:sqlite` (`apps/api/test/d1-shim.ts`) con las mismas migraciones.

## Fases

1. **Núcleo** (hecha): PWA, chat, capa de IA, Google Calendar, calendario visual y foto del horario.
2. **Planificación** (hecha): calendario de la uni, gimnasio y sueño, rutas en bus y buenos días.
3. **Voz y pendientes** (hecha): voz con botón, modo solo texto, pendientes, recordatorios y push.
4. **Dinero y comida** (hecha): horas reales y sueldo, gastos, batch cooking, menú y lista de la compra.
5. **Bienestar y lectura** (hecha): temporizadores, meditación, estiramientos, lectura, memoria y base de conocimiento.
