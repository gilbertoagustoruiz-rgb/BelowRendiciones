# Below Rendiciones

Aplicativo web para gestión de proyectos, conceptos de evento y rendición de gastos con comprobantes.

## Módulos

- Proyectos
- Rendiciones
- Clientes
- Productores
- Sub Productores
- Ejecutivos
- Conceptos de Eventos

## Conciliación, aprobación y pendientes (v1.6)

El panel **Pendientes y conciliación** muestra saldos por sustentar/devolver,
reembolsos pendientes, anticipos vencidos, rendiciones enviadas/observadas,
comprobantes pendientes de SUNAT y rendiciones aprobadas por vincular.
Incluye búsqueda y filtro de estado. Los vencimientos usan la fecha de Lima.

### Operación

1. El productor registra una rendición como **BORRADOR** y usa **Revisión e historial → Enviar a revisión**.
2. ADMIN o COORDINADOR puede **observar** indicando la corrección o **aprobar**.
   Una observación habilita la edición y el reenvío. Nadie revisa su propia rendición.
   SUNAT conserva su estado separado: aprobar con SUNAT no validado exige justificar la excepción.
3. El anticipo empieza **SOLICITADO**. Asigna un solicitante del personal antes de aprobar.
   ADMIN o COORDINADOR aprueba solicitudes de otra persona y confirma el desembolso
   con su referencia bancaria. La fecha de abono programada no prueba un pago.
4. En **Conciliar e historial**, vincula rendiciones aprobadas del mismo proyecto y solicitante.
   Cada comprobante se aplica completo a un solo anticipo; no se divide entre anticipos.
5. Registra devoluciones recibidas o reembolsos efectivamente pagados, con importe y referencia.
   Estas acciones registran pagos realizados fuera de la app; no ejecutan transferencias bancarias.
6. Liquida cuando el saldo sea cero. Un anticipo liquidado queda cerrado.

**Saldo = desembolso + reembolsos − devoluciones − rendiciones aprobadas vinculadas.**
Un saldo positivo está por sustentar/devolver; uno negativo representa un reembolso pendiente.
Los anticipos y las rendiciones actuales se registran y concilian en **PEN**, incluso si el
presupuesto del proyecto está en USD; esta versión no convierte monedas automáticamente.

Los productores y subproductores solo consultan sus propios registros. Solo ADMIN y
COORDINADOR registran movimientos y vinculaciones. Una referencia no puede repetirse para
el mismo tipo de movimiento en un anticipo. Las operaciones usan transacciones y bloqueos
para impedir desembolsos duplicados y modificaciones simultáneas de saldos.
El historial conserva actor, fecha, estado, referencia y observaciones.

Las rendiciones enviadas/aprobadas y anticipos aprobados/desembolsados/liquidados no pueden
editarse ni eliminarse mediante los formularios o la API. Se puede corregir una vinculación,
con motivo registrado, mientras el anticipo siga desembolsado y abierto.

### Actualización y verificación

Ejecutar `npm ci`, `npm run check` y `npm test` antes de desplegar.
Las pruebas usan PostgreSQL integrado (PGlite) con datos ficticios y no necesitan
credenciales ni acceso a la base de producción.

`npm run db:init` y el arranque normal aplican `sql/schema.sql` y después
`sql/workflow.sql`, ambos repetibles. Los registros anteriores conservan sus datos;
las rendiciones empiezan como BORRADOR y los anticipos como SOLICITADO. No se infieren
aprobaciones ni desembolsos históricos: deben revisarse y registrarse con su respaldo.
Las solicitudes antiguas sin un solicitante asociado deben corregirse antes de aprobar.

## Rendiciones y SUNAT

Cada rendición queda vinculada a:

- Proyecto
- Concepto asignado al proyecto
- Productor del proyecto
- Factura o Boleta
- Archivo original PDF/JPG/PNG/WEBP
- Datos del comprobante
- Resultado de validación SUNAT

Al guardar una rendición, el backend intenta validar automáticamente el comprobante mediante la API oficial de Consulta Integrada de Validez de Comprobante de Pago de SUNAT.

La respuesta se conserva en PostgreSQL para auditoría, junto con:

- estado del comprobante
- estado del RUC emisor
- condición domiciliaria
- observaciones
- fecha de validación

### Credenciales SUNAT

Se requieren credenciales generadas desde SUNAT Operaciones en Línea (SOL):

```env
SUNAT_CLIENT_ID=
SUNAT_CLIENT_SECRET=
SUNAT_QUERY_RUC=
```

Si no están configuradas, el comprobante se guarda como `PENDIENTE_CONFIGURACION` y puede volver a validarse luego.

## Archivos

Con DigitalOcean Spaces configurado, las evidencias se guardan en Spaces:

```env
SPACES_ENDPOINT=https://sfo3.digitaloceanspaces.com
SPACES_REGION=sfo3
SPACES_BUCKET=
SPACES_KEY=
SPACES_SECRET=
```

Sin Spaces, durante desarrollo se guardan en `uploads/`.

## Ejecutar

```bash
npm install
npm run db:init
npm run dev
```

Abrir `http://localhost:3000`.

## Importante

La carga del PDF o foto funciona como evidencia y activa la validación. El lector extrae texto de PDF y usa OCR para imágenes; los PDF escaneados requieren una imagen o entrada manual. Los datos detectados se revisan en el formulario y son los que se envían a SUNAT.
