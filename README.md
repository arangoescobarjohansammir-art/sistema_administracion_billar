# Caja para tejo y billar

Proyecto de portafolio para administrar un establecimiento con seis mesas de billar, seis canchas de maxitejo, seis de tejo largo y venta de productos. Un cajero registra las operaciones en el computador del negocio. El administrador puede consultar la caja desde un panel para celular conectado a Supabase.

## Estado

La aplicación local permite administrar el inventario, registrar ventas de productos y manejar cuentas por nombre. El cajero puede cobrar de inmediato, dejar un saldo fiado o registrar un abono con efectivo, transferencia y fichas.

En **Billar**, abre la mesa, registra los productos entregados y pulsa **Terminar y cobrar**. La mesa muestra las horas de inicio y fin. Si detuviste el tiempo por error, usa **Reanudar tiempo**. La pausa queda fuera del cobro. Cobra a una persona o abre **Repartir entre personas** para dividir el tiempo y los consumos. Si se abrió por error y no tiene productos entregados, usa **Cancelar inicio** para liberar la mesa sin cargo.

En **Tejo**, elige la cancha y la modalidad **Individual**, **2 vs 2**, **3 vs 3** o **4 vs 4**. Puedes registrar chicos antes de saber quién perdió. Cuando se juega por fichas, indica cuántos chicos perdió cada equipo o jugador y escribe los nombres de quienes reciban un cargo por primera vez. En 2 vs 2, un chico por fichas cuesta $16.000 y se cargan $8.000 a cada jugador del equipo perdedor. Cada participante puede usar su ficha o su consumo aunque el resultado siga pendiente.

En **Apuesta del chico**, elige **Fichas**, **Solo productos** o **Productos y fichas**. Puedes combinar productos y elegir cantidades por unidad o por empaque. La canasta vale la suma de sus unidades al precio de venta. En chicos con productos, asigna el perdedor desde ese chico para cargar el importe exacto y confirma la entrega para descontar el inventario. Si el chico incluye fichas, su valor se suma por separado.

En **Billar → Repartir entre personas**, puedes preparar de una vez el reparto igual del tiempo y los consumos entre 2, 3 o 4 jugadores. Luego puedes ajustar los importes y cobrar o anotar cada parte.

En **Venta → Cobrar**, cada ficha cubre hasta $4.000 en productos tanto en **Fichas** como en **Mixto**. Si queda una diferencia, puedes completarla en efectivo, por transferencia o dejarla fiada a un cliente. Los abonos en **Cuentas** y los pagos de la cuenta de billar aplican las fichas a $3.000.

El encabezado de la app mantiene visible la fecha y la hora de Colombia.

Al **registrar consumo** en Billar o Tejo, puedes abrir la lista de productos, elegir una tarjeta con foto, nombre y precio, o escribir parte del nombre en **Buscar producto**. Las sugerencias se filtran desde la primera letra y puedes elegir con el mouse o con **↓** y **Enter**. En Billar, elige la cantidad y confirma la entrega. En Tejo, el producto se agrega a la lista del chico para revisar antes de confirmar.

## Usuarios y correcciones

En el primer acceso a la caja, el administrador crea su usuario local con una contraseña de al menos diez caracteres. Esta cuenta se usa en el computador de caja y sus datos de acceso son independientes del panel móvil. En **Personal → Usuarios**, el administrador puede crear usuarios de cajero con PIN de seis dígitos, cambiar sus PIN y desactivar su acceso. Cada persona inicia sesión con su propia cuenta.

En **Personal → Registro** se puede consultar quién registró una venta directa, un abono, un movimiento de caja o un ajuste de existencias, junto con la hora y el motivo cuando corresponde. La caja toma el nombre del usuario que inicia el turno.

En **Personal → Anular ventas**, el administrador puede anular una venta directa de productos del turno abierto. Confirma si el cobro se devolvió por el medio indicado o nunca se hizo, explica lo ocurrido y registra si se devolvieron todos los productos. La venta original queda visible y marcada como anulada. El sistema recalcula los cobros y saldos, y repone las existencias si se confirma la devolución física. La anulación de transferencias se registra en caja después de confirmar la devolución en el banco. Esta opción cubre las ventas directas del turno abierto.

En **Personal → Anular abonos**, el administrador puede anular un abono independiente del turno abierto. Confirma la devolución por cada medio de pago utilizado o que el dinero y las fichas nunca se recibieron. El sistema ajusta la caja, restituye el saldo del cliente y conserva el abono y el motivo en el historial. Si corresponde, registra el abono correcto en **Cuentas**.

En **Personal → Corregir cargos de tejo**, el administrador puede trasladar un cargo pendiente del turno abierto a otra cuenta. Selecciona el cliente correcto y registra el motivo. El chico, las fichas entregadas y los productos permanecen registrados tal como se jugaron. Si el cargo tiene un cobro asociado o supera el saldo pendiente, la aplicación bloquea el traslado.

