# Hololive OCG Collection Tracker

Aplicación web en **Rust + SQLite 3** (modo local) y **Firebase Hosting + Cloud Firestore + Google Auth** (modo online), con interfaz **Material Design 3** (Modo Nocturno, Mobile, conversión **USD ↔ CLP** con tasa del día y seguimiento de colección para las 26 ediciones de *hololive OFFICIAL CARD GAME*).

## Versión Online (Firebase)

- **URL Pública:** https://hololive-ocg-tracker-sb.web.app
- **Consola Firebase:** https://console.firebase.google.com/project/hololive-ocg-tracker-sb/overview
- **Base de datos en la nube:** Cloud Firestore (`users/{uid}/collection`, `users/{uid}/decks`, `users/{uid}/settings/exchangeRate`) protegida por [firestore.rules](firestore.rules).
- **Acceso:** Haz clic en **"Iniciar sesión con Google"** en la barra superior para sincronizar tu colección, mazos y tasa CLP en tiempo real desde cualquier dispositivo.
- **Publicar cambios a Firebase:**
  ```bash
  ./hocg deploy
  ```

## Versión Local (Rust + SQLite) — Encender y Apagar

Solo necesitas un comando desde la carpeta del proyecto (o usar el acceso directo `Hololive-OCG-Tracker.desktop`):

- **Acceso directo gráfico (`.desktop`):**
  - Puedes usar [Hololive-OCG-Tracker.desktop](Hololive-OCG-Tracker.desktop) directamente o instalarlo en tu menú de aplicaciones / escritorio con:
    ```bash
    ./hocg install-desktop
    ```
  - Al abrirlo ejecuta `./hocg start` y abre la app en tu navegador; con clic derecho incluye **Apagar Servidor** y **Alternar Encendido / Apagado**.
- **Encender y abrir en el navegador:**
  ```bash
  ./hocg
  ```
- **Apagar cuando termines:**
  - Desde la web: haz clic en el botón **⏻** (en la barra lateral izquierda o superior) y confirma **Apagar ahora**.
  - O desde la terminal:
    ```bash
    ./hocg stop
    ```
- **Otros comandos útiles:**
  - `./hocg status` — Ver si la app está encendida o apagada.
  - `./hocg toggle` — Encender si está apagada, o apagar si está encendida.
  - `./hocg start --no-browser` — Encender sin abrir pestaña automáticamente.
  - `./hocg update` — Descargar nuevas ediciones/precios desde `tcgcsv.com`, actualizar el dólar observado (CLP) y refrescar `static/data/`.
  - `./hocg deploy` — Publicar cambios en Firebase Hosting y Firestore.

## Datos Locales

Toda la información descargada y tu colección personal viven en `resources/` (y en `static/data/` para Firebase Hosting):
- `resources/hololive_ocg.db` — Base de datos local SQLite 3 (catálogo, colección, mazos y tasa USD→CLP).
- `resources/cards_cleaned.csv` y `resources/cards_cleaned.json` — Dataset saneado.
- `resources/editions/` — JSON y CSV originales por cada una de las 26 ediciones.
