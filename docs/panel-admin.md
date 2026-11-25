# Activar el acceso desde el celular

## 1. Configurar Supabase

1. Usa un proyecto de Supabase para el club, con la Data API activa y el esquema `public` expuesto.
2. En **SQL Editor**, ejecuta una vez la [migración del panel](../supabase/migrations/202611240001_admin_panel.sql). Crea la tabla de sincronización y sus permisos.
3. En **Authentication → Users**, crea o elige el usuario de Humberto con correo y contraseña confirmados. Copia su UUID. En **SQL Editor**, asigna el acceso al panel usando su UUID:

   ```sql
   update auth.users
   set raw_app_meta_data =
     coalesce(raw_app_meta_data, '{}'::jsonb) || '{"caja_admin":true}'::jsonb
   where id = 'REEMPLAZAR-POR-EL-UUID'::uuid
   returning id;
   ```

   Verifica que devuelva el UUID elegido. Si el usuario ya tenía una sesión, vuelve a iniciar sesión para recibir los permisos actualizados.

4. En **Connect** o **Settings → API Keys**, ubica la URL del proyecto y las claves de tipo **Publishable** y **Secret**. Consulta la [guía de claves de Supabase](https://supabase.com/docs/guides/getting-started/api-keys).

## 2. Conectar el computador de caja

Copia `.env.example` como `.env` en la raíz del proyecto. Completa `CAJA_SUPABASE_URL` con la URL del proyecto sin barra final y `CAJA_SUPABASE_SECRET_KEY` con la clave `sb_secret_…`. Guarda esta clave únicamente en el computador de caja. Mantén el archivo `.env` fuera de GitHub y del alojamiento del panel.

Reinicia la caja con `npm start`. El primer envío comienza al arrancar. Si se interrumpe la conexión, el cajero puede seguir registrando operaciones y, al recuperarse, la copia se actualiza con lo guardado en SQLite. El servidor mantiene solo una copia en Supabase para que cada reintento reemplace el mismo registro.

## 3. Publicar solo el panel

Completa `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con la URL y la clave `sb_publishable_…`. Estas dos variables se incluyen en la compilación pública. En un entorno de compilación separado basta con configurarlas como variables de entorno.

```sh
npm ci
npm run build:admin
```

Publica únicamente el contenido de `dist/admin` en un alojamiento web estático con HTTPS. Abre el enlace del alojamiento en el celular e inicia sesión con la cuenta autorizada. Comprueba que aparezca la última sincronización y una operación que también veas en la caja.

Para publicar la pantalla en Cloudflare, sube la carpeta `dist/admin` o un ZIP con su contenido a **Cloudflare Drop** y reclama la publicación desde tu cuenta para conservar el enlace. Los datos y el inicio de sesión se gestionan en Supabase. [Publicación con Cloudflare Drop](https://developers.cloudflare.com/changelog/post/2026-07-08-cloudflare-drag-and-drop/).

Para publicar la demo en GitHub Pages, abre **Settings → Pages** en un repositorio donde esté disponible y elige **GitHub Actions** como origen. Luego abre **Actions → Publicar demo móvil → Run workflow** en `main`. [Configurar GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

El sitio se puede abrir desde cualquier red con internet. Si el computador se apaga o pierde conexión, el panel conserva en Supabase la última copia disponible con su fecha y hora. La caja se ejecuta en el computador del local y sigue siendo la fuente de los datos.

## Demostración del portafolio

Con `npm start`, abre [el panel de demostración local](http://127.0.0.1:4173/admin/?demo=1). Para alojar solo la demostración, compila el panel sin las dos variables `VITE_SUPABASE_…` y añade `?demo=1` al enlace publicado. La demostración incluye 30 días ficticios, un turno abierto, cierres con y sin diferencias, cuentas pendientes, juegos activos y productos con diferentes existencias.