En **Caja**, abre el turno con el nombre del cajero, la base de efectivo y las fichas físicas contadas. En **Fondo para compras**, el administrador registra el efectivo entregado y la cajera consulta el saldo disponible. Para descontar un pago, usa **Registrar movimiento → Pago desde el fondo para compras**. Si una salida se usó para comprar mercancía, puedes elegir ese gasto al ingresar existencias. Para cerrar, registra el efectivo contado en ambos fondos, las transferencias verificadas y las fichas físicas. Pulsa **Confirmar conteo y revisar** para ver el cuadre. Luego indica la base que dejas y explica cualquier diferencia antes de guardar.

Si necesitas volver a contar, usa **Hacer un recuento** e indica el motivo. El turno y su PDF conservan el primer conteo y los recuentos. Si los movimientos cambian los valores esperados después de revisar, la caja actualiza el cuadre y pide revisarlo antes de guardar.

El cuadre de fichas suma las recibidas por pago y canje, y resta las entregadas en tejo. El próximo turno muestra cuántas se contaron al cierre anterior. Si estás actualizando con un turno abierto, puedes completar su conteo inicial desde **Caja** y registrar de dónde salió ese dato.

Al guardar un cierre, el sistema muestra **Descargar informe PDF**. También puedes volver a descargarlo desde **Caja → Historial de cierres**. El informe del Club de Tejo Patio Bonito incluye el encargado, el cajero, las horas del turno y de emisión, el cuadre de efectivo, transferencias y fichas, la entrega al administrador y el detalle de los movimientos. Se genera en el computador con los datos del turno cerrado.

En **Reportes** el administrador puede elegir una semana de lunes a domingo o un mes calendario de Colombia y descargar el PDF. El informe muestra ventas, cobros por medio, anulaciones, movimientos de fondos, saldos de clientes y diferencias de los turnos cerrados. Los movimientos siguen la fecha en que se registraron y cada cuadre se incluye por la fecha de cierre del turno completo. Los abonos ya están incluidos en los cobros.

En **Caja → Registrar movimiento → Pago diario al personal**, registra el nombre del empleado y el efectivo entregado. El pago se descuenta de la caja de ventas y aparece en el informe del turno. **Reportes** muestra el total del periodo, el detalle de cada pago y cuánto recibió cada empleado.

## Ejecutar en el computador

### Inicio automático en el PC de caja con Windows

Sigue la [guía de activación en el PC de la cajera](docs/activar-caja-windows.md). La preparación se hace una vez y la caja se inicia en segundo plano cada vez que la cajera entra a Windows.

### Ejecución manual para desarrollo

