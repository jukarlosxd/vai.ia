# VAI Business Assistant

Asistente privado dentro del panel del cliente (`/client`). Permite al dueño del negocio consultar y administrar citas, disponibilidad y comunicaciones en lenguaje natural. Es completamente independiente del recepcionista público (VAI Receptionist): prompt propio, historial propio, endpoints propios, herramientas propias.

## Arquitectura

```
client/index.html (panel "VAI Assistant")
   │  fetch con cookie aidash_client (JWT existente)
   ▼
business-assistant.js  (montado desde index.js con mountBusinessAssistant)
   ├── Rutas /client/api/assistant/*  (verifyClient + rate limit 20/min)
   ├── Orquestador: Groq tool-calling (misma GROQ_API_KEY, solo backend)
   ├── Herramientas controladas (el modelo nunca toca la BD)
   ├── Acciones pendientes (confirmar-antes-de-ejecutar, TTL 15 min)
   ├── Repositorio: Supabase primero → fallback JSON en assistant-data/
   └── Auditoría: assistant_action_logs / assistant-data/<slug>.logs.jsonl
```

El tenant SIEMPRE sale de `req.client.slug` (JWT). Nunca del body, query, ni del modelo.

## Endpoints

| Método | Ruta | Propósito |
|---|---|---|
| POST | `/client/api/assistant/messages` | Enviar mensaje `{text, conversationId?}` |
| GET | `/client/api/assistant/conversations` | Listar conversaciones del usuario |
| GET | `/client/api/assistant/conversations/:id` | Historial (valida ownership) |
| POST | `/client/api/assistant/actions/:id/confirm` | Confirmar acción pendiente (atómico, idempotente) |
| POST | `/client/api/assistant/actions/:id/cancel` | Cancelar acción pendiente |

Errores: `{ok:false, error:{code, message}}` con códigos estables (`VALIDATION_ERROR`, `AMBIGUOUS_DATE`, `ACTION_EXPIRED`, `ACTION_ALREADY_PROCESSED`, `DELIVERY_FAILED`, `RATE_LIMITED`, `FORBIDDEN`, `NOT_FOUND`, `INTERNAL_ERROR`).

## Herramientas del modelo

Lectura (ejecución directa): `get_appointments`, `search_clients`, `get_client_appointments`, `get_availability`, `find_affected_appointments`, `get_operational_summary`, `draft_client_message`.

Escritura (crean acción pendiente, requieren confirmación en UI): `create_availability_block`, `send_client_message`, `request_reschedule`, `cancel_appointment`.

Niveles de riesgo: READ / PREPARE / CONFIRM / STRONG_CONFIRM (≥3 citas afectadas o bloqueo >24h ⇒ STRONG_CONFIRM, con doble confirmación en la UI).

## Flujo de confirmación

```
pending_confirmation → confirmed → executing → completed | failed
                     ↘ cancelled / expired (TTL 15 min)
```

- Transición atómica: función SQL `ba_confirm_action()` (Supabase) o cola de escritura por tenant (fallback JSON, single-process).
- Doble clic / doble request / requests concurrentes ⇒ exactamente un ganador, el resto `409 ACTION_ALREADY_PROCESSED` (probado con `Promise.all`).
- Antes de ejecutar se re-valida el estado actual (la cita sigue existiendo, no hay bloqueo duplicado).

### Semántica de ejecución (honesta): **at-most-once**

La confirmación es atómica (nunca dos ejecuciones de la misma acción), pero si el proceso muere DESPUÉS de `confirmed/executing` y ANTES de completar, la acción queda en `executing` y **no se re-ejecuta automáticamente** (comprobado empíricamente matando el proceso a mitad de ejecución). Para SMS esto es lo más seguro: nunca se duplica un envío; en el peor caso no se envía y el estado lo muestra. No existe retry ciego — un fallo requiere una nueva acción confirmada por el usuario.

## Política de almacenamiento

| Entorno | Supabase OK | Supabase caído / tablas faltantes |
|---|---|---|
| `NODE_ENV=production` | normal | **falla seguro**: `503 STORAGE_UNAVAILABLE`, no se escribe nada, no se afirma nada |
| dev/test con `BUSINESS_ASSISTANT_ALLOW_FILE_STORAGE=true` | normal | fallback JSON local en `assistant-data/` |
| dev/test sin la variable | normal | `503 STORAGE_UNAVAILABLE` |

El fallback local requiere habilitación **explícita** — nunca se activa silenciosamente.

### Disponibilidad: FAIL-CLOSED

`getActiveBlockIntervals()` distingue estrictamente entre lectura exitosa con cero bloqueos (`[]` → la reserva puede continuar) y fallo de storage (**lanza** `AVAILABILITY_UNAVAILABLE`). Un fallo jamás se interpreta como "no hay bloqueos". Los 6 puntos que verifican disponibilidad (link `/confirm`, botón SLOT, booking heurístico, APPOINTMENT_JSON del LLM, verificación de reagendamiento y sugerencias de reagendamiento) rechazan la operación con un mensaje neutral bilingüe: *"No pude verificar la disponibilidad en este momento. Inténtalo nuevamente en unos minutos."* / código `AVAILABILITY_UNAVAILABLE`; `/confirm` devuelve 503 y **conserva el token** para reintento. Las conversaciones que no tocan disponibilidad (servicios, precios, ubicación, flujo determinístico de cancelación) siguen funcionando — probado con storage caído. Consecuencia operativa: **la migración es requisito para reservas en producción** — sin las tablas, toda reserva devuelve el mensaje neutral hasta aplicarla.

## Integración con el recepcionista

