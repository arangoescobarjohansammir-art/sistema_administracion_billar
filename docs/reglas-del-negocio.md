# Reglas del negocio

## Operación

- Un cajero registra los movimientos en un solo computador. El administrador consulta las ventas y el estado del negocio desde su celular.
- La caja debe operar sin internet. El panel remoto muestra los datos sincronizados y la fecha de la última actualización.
- Los valores de esta especificación se expresan en pesos colombianos (COP).

## Billar

- Hay seis mesas. Cada mesa cobra $6.000 por hora de juego, equivalentes a $100 por minuto. Se guarda la hora de inicio y de fin para conservar el tiempo si se cierra la pantalla.
- Antes de liquidar, una mesa detenida puede reanudarse. Conserva su hora de inicio y el cobro excluye los intervalos en que estuvo detenida.
- La cuenta de la mesa reúne el tiempo y los productos que se le hayan anotado. Se puede cobrar a una sola persona o repartir con importes iguales o distintos. El cajero puede asignar consumos y porciones del tiempo a personas diferentes.
- Si los jugadores apuestan un producto, su valor y el tiempo pueden quedar a cargo de uno o varios perdedores, según el acuerdo de esa partida.
- Cada persona puede pagar su parte al momento, abonarla o dejarla pendiente a su nombre. La suma de las partes debe coincidir con el total de la mesa.

## Tejo y fichas

- Hay seis canchas de maxitejo y seis de tejo largo. Cada cancha lleva su propio grupo y contador de chicos. El historial conserva el grupo, la cancha, el número de chico y quién perdió.
- Se puede abrir un grupo con jugadores numerados sin crear cuentas. Se registran los chicos pendientes y luego la cantidad perdida por jugador. El nombre se pide para cargar la deuda. El sistema asigna los cargos a los chicos pendientes en que ese jugador participó. Un jugador que llega después no cambia el importe de chicos anteriores.

- El tejo se cobra por chico. Quien pierde paga $4.000 por participante. Cada participante, incluido quien pierde, tiene derecho a una ficha o a consumir hasta $4.000 en productos por cada chico.
- El jugador puede combinar productos en un mismo canje. Si los productos cuestan más de $4.000, el jugador cubre el excedente. Si cuestan menos y se cierra el canje, la diferencia se pierde.
- Una ficha ya entregada puede canjearse por hasta $4.000 en productos o aplicarse como $3.000 al pago de una cuenta. El canje por productos no da cambio ni deja saldo en la ficha.
- Se registran por separado el cargo al perdedor, la elección de cada jugador, las fichas entregadas y las fichas recibidas por canje o pago. Un mismo derecho de un chico se usa una sola vez.
- Un derecho puede quedar pendiente hasta registrar la entrega de la ficha o los productos. Para liberar la cancha hay que registrar cómo se usaron los derechos pendientes. El saldo de dinero puede seguir fiado en las cuentas por nombre.

## Cuentas por nombre y cobros

- Una venta puede cobrarse al momento o anotarse a nombre de la persona. Una cuenta puede conservar saldo de un día a otro y recibir nuevos cargos y abonos.
- Un mismo pago puede combinar efectivo, transferencia y fichas. Las transferencias van a una sola cuenta receptora.
- Se conserva el detalle de cargos y abonos. Los cobros se incluyen en el turno en que se reciben, incluso cuando pagan una deuda anterior. El cierre distingue lo vendido, lo cobrado por cada medio y lo que queda pendiente.

## Catálogo e inventario

- El catálogo permite agregar, editar y desactivar productos con nombre, marca, presentación, precio y foto. El cajero ve las fotos sin internet. Desactivar un producto o cambiar su precio conserva el historial anterior.
- La cerveza se compra por canastas y se vende por unidad. El factor de conversión se configura por producto. Las medias y botellas de aguardiente vienen de fábrica y tienen existencias independientes.
- Se registra una salida cuando se entrega un producto, tanto si se paga de inmediato como si se fía o se entrega por canje. Cobrar la deuda después no genera otra salida.
- Se registran entradas por compras y ajustes con motivo. Cuando aplique, una entrada se puede vincular al retiro que pagó la mercancía.

## Caja y cierre