Con [Node.js](https://nodejs.org/) 22.12 o posterior, abre la terminal de VS Code en la carpeta del proyecto y ejecuta:

```sh
npm ci
npm start
```

Abre <http://127.0.0.1:4173>. La instalación inicial de dependencias requiere internet. Después, `npm start` compila e inicia juntos la pantalla y el servidor con archivos y datos locales. Al actualizar, detén primero la ejecución anterior con **Ctrl+C** y vuelve a ejecutar `npm start`.

Para probar el inventario, crea una cerveza con un empaque «Canasta» de 30 unidades. Registra una entrada de 2 canastas: las existencias deben subir a 60. Registra después una salida manual de 1 unidad con su motivo: deben quedar 59.

En **Inventario → Conteo físico**, busca los productos que quieras revisar, escribe cuántas unidades de venta contaste y pulsa **Guardar y comparar**. Usa `0` cuando el producto esté agotado y deja en blanco los demás. El historial guarda lo esperado, lo contado y quién registró la revisión. Si el administrador confirma un faltante o sobrante, puede aplicar un ajuste con motivo. Este queda en los movimientos del producto y en **Personal → Registro**. Si hubo movimientos antes de guardar o de aplicar un ajuste, vuelve a contar los productos que cambiaron.

Para una venta rápida, abre un turno en **Caja** y entra en **Venta**. Selecciona los productos para agregarlos con un clic. Si prefieres el teclado, usa **F2** para buscar, **↓** para entrar a los resultados, las flechas para recorrerlos y **Enter** para agregar. Usa **F4** para abrir el cobro, **Tab** para cambiar de campo y **Esc** para volver a la cuenta sin perder lo anotado.

Puedes escribir la cantidad del producto directamente en la cuenta. Al cobrar en efectivo, puedes anotar cuánto entregó el cliente y ver el devuelto antes de confirmar. Solo el importe que corresponde a la venta entra al cuadre. En **Caja**, la **Calculadora de billetes y monedas** multiplica cada denominación por la cantidad contada y pasa el total a la base o al fondo que selecciones.

Para probar el fiado, crea una cuenta en **Cuentas**, luego abre **Venta** y agrega cuatro cervezas de $4.000. En **Cobrar → Mixto**, selecciona la cuenta y registra $6.000 en efectivo. Deben quedar $10.000 pendientes y salir cuatro unidades. Registra después un abono de $7.000 en efectivo y una ficha. El saldo queda en cero sin otra salida de inventario.

En **Mixto**, usa **Fiado a la cuenta (COP)** para escribir cuánto quieres dejar pendiente. La suma de lo pagado con efectivo, transferencia y fichas, más el fiado, debe cubrir el total. Si dejas el campo vacío, se calcula con la diferencia entre el total y lo pagado. Todo saldo fiado requiere una cuenta de cliente.

En **Venta → Cobrar → Mixto → Repartir fiado entre personas**, elige los clientes e indica cuánto queda pendiente en cada cuenta. Usa **Agregar persona** para incluir más clientes. Por ejemplo, puedes repartir una botella de $60.000 entre seis cuentas de $10.000. Si también recibes dinero o fichas, reparte únicamente el saldo que falte.

En **Cuentas**, el **Historial actual** reúne los cargos, pagos y anulaciones con fecha y hora de Colombia. Si queda saldo, los movimientos siguen en ese historial aunque cambie el día o el turno. Cuando la cuenta queda en cero, se puede consultar en **Historial anterior**. El siguiente cargo inicia un ciclo nuevo para el mismo cliente.

En **Venta**, **Billar** y **Tejo**, abre el desplegable para elegir un cliente de la lista completa o escribe parte de su nombre o apodo. Las sugerencias aparecen desde la primera letra, incluso si no escribes las tildes. Puedes elegir con el mouse o con **↓** y **Enter**.

Ejecuta `npm test` para compilar y comprobar el inventario, el fiado, los pagos mixtos, las cuentas de billar y tejo, el cierre de caja y la recuperación de los datos al reiniciar. Las pruebas usan bases temporales.

La base se crea en `data/caja.sqlite` e incluye las fotos del catálogo.

## Copias de seguridad

La caja crea y verifica un respaldo después de cada cierre. Al iniciar y cada cinco minutos, comprueba que haya una copia verificada de las últimas 24 horas que cubra el cierre más reciente. En **Caja → Copias de seguridad** puedes ver la fecha de la copia, la última verificación y los errores. La copia principal queda en `data/backups` por defecto y se conservan las copias anteriores.

Para guardar también una segunda copia, conecta un disco físico distinto del que aloja la base de caja. En el archivo `.env`, agrega por ejemplo `CAJA_BACKUP_SECONDARY_DIR=E:/Respaldos/PatioBonito`, con la letra de tu unidad, y reinicia la caja. Usa una carpeta dedicada al respaldo de esta instalación. Comprueba que los dos destinos aparezcan como **Verificado**. Si se desconecta el segundo disco, la copia local sigue funcionando y la caja vuelve a intentar guardar la secundaria automáticamente.

Para crear un respaldo manual y ensayar una restauración, usa la terminal de VS Code con la aplicación ya compilada:

```sh
npm run backup -- create
npm run backup -- verify "data/backups/NOMBRE-DE-LA-COPIA.sqlite"
npm run backup -- restore "data/backups/NOMBRE-DE-LA-COPIA.sqlite" "data/recuperacion/caja.sqlite"
```

Usa el nombre que devuelve el comando de respaldo. Para ensayar la recuperación, también puedes pasar al comando `restore` una copia del segundo disco. La restauración exige un archivo de destino nuevo y verifica la copia antes de abrirla. Incluye ventas, cuentas, inventario, cierres y fotos. `CAJA_BACKUP_DIR` permite personalizar la carpeta principal si ya usabas esa opción.

Cuando necesites continuar la operación con una base recuperada, elige la copia verificada más reciente. Detén la caja, configura `CAJA_DB_PATH=data/recuperacion/caja.sqlite` en `.env` e inicia con `npm start`. Comprueba que aparezca el último turno recuperado. Conserva la base original para poder revisar los movimientos posteriores al respaldo.

## Panel móvil del administrador

Abre el [panel móvil del club](https://club-tejo-patio-bonito.pages.dev/) o la [demostración con datos ficticios](https://club-tejo-patio-bonito.pages.dev/?demo=1). También puedes abrir [la demo local](http://127.0.0.1:4173/admin/?demo=1) con la caja iniciada. Puedes cambiar de día, abrir un cierre, consultar las mesas y canchas ocupadas y buscar productos.

El panel real es privado. Consulta los últimos 30 días de ventas y cobros, los últimos 30 cierres, los saldos pendientes, el inventario activo y la ocupación. En **Caja → Fondo para compras**, Humberto puede registrar cuánto efectivo entregó a la cajera. El aporte queda pendiente hasta que el computador lo incorpora al turno indicado. Muestra la hora de la última sincronización y avisa si los datos llevan más de tres minutos sin actualizarse. Sigue los [pasos de instalación del panel remoto](docs/panel-admin.md) para conectarlo al proyecto Supabase del club y publicar su enlace HTTPS.

## Arquitectura

| Componente | Tecnología | Responsabilidad |
| --- | --- | --- |
| Interfaz de caja | React, Vite y TypeScript | Abrir cuentas, registrar pedidos y operar el cierre desde el navegador del computador. |
| Aplicación local | Node.js y TypeScript | Servir la interfaz, validar operaciones y guardar los movimientos. |
| Datos locales | SQLite | Mantener cuentas abiertas, inventario, cobros y cierres aunque no haya internet. |
| Panel del administrador | React y Supabase | Consultar datos sincronizados y registrar aportes para compras desde el celular. Supabase aloja la copia y gestiona el acceso del administrador. |

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
