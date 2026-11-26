# Reglas de Arquitectura — Hololive OCG Tracker (`myFriendlyPC`)

## Regla de Oro: Desarrollo Modular Obligatorio

Toda modificación, corrección o nueva funcionalidad en este repositorio **DEBE** seguir la arquitectura modular por dominio y capas. Queda estrictamente prohibido volver a archivos monolíticos (como `static/js/app.js`) o acumular lógica de vistas, reglas de negocio o listeners específicos dentro de `static/js/main.js`.

---

## 1. Frontend (`static/js/`) — ES Modules Nativos

### Reglas técnicas no negociables
- **ES Modules nativos del navegador (`<script type="module">`):** Cero bundlers y cero toolchain Node/Vite. Todo `import` relativo debe incluir la extensión explícita `.js`.
- **Integración Firebase clásica:** Mantener `static/js/firebase-config.js` y `static/js/firebase-cloud.js` como `<script>` clásicos en `static/index.html` inmediatamente antes de `<script type="module" src="/js/main.js?v=...">`. Al modificar HTML/JS/CSS de `static/`, actualizar el query param `?v=...` correspondiente cuando aplique.
- **Sin dependencias circulares (DAG estricto por capas):**
  ```text
  core/  <──  components/  <──  views/  <──  main.js
  ```
  1. `static/js/core/` (`constants.js`, `state.js`, `actions.js`, `formatters.js`, `api.js`, `theme.js`, `currency.js`): utilidades puras, estado y cliente API. No deben importar `components/` ni `views/`.
  2. `static/js/components/` (`card-ui.js`, `card-modal.js`, y futuros componentes compartidos): solo importan desde `core/` (y otros `components/` sin ciclos).
  3. `static/js/views/` (`kpis.js`, `catalog.js`, `collection.js`, `wishlist-pdf.js`, `trading.js`, `audit.js`, `decks/`): solo importan desde `core/` y `components/`. **Prohibido importar entre vistas hermanas.**
  4. Submódulos de dominio complejo (p. ej. `views/decks/{rules.js, preview.js, studio.js, index.js}`): separar siempre lógica/reglas puras, renderizado/previews, editor/studio y orquestación de vista, manteniendo un flujo acíclico (`rules` ← `preview` / `studio` ← `index`).
- **Comunicación entre vistas vía `core/actions.js`:** Cualquier llamada cruzada entre vistas o desde `core/`/`components/` hacia vistas superiores debe invocarse mediante `actions.<accion>?.(...)` y registrarse explícitamente con `registerActions({...})` en `static/js/main.js`.
- **Estado mutable compartido:** Todo estado global o transitorio compartido entre módulos vive como propiedades dentro de `state` o `runtime` en `static/js/core/state.js` (nunca reasignar `export let` entre módulos).
- **Eventos descentralizados (`bind<Modulo>Events`):** Cada vista y componente registra sus propios listeners del DOM en su función exportada `bind*Events()`, invocada desde `bindGlobalEvents()` en `static/js/main.js`. En `main.js` solo permanecen el bootstrap (`document.readyState`), `HololiveCloudBackend.initPromise`, `switchView()`, `rerenderCurrencyViews()`, `window.onFirebaseAuthChanged` / `window.onCloudDataChanged` (debounce `120ms` + `runtime.suppressCloudCardsReloadUntil`) y listeners estrictamente globales (`[data-view]`, cierre de modales con `Escape`, `#scroll-top-btn`).

### Cómo agregar nuevas funcionalidades en Frontend
- **Nueva vista o feature grande** (p. ej. Simulador de Mano Inicial, Colección por Oshi, Escáner de Mazo por Foto): crear un módulo dedicado `static/js/views/<feature>.js` o subcarpeta `static/js/views/<feature>/` separando reglas/cálculos puros (`rules.js` / `engine.js`), UI (`ui.js`) y eventos (`index.js`).
- **Nuevo componente reutilizable:** ubicarlo en `static/js/components/<component>.js`.
- **Tamaño y cohesión:** Si un archivo empieza a mezclar responsabilidades distintas o crece de forma desproporcionada, dividirlo antes de seguir agregando código. Reutilizar helpers compartidos (`formatters.js`, `api.js`) en lugar de duplicar lógica.

---

## 2. Backend Rust (`src/`) y Scripts (`scripts/`)

- Mantener la misma separación modular por responsabilidad: lógica de dominio y saneamiento/reglas puras aisladas (con tests unitarios), capa de datos/SQLite y capa de handlers/rutas HTTP en Axum sin mezclar lógica de negocio extensa en los endpoints.

---

## 3. Verificación Mínima Obligatoria

Antes de dar por terminado cualquier cambio que afecte al código frontend/backend:
1. Ejecutar `node --check` sobre todos los archivos `.js` nuevos o modificados.
2. Confirmar ausencia de imports sin extensión `.js`, cero dependencias circulares entre módulos y que toda clave `actions.<prop>` invocada esté registrada en `static/js/main.js`.
3. Ejecutar `cargo test --offline`.
4. Verificar en navegador (`http://127.0.0.1:8080` en local y/o Firebase Preview Channel en cambios web) que todos los módulos `.js` responden HTTP `200` con `Content-Type` JavaScript válido (`0` respuestas `404`, `0` rewrites a `text/html`), `0` errores en consola y flujo funcional completo en las vistas afectadas.
