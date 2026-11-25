# Activar la caja en el PC de la cajera

## Preparación e instalación

1. En el PC del establecimiento, inicia sesión con el **usuario de Windows que usará la cajera**. La tarea de arranque se registra para ese usuario.
2. Deja el proyecto en una carpeta fija a la que ese usuario pueda escribir e instala Node.js 22.12 o posterior. Ten internet disponible para descargar las dependencias durante la instalación. Si ya hay datos del club que deban trasladarse, prepara primero la base del negocio siguiendo los [pasos de respaldo y restauración](../README.md#copias-de-seguridad).
3. Si la caja está ejecutándose en una terminal, termina el turno y detén esa ejecución con **Ctrl+C**. Abre la carpeta del proyecto en el Explorador de archivos, escribe `powershell` en la barra de direcciones y pulsa **Enter**.
4. Ejecuta este comando una sola vez y espera a que aparezca **Inicio automatico configurado**.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\windows-install-cash.ps1
   ```

## Comprobar que quedó funcionando

1. Cierra sesión en Windows con la caja fuera de turno y vuelve a entrar con el mismo usuario. No abras PowerShell.
2. En el escritorio, abre **Caja Patio Bonito**. Si necesitas abrirla directamente en el navegador, la dirección predeterminada es `http://127.0.0.1:4173/`.
3. La pantalla debe pedir el usuario y PIN de caja si la aplicación ya está configurada. En una instalación nueva, Humberto debe crear primero el administrador local y luego el usuario de la cajera desde **Personal → Usuarios**.

En adelante, la cajera entra a Windows y abre **Caja Patio Bonito**. La caja local funciona sin conexión a internet.

## Si la página no abre

- Si acabas de entrar a Windows, espera unos segundos y recarga la página.
- Si sigue sin abrir, verifica que entraste con el mismo usuario de Windows que usaste al instalar. Abre **Programador de tareas → Biblioteca del Programador de tareas** y busca la tarea que comienza por **Caja Patio Bonito**. Los registros están en `data/logs/caja.log` y `data/logs/caja-error.log`, dentro del proyecto.
- Si el instalador indicó que el puerto ya estaba en uso, verifica que hayas terminado la ejecución manual de la caja y vuelve a iniciar sesión en Windows.

## Actualizar o quitar el arranque automático

Para actualizar, con el turno cerrado, detén la tarea **Caja Patio Bonito**, actualiza el proyecto y ejecuta de nuevo el instalador. Si cambiaron las dependencias del proyecto, ejecuta primero `npm ci` con internet.

Para quitar el arranque de un equipo, con el turno cerrado, finaliza y elimina la tarea **Caja Patio Bonito** en el Programador de tareas y borra el acceso directo del escritorio. La base y los respaldos se conservan al retirar esos dos elementos.
