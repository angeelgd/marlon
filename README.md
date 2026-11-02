# Marlon

Agente personal de organización para una sola persona. Es una PWA que se instala en el iPhone y habla con un agente de IA que organiza la semana sobre Google Calendar.

> **Estado: fases 1 y 2.**
> - Fase 1 (núcleo): PWA, chat, capa de IA intercambiable, Google Calendar, calendario semanal animado con historial y deshacer, y foto del horario de trabajo.
> - Fase 2 (planificación): calendario de la uni, gimnasio y sueño, rutas en bus y buenos días.

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
- `credentials` y `sessions`: passkeys y sesiones.

### Herramientas del agente

- Fase 1: `list_events`, `create_event`, `move_event`, `delete_event`, `find_free_slots`, `parse_schedule_photo` y `confirm_schedule_import`.
- Fase 2: `import_university_calendar`, `find_conflicts`, `plan_gym_week`, `get_sleep_plan`, `get_route`, `get_weather`, `get_daily_briefing` y `get_evening_review`.

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

4. Opcional: si tienes una clave de una cuenta de pago (sus datos no se usan para entrenar), súbela también. Con ella, la foto del horario y, más adelante, los datos económicos irán siempre por esa clave.

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

### 5. Acceso

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

### 6. Publicar

```bash
pnpm deploy
```

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
- **D1 y Cron Triggers:** el uso de un solo usuario queda muy por debajo de los límites gratuitos. Marlon usa dos crons: cada 15 minutos y cada 3 horas.
- **Routes API:** en la tarifa actual de Google Maps Platform cada SKU tiene llamadas gratuitas al mes (las de nivel Essentials, unas 10 000). Comprueba en la consola qué SKU usan las rutas en transporte público y en bici. Con la caché y sin consultar la bici en invierno, el uso de una persona queda muy por debajo.
- **Open-Meteo:** gratis para uso no comercial, sin clave, con un uso razonable de unas 10 000 llamadas al día. Marlon guarda la previsión una hora en caché.
- **Gemini (AI Studio):** los límites de peticiones por minuto y por día dependen del modelo y del proyecto. Los errores 429 se reintentan con espera y, si persisten, Marlon lo dice con naturalidad.

## Limitaciones de iOS

- Las notificaciones push (fase 3) solo funcionan con la PWA instalada en la pantalla de inicio, en iOS 16.4 o superior.
- Una PWA no puede mantener un temporizador exacto con la pantalla bloqueada. Los temporizadores de la fase 5 programarán una notificación push para cada cambio de fase en lugar de depender de un contador en el navegador.
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
- `apps/web/test/week.test.ts`: cálculo de la semana y turnos partidos por la medianoche.

Los tests de la API usan un D1 en memoria sobre `node:sqlite` (`apps/api/test/d1-shim.ts`) con las mismas migraciones.

## Fases

1. **Núcleo** (hecha): PWA, chat, capa de IA, Google Calendar, calendario visual y foto del horario.
2. **Planificación** (hecha): calendario de la uni, gimnasio y sueño, rutas en bus y buenos días.
3. Voz y pendientes: voz con botón, modo solo texto, pendientes, recordatorios y push.
4. Dinero y comida: horas reales y sueldo, gastos, batch cooking, menú y lista de la compra.
5. Bienestar y lectura: temporizadores, meditación, estiramientos, lectura, memoria y base de conocimiento.