- La caja de ventas abre con una base de efectivo. Aumenta con cobros y otras entradas registradas y disminuye con gastos y retiros del mismo fondo.
- Para registrar ventas, pagos y canjes se requiere un turno abierto. Los registros hechos en versiones anteriores conservan su historial y sus saldos. El primer turno empieza a acumular movimientos desde su apertura.
- El fondo para compras se lleva aparte. Se entrega al cajero cuando hay una entrega programada y se conoce el importe. Se registran su entrega y sus pagos. Si queda efectivo, se devuelve al administrador.
- Una compra imprevista puede pagarse con un retiro de la caja de ventas. Se registra el importe, la categoría y la explicación. Los movimientos entre fondos se registran como traslados internos.
- Antes de entregar dinero, el cajero cuenta ambos fondos. El cierre compara lo esperado con lo contado y conserva la diferencia. El efectivo de ventas disponible se entrega al administrador y se deja registrada la base para el día siguiente.
- Si hay diferencias entre el conteo y lo esperado, entre lo transferido y lo verificado, o entre la base dejada y la contada al abrir, el cajero debe registrar la explicación.
- Las transferencias se comparan con los abonos recibidos. Las fichas y el fiado se reportan aparte del efectivo. El efectivo que se entrega al administrador se registra por separado de los gastos.
- El cajero cuenta las fichas físicas al abrir y al cerrar. El sistema espera las fichas iniciales más las recibidas por canje y en pagos, menos las entregadas por chicos de tejo. Los consumos hechos directamente con el derecho de un chico no implican un movimiento de ficha física.
- Si las fichas contadas al cerrar no coinciden con las esperadas, se registra la diferencia y su motivo. El cierre conserva el conteo físico para compararlo con la apertura del siguiente turno.
- Los movimientos registran fecha y usuario. Las anulaciones, devoluciones y ajustes requieren motivo y conservan el historial.

## Casos de aceptación

| Caso | Resultado esperado |
| --- | --- |
| Se juega billar durante 1 hora y 20 minutos. Se consumen tres cervezas de $4.000. | El tiempo cuesta $8.000 y el total es $20.000. Si se divide el tiempo por igual y una persona pidió dos cervezas y la otra una, quedan $12.000 y $8.000. Cada parte se puede cobrar o dejar fiada. |
| Dos personas juegan tres chicos de tejo y la misma persona pierde los tres. Nadie consume. | El perdedor debe $24.000. Se entregan tres fichas a cada persona. Si el perdedor entrega sus tres fichas al pagar, se abonan $9.000 y quedan $15.000 por cobrar. |
| Una persona usa el derecho de un chico en un producto de $6.000. Otra lo usa en productos de $3.000 y termina el canje. | La primera debe $2.000 adicionales. La segunda no recibe cambio ni conserva $1.000 de saldo. Se registran las salidas de los productos entregados. |
| Una cuenta de $20.000 se paga con una ficha, $7.000 en efectivo y $10.000 por transferencia. | La cuenta queda en cero. El cierre registra $7.000 en efectivo, $10.000 en transferencias y una ficha recibida por $3.000. |
| Un cliente consume $16.000, abona $6.000 en efectivo y paga $10.000 al día siguiente. | El primer día quedan $10.000 pendientes y entran $6.000. El segundo día entran $10.000 y se salda la deuda sin descontar inventario de nuevo. |
| Se registran dos canastas de 30 cervezas. Se entregan una cerveza fiada y otra por canje. | Entran 60 unidades y salen dos, con el motivo de cada salida. Si no había existencias previas ni otros movimientos, quedan 58 unidades. |
| Se abre con $100.000 de base, se cobran $250.000 en efectivo y se gastan $70.000 en una compra imprevista. | Se esperan $280.000 en el cajón antes de cerrar. Si coincide el conteo y se dejan $100.000 de base, se entregan $180.000 al administrador. El cierre conserva el cobro y el retiro con su motivo. |
| Se entregan $200.000 al fondo para compras y se usan $80.000 de ese fondo. | Quedan $120.000 para devolver al administrador. La caja de ventas no cambia. |
| Se abre con 100 fichas, se entregan seis, se reciben tres por canje y tres en pagos. Al cierre se cuentan 98. | Se esperan 100 fichas. El cierre conserva un faltante de dos con su explicación y el siguiente turno compara su conteo con las 98 fichas físicas del cierre. |
| Se pierde internet, se confirma un cobro y después se restablece la conexión. | El cobro queda guardado en el computador. Aparece una sola vez en el panel al sincronizar, incluso si el envío necesita reintentos. |

## Detalles por confirmar al implementar

- Confirmar la regla de redondeo que usa la versión actual de billar. Se cobra por segundos completos y se redondea el importe al peso más cercano. Si al repartir por igual queda algún peso de una línea, se asigna en el orden en que aparecen las personas.
- Quién puede autorizar anulaciones o ajustes y qué comprobante de transferencia se registrará, si se necesita alguno.
