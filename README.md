# Caja para tejo y billar

Proyecto de portafolio para administrar un establecimiento con seis mesas de billar, seis canchas de maxitejo, seis de tejo largo y venta de productos. Un cajero registra las operaciones en el computador del negocio. El administrador tendrá un panel de consulta desde el celular.

## Estado

La aplicación local permite administrar el inventario, registrar ventas de productos y manejar cuentas por nombre. El cajero puede cobrar de inmediato, dejar un saldo fiado o registrar un abono con efectivo, transferencia y fichas.

En **Billar**, puedes abrir cualquiera de las seis mesas a $6.000 por hora, anotar los productos que se entreguen y detener el tiempo cuando termine el juego. Reparte el tiempo y cada consumo por igual o con importes distintos, y cobra o fía la parte de cada persona antes de liberar la mesa.

En **Tejo → Canchas y chicos**, selecciona una cancha de maxitejo o de tejo largo y abre un grupo con los nombres de los jugadores. Registra quién perdió cada chico y su pago, o deja el cargo fiado. Cada jugador puede recibir una ficha o consumir su valor en productos. El grupo conserva el contador y el historial de los chicos hasta que se libere la cancha. Para recibir fichas físicas a cambio de productos, usa **Tejo → Canjear fichas**.

En **Caja**, abre el turno con el nombre del cajero, la base de efectivo y las fichas físicas contadas. Registra los aportes y pagos del fondo para compras por separado. Si una salida se usó para comprar mercancía, puedes elegir ese gasto al ingresar existencias. Para cerrar, ingresa el conteo de ambos fondos, las transferencias verificadas, las fichas físicas y la base que dejas. El sistema guarda los conteos, las diferencias y cuánto entregas al administrador.

El cuadre de fichas suma las recibidas por pago y canje, y resta las entregadas en tejo. El próximo turno muestra cuántas se contaron al cierre anterior. Si estás actualizando con un turno abierto, puedes completar su conteo inicial desde **Caja** y registrar de dónde salió ese dato.

## Ejecutar en el computador

Con [Node.js](https://nodejs.org/) 22.12 o posterior, abre la terminal de VS Code en la carpeta del proyecto y ejecuta:

```sh
npm ci
npm start
```

Abre <http://127.0.0.1:4173>. La instalación inicial de dependencias requiere internet. Después, `npm start` compila e inicia juntos la pantalla y el servidor con archivos y datos locales. Al actualizar, detén primero la ejecución anterior con **Ctrl+C** y vuelve a ejecutar `npm start`.

Para probar el inventario, crea una cerveza con un empaque «Canasta» de 30 unidades. Registra una entrada de 2 canastas: las existencias deben subir a 60. Registra después una salida manual de 1 unidad con su motivo: deben quedar 59.

Para una venta rápida, abre un turno en **Caja** y entra en **Venta**. Selecciona los productos para agregarlos con un clic. Si prefieres el teclado, usa **F2** para buscar, **↓** para entrar a los resultados, las flechas para recorrerlos y **Enter** para agregar. Usa **F4** para abrir el cobro, **Tab** para cambiar de campo y **Esc** para volver a la cuenta sin perder lo anotado.

Para probar el fiado, crea una cuenta en **Cuentas**, luego abre **Venta** y agrega cuatro cervezas de $4.000. En **Cobrar → Mixto / fichas**, selecciona la cuenta y registra $6.000 en efectivo. Deben quedar $10.000 pendientes y salir cuatro unidades. Registra después un abono de $7.000 en efectivo y una ficha. El saldo queda en cero sin otra salida de inventario.

Ejecuta `npm test` para compilar y comprobar el inventario, el fiado, los pagos mixtos, las cuentas de billar y tejo, el cierre de caja y la recuperación de los datos al reiniciar. Las pruebas usan bases temporales.

La base se crea en `data/caja.sqlite` e incluye las fotos del catálogo. Supabase se incorporará con el panel remoto.

## Arquitectura propuesta

| Componente | Tecnología | Responsabilidad |
| --- | --- | --- |
| Interfaz de caja | React, Vite y TypeScript | Abrir cuentas, registrar pedidos y operar el cierre desde el navegador del computador. |
| Aplicación local | Node.js y TypeScript | Servir la interfaz, validar operaciones y guardar los movimientos. |
| Datos locales | SQLite | Mantener cuentas abiertas, inventario, cobros y cierres aunque no haya internet. |
| Panel del administrador | React y Supabase | Consultar desde el celular los datos ya sincronizados. Supabase alojará la copia para consulta y gestionará el acceso del administrador. |

La caja será el origen de los datos. El envío a Supabase se hará en segundo plano y podrá reintentarse sin duplicar movimientos. El panel deberá mostrar la hora de la última sincronización para indicar hasta cuándo están actualizadas las cifras. Las fotos necesarias en caja se almacenarán localmente.

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
