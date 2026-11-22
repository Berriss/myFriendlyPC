# Hololive OCG Collection Tracker

Aplicación web en **Rust + SQLite 3** (modo local) y **Firebase Hosting + Cloud Firestore + Google Auth** (modo online), con interfaz **Material Design 3** (Modo Nocturno, Mobile, conversión **USD ↔ CLP** con tasa del día y seguimiento de colección para las 26 ediciones de *hololive OFFICIAL CARD GAME*).

## Versión Online (Firebase)

- **URL Pública:** https://hololive-ocg-tracker-sb.web.app
- **Consola Firebase:** https://console.firebase.google.com/project/hololive-ocg-tracker-sb/overview
- **Base de datos en la nube:** Cloud Firestore:
  - Privada por usuario: `users/{uid}/collection`, `users/{uid}/decks`, `users/{uid}/settings/exchangeRate`.
  - Catálogo y tasas diarias públicas (solo lectura en web, escritura por Admin SDK): `editions/{groupId}`, `metadata/catalog`, `metadata/prices`, `metadata/audit`, `metadata/exchangeRate` (protegido por [firestore.rules](firestore.rules)).
- **Acceso:** Haz clic en **"Iniciar sesión con Google"** en la barra superior para sincronizar tu colección, mazos y tasa CLP en tiempo real desde cualquier dispositivo.
- **Actualización diaria automática (GitHub Actions + Firebase Admin):**
  - `.github/workflows/sync-tcgcsv-daily.yml`: Se ejecuta todos los días a las **20:30 UTC** (luego de la actualización diaria de las `20:00:00 UTC` en `tcgcsv.com`), descarga y sanea las 26+ ediciones/precios y las guarda incrementalmente en Cloud Firestore ([sync_tcgcsv_to_firestore.py](scripts/sync_tcgcsv_to_firestore.py)).
  - `.github/workflows/sync-clp-rate-daily.yml`: Se ejecuta todos los días a las **13:00 UTC**, obtiene la tasa oficial **USD → CLP** (`mindicador.cl` con respaldo en `open.er-api.com`) y la actualiza en `metadata/exchangeRate` ([sync_clp_rate_to_firestore.py](scripts/sync_clp_rate_to_firestore.py)).
  - **Configuración única requerida en GitHub:**
    1. En **Firebase Console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**, descarga el archivo JSON.
    2. En tu repositorio de GitHub ve a **Settings → Secrets and variables → Actions → New repository secret**, crea el secreto llamado `FIREBASE_SERVICE_ACCOUNT` y pega el contenido completo del JSON.
    3. Desde la pestaña **Actions** en GitHub ya puedes disparar ambos flujos manualmente con **Run workflow** la primera vez para poblar Firestore de inmediato.
- **Publicar cambios a Firebase Hosting / Rules:**
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