`availability_exceptions` es la única fuente de bloqueos. `index.js` usa `busyWithBlocks(slug, list)` en TODOS los puntos de reserva (link de confirmación, botón SLOT, booking heurístico, APPOINTMENT_JSON del LLM, reagendamiento), de modo que el recepcionista público nunca ofrece ni confirma horarios bloqueados. Probado: reserva a las 4pm dentro de un bloqueo 14:00–18:00 ⇒ CONFLICT con sugerencias fuera del bloqueo.

## Privacidad

- `internal_reason` (privado del dueño) y `public_reason` (texto neutro para clientes) se guardan por separado; el prompt prohíbe filtrar motivos internos y los mensajes salientes se construyen solo con texto aprobado por el dueño en la confirmación.
- Resultados de herramientas viajan al modelo envueltos en `{UNTRUSTED_DATA: …}` — datos, no instrucciones (protección prompt-injection).
- Teléfonos parcialmente enmascarados en tarjetas; logs sin cuerpos completos ni secretos.

## Base de datos

Migración: `migrations/001_business_assistant.sql` (crear en Supabase SQL Editor; rollback comentado al final). Tablas: `business_assistant_conversations`, `business_assistant_messages`, `availability_exceptions`, `assistant_pending_actions`, `assistant_action_logs` + función `ba_confirm_action`. RLS habilitado deny-all (el backend usa service key y filtra SIEMPRE por `tenant_slug` en código).

Sin la migración aplicada, todo funciona con el fallback JSON (`assistant-data/`, ignorado por git; efímero en Render — aplicar la migración para persistencia real en producción).

## Variables de entorno

Existentes: `GROQ_API_KEY`, `GROQ_MODEL` (opcional), `JWT_SECRET`, `SUPABASE_*`.
- `BUSINESS_ASSISTANT_GROQ_MODEL` (opcional): modelo del orquestador del BA. Prioridad `BUSINESS_ASSISTANT_GROQ_MODEL` → `GROQ_MODEL` → default `llama-3.3-70b-versatile` (robusto para tool-calling). No cambia el modelo del recepcionista público. El default 8b-instant se evita aquí porque produce `tool_use_failed` en herramientas de escritura.
- `BUSINESS_ASSISTANT_ALLOW_FILE_STORAGE=true` (solo dev/test): habilita el fallback JSON local. Sin efecto en producción.
- `TWILIO_ENABLED=true|false`: habilita el canal Twilio (SMS/Voice). Si no se define, se deduce `true` solo cuando existe la config completa (`TWILIO_ACCOUNT_SID`+`TWILIO_AUTH_TOKEN`). Con el canal deshabilitado el servidor arranca sin Twilio (ningún placeholder); habilitado con config parcial es error de arranque.

## Robustez del tool-calling

Si Groq devuelve `tool_use_failed` (tool call malformado), el orquestador hace **un** reintento controlado con instrucciones más estrictas y `temperature` menor. Si el segundo intento también falla, responde con el mensaje neutral y **no** crea ninguna acción a partir de datos incompletos. Sin loops, sin argumentos inventados.

## Cálculo determinista de citas afectadas

Las herramientas de disponibilidad (`create_availability_block`, `find_affected_appointments`) reciben **tiempo local en campos separados**: `date` (`YYYY-MM-DD`), `start_time` (`HH:mm`), `end_time` (`HH:mm`). El modelo **nunca** entrega zona horaria. El backend (`buildLocalBlockInterval` en `auth/runtime-config.js`) aplica la zona del **tenant autenticado** y construye los timestamps reales de forma determinista. Cualquier `Z`, offset (`±HH:mm`), nombre de zona o ISO completo en los campos de hora se **rechaza** (nunca se elimina silenciosamente), de modo que `20:00Z` no puede reinterpretarse como 20:00 local. Los huecos de horario de verano (hora inexistente) devuelven `AMBIGUOUS_DATE`.

El solapamiento se calcula con timestamps reales — cubre cita-empieza-dentro, cita-termina-dentro, cita-contiene-bloqueo, bloqueo-contiene-cita, límites exactos — y excluye canceladas y otros tenants (`loadAppointments` está scoped por tenant). Antes de ejecutar el bloqueo se **recalcula** el impacto; si cambió desde la propuesta, devuelve `SCHEDULE_CHANGED` y no ejecuta silenciosamente.

La función `resolveTwilioConfiguration` (`auth/runtime-config.js`) es la **única** fuente de la decisión de habilitación de Twilio, importada tanto por `index.js` como por `tests/twilio-gating.test.mjs` (el test ejercita el código real, no una copia).

## Pruebas

`node tests/business-assistant.test.mjs` — 23 pruebas sin red (Supabase offline-stub, Groq scriptado): aislamiento de tenant, acciones pendientes, confirmación concurrente, doble confirmación, expiración, producción-sin-fallback, tool desconocido, argumentos malformados, tenant inyectado por el modelo, fallo de Groq, fallo de proveedor SMS, privacidad de motivos internos, ambigüedad de clientes, bloqueos vistos por el recepcionista.

Migración: validar con `migrations/verify_001_business_assistant.sql` en Supabase después de aplicarla.

## Extensiones futuras

- **Google Calendar**: agregar herramientas `get_calendar_events` / `create_calendar_event` en `TOOLS` y un adaptador en el executor; el flujo de confirmación ya lo soporta sin cambios.
- **Roles**: la política vive en cada tool (`risk`) + los checks del router; para roles añadir un mapa role→tools permitidas en `mountBusinessAssistant`.
- **Retry de acciones fallidas**: crear una nueva acción desde `result_summary`; no reintentar in-place.
