# Caja para tejo y billar

Proyecto de portafolio para administrar un establecimiento con seis mesas de billar, seis canchas de maxitejo, seis de tejo largo y venta de productos. Un cajero registra las operaciones en el computador del negocio. El administrador puede consultar la caja desde un panel para celular conectado a Supabase.

## Estado

La aplicación local permite administrar el inventario, registrar ventas de productos y manejar cuentas por nombre. El cajero puede cobrar de inmediato, dejar un saldo fiado o registrar un abono con efectivo, transferencia y fichas.

En **Billar**, abre la mesa, registra los productos entregados y pulsa **Terminar y cobrar**. La mesa muestra las horas de inicio y fin. Si detuviste el tiempo por error, usa **Reanudar tiempo**. La pausa queda fuera del cobro. Cobra a una persona o abre **Repartir entre personas** para dividir el tiempo y los consumos. Si se abrió por error y no tiene productos entregados, usa **Cancelar inicio** para liberar la mesa sin cargo.

En **Tejo → Canchas y chicos**, elige la cancha e ingresa cuántos jugadores hay. Puedes agregar más jugadores para los próximos chicos. Registra los chicos aunque todavía no sepas quién perdió. Después, en **Asignar chicos perdidos**, escribe cuántos perdió cada persona y el nombre para cargar el importe a su cuenta. Cada jugador puede usar su derecho en una ficha o en productos incluso antes de que se asigne el resultado.

En **Venta → Cobrar → Fichas**, cada ficha cubre hasta $4.000 en productos. Si queda una diferencia, puedes completarla en efectivo, por transferencia o con **Mixto**. En un pago mixto se indica si las fichas se usan en productos ($4.000) o como abono ($3.000). Los abonos en **Cuentas** y los pagos de la cuenta de billar aplican las fichas a $3.000.

El encabezado de la app mantiene visible la fecha y la hora de Colombia.

En **Caja**, abre el turno con el nombre del cajero, la base de efectivo y las fichas físicas contadas. Registra los aportes y pagos del fondo para compras por separado. Si una salida se usó para comprar mercancía, puedes elegir ese gasto al ingresar existencias. Para cerrar, ingresa el conteo de ambos fondos, las transferencias verificadas, las fichas físicas y la base que dejas. El sistema guarda los conteos, las diferencias y cuánto entregas al administrador.

El cuadre de fichas suma las recibidas por pago y canje, y resta las entregadas en tejo. El próximo turno muestra cuántas se contaron al cierre anterior. Si estás actualizando con un turno abierto, puedes completar su conteo inicial desde **Caja** y registrar de dónde salió ese dato.

Al guardar un cierre, el sistema muestra **Descargar informe PDF**. También puedes volver a descargarlo desde **Caja → Historial de cierres**. El informe del Club de Tejo Patio Bonito incluye el encargado, el cajero, las horas del turno y de emisión, el cuadre de efectivo, transferencias y fichas, la entrega al administrador y el detalle de los movimientos. Se genera en el computador con los datos del turno cerrado.

## Ejecutar en el computador

