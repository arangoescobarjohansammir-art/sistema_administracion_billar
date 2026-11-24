# Caja para tejo y billar

Proyecto de portafolio para administrar un establecimiento con seis mesas de billar, tejo y venta de productos. Un cajero registra las operaciones en el computador del negocio. El administrador tendrá un panel de consulta desde el celular.

## Estado

La aplicación local permite administrar el inventario, registrar ventas de productos y manejar cuentas por nombre. El cajero puede cobrar de inmediato, dejar un saldo fiado o registrar un abono con efectivo, transferencia y fichas.

## Ejecutar en el computador

Con [Node.js](https://nodejs.org/) 22.12 o posterior, abre la terminal de VS Code en la carpeta del proyecto y ejecuta:

```sh
npm ci
npm run build
npm start
```

Abre <http://127.0.0.1:4173>. La instalación inicial de dependencias requiere internet. Una vez compilada, la aplicación usa archivos y datos locales y se inicia con `npm start`.

Para probar el inventario, crea una cerveza con un empaque «Canasta» de 30 unidades. Registra una entrada de 2 canastas: las existencias deben subir a 60. Registra después una salida manual de 1 unidad con su motivo: deben quedar 59.

Para probar el fiado, crea una cuenta en **Ventas y cuentas → Cuentas por nombre**. Luego abre **Registrar venta**, agrega cuatro cervezas de $4.000 y registra $6.000 en efectivo. Deben quedar $10.000 pendientes y salir cuatro unidades. Registra después un abono de $7.000 en efectivo y una ficha. El saldo queda en cero sin otra salida de inventario.

Ejecuta `npm test` para compilar y comprobar el inventario, el fiado, los pagos mixtos y la recuperación de los datos al reiniciar. Las pruebas usan bases temporales.

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
5. Incorporar el cronómetro y los repartos de billar, y los chicos y canjes de tejo.
6. Implementar apertura, movimientos, cuadre y cierre de los fondos de caja.
7. Sincronizar con Supabase, crear el panel del administrador y preparar una demostración con datos ficticios.

El repositorio de portafolio usará datos ficticios. La base de datos del negocio, fotos cargadas por el cajero, credenciales, respaldos y archivos de exportación se guardarán fuera del código versionado.