Con [Node.js](https://nodejs.org/) 22.12 o posterior, abre la terminal de VS Code en la carpeta del proyecto y ejecuta:

```sh
npm ci
npm start
```

Abre <http://127.0.0.1:4173>. La instalación inicial de dependencias requiere internet. Después, `npm start` compila e inicia juntos la pantalla y el servidor con archivos y datos locales. Al actualizar, detén primero la ejecución anterior con **Ctrl+C** y vuelve a ejecutar `npm start`.

Para probar el inventario, crea una cerveza con un empaque «Canasta» de 30 unidades. Registra una entrada de 2 canastas: las existencias deben subir a 60. Registra después una salida manual de 1 unidad con su motivo: deben quedar 59.

Para una venta rápida, abre un turno en **Caja** y entra en **Venta**. Selecciona los productos para agregarlos con un clic. Si prefieres el teclado, usa **F2** para buscar, **↓** para entrar a los resultados, las flechas para recorrerlos y **Enter** para agregar. Usa **F4** para abrir el cobro, **Tab** para cambiar de campo y **Esc** para volver a la cuenta sin perder lo anotado.

Puedes escribir la cantidad del producto directamente en la cuenta. Al cobrar en efectivo, puedes anotar cuánto entregó el cliente y ver el devuelto antes de confirmar. Solo el importe que corresponde a la venta entra al cuadre. En **Caja**, la **Calculadora de billetes y monedas** multiplica cada denominación por la cantidad contada y pasa el total a la base o al fondo que selecciones.

Para probar el fiado, crea una cuenta en **Cuentas**, luego abre **Venta** y agrega cuatro cervezas de $4.000. En **Cobrar → Mixto**, selecciona la cuenta y registra $6.000 en efectivo. Deben quedar $10.000 pendientes y salir cuatro unidades. Registra después un abono de $7.000 en efectivo y una ficha. El saldo queda en cero sin otra salida de inventario.

Ejecuta `npm test` para compilar y comprobar el inventario, el fiado, los pagos mixtos, las cuentas de billar y tejo, el cierre de caja y la recuperación de los datos al reiniciar. Las pruebas usan bases temporales.

La base se crea en `data/caja.sqlite` e incluye las fotos del catálogo.

## Panel móvil del administrador

Con el servidor local iniciado, abre [la demostración](http://127.0.0.1:4173/admin/?demo=1). Puedes cambiar de día, abrir un cierre, consultar las mesas y canchas ocupadas y buscar productos. Los datos de esta demostración son ficticios y funcionan sin configurar Supabase.

El panel real es privado y de solo lectura. Consulta los últimos 30 días de ventas y cobros, los últimos 30 cierres, los saldos pendientes, el inventario activo y la ocupación. Muestra la hora de la última sincronización y avisa si los datos llevan más de tres minutos sin actualizarse. Sigue los [pasos de instalación del panel remoto](docs/panel-admin.md) para conectarlo al proyecto Supabase del club y publicar su enlace HTTPS.

## Arquitectura

| Componente | Tecnología | Responsabilidad |
| --- | --- | --- |
| Interfaz de caja | React, Vite y TypeScript | Abrir cuentas, registrar pedidos y operar el cierre desde el navegador del computador. |
| Aplicación local | Node.js y TypeScript | Servir la interfaz, validar operaciones y guardar los movimientos. |
| Datos locales | SQLite | Mantener cuentas abiertas, inventario, cobros y cierres aunque no haya internet. |
| Panel del administrador | React y Supabase | Consultar desde el celular los datos sincronizados. Supabase aloja la copia y gestiona el acceso del administrador. |

La caja es el origen de los datos. Cuando se configura Supabase, el servidor reemplaza la copia de consulta en segundo plano aproximadamente cada minuto. Si hay un fallo de conexión, vuelve a intentarlo con los datos actuales sin duplicar ventas. Las fotos se guardan en la caja local.

## Documentación

- [Reglas del negocio y casos de aceptación](docs/reglas-del-negocio.md)

## Hitos

1. Documentar las reglas y los casos de aceptación.
2. Preparar el proyecto local, conectar SQLite y comprobar que guarda datos sin internet.
3. Implementar catálogo, fotos e inventario.
4. Implementar cuentas por nombre y cobros.
5. Incorporar el cronómetro y el reparto de billar.
6. Implementar los chicos y canjes de tejo.
7. Implementar apertura, movimientos, cuadre y cierre de los fondos de caja.
8. Sincronizar con Supabase, crear el panel del administrador y preparar una demostración con datos ficticios.

El repositorio de portafolio usará datos ficticios. La base de datos del negocio, fotos cargadas por el cajero, credenciales, respaldos y archivos de exportación se guardarán fuera del código versionado.
