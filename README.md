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
- Presupuesto y liquidación (ADMIN / COORDINADOR)

## Controles adicionales (v1.11)

- **Perfiles del sistema** (ADMIN, COORDINADOR, PRODUCTOR, SUB PRODUCTOR, EJECUTIVO): no se pueden renombrar
  ni eliminar, porque los permisos dependen de esos nombres. El formulario de administrador inicial solo aparece
  mientras no exista ningún usuario con contraseña.
- **Separación de funciones**: quien solicita un anticipo no puede aprobarlo, desembolsarlo, registrar
  devoluciones o reembolsos, vincular rendiciones, liquidarlo ni adjuntarle constancias. Si un ADMIN o
  COORDINADOR solicita un anticipo, otro ADMIN o COORDINADOR debe gestionarlo.
- **Comprobantes duplicados**: `F001-00000077` y `f001-77` se reconocen como el mismo comprobante. Si la base ya
  tiene duplicados de este tipo, no se crea el índice único y el log del arranque lista las rendiciones a revisar
  (`[duplicados] …`); el registro de nuevos duplicados se bloquea igual desde la app.
- **Fechas**: la emisión del comprobante no puede ser futura y la fecha de rendición del anticipo no puede ser
  anterior a la de abono.
- Un productor solo puede asignar sus anticipos a proyectos donde figura como productor o subproductor,
  también al editarlos.
- Al eliminar una rendición en borrador, o al reemplazar su archivo, se elimina el archivo que ya no se usa.

### Relaciones entre tablas
- **Una persona con dos perfiles** (mismo DNI, por ejemplo COORDINADOR y PRODUCTOR) es la misma persona para
  las aprobaciones: no puede aprobar ni gestionar con un perfil lo que solicitó o rindió con el otro.
- **Responsable de la rendición**: debe ser el productor o el subproductor del proyecto, también cuando la
  registra un ADMIN o COORDINADOR. Así siempre se puede vincular al anticipo correspondiente.
- **Proyectos**: el productor debe tener perfil PRODUCTOR; el subproductor, SUB PRODUCTOR (y ser otra persona);
  el ejecutivo, EJECUTIVO. No se asigna a nadie INACTIVO. El código de proyecto se guarda en mayúsculas y no se
  repite aunque cambie la mayúscula.
- **Número de comprobante**: de 1 a 8 dígitos (formato SUNAT); se guarda con 8 (`45` → `00000045`).
- **Personas con registros**: no se pueden eliminar; se cambian a INACTIVO. Antes, eliminar al solicitante dejaba
  el anticipo sin dueño.
- **Anticipos antiguos sin solicitante**: la migración solo los asigna si el nombre coincide con una única persona;
  con homónimos quedan sin asignar para revisión manual.
- Al borrar un cliente, concepto, proyecto o persona en uso se muestra un mensaje claro (antes: error interno).

## Lector de comprobantes (v1.10)

Al adjuntar un comprobante, la app propone los datos en este orden:

1. **Código QR de SUNAT.** Las facturas y boletas electrónicas traen un QR con RUC, tipo, serie,
   número, IGV, total y fecha. Si se lee, esos datos son exactos y no se usa OCR (respuesta en menos
   de un segundo). Se reconoce aunque la foto esté borrosa, girada u oscura, y se ignoran otros QR
   como los de pago Yape/Plin.
2. **Texto del PDF**, cuando el PDF es digital.
3. **OCR** de la foto o de las páginas del PDF escaneado. La foto se endereza según su orientación
   EXIF; si se lee poco, se reintenta sin procesar y girada 90°, 270° y 180°.

Reglas al interpretar el texto:
- El RUC debe tener un dígito verificador válido: un RUC mal leído no se propone. Se descartan el RUC
  del bloque de cliente y los de `COMPANY_RUCS` / `SUNAT_QUERY_RUC`.
- `1,250` es mil doscientos cincuenta; también se aceptan `1,250.80` y `1.250,80`.
- Se prefiere la fecha de emisión (no la de vencimiento) y se rechazan fechas imposibles.
  Se aceptan `15/10/2026`, `15/10/26`, `2026-10-15` y `15 de octubre de 2026`.
- La serie electrónica sigue el formato de SUNAT (F, B o E + 3 caracteres); la de comprobantes físicos
  son 4 dígitos. Se corrigen confusiones típicas de OCR (`FOO1` → `F001`).
- El total ignora SUBTOTAL, IGV, TOTAL DE ÍTEMS, VUELTO y similares.
- Se avisa si el documento es una nota de crédito/débito, si el total parece estar en dólares o si la
  imagen es poco legible.

Los datos leídos son una propuesta: el productor debe revisarlos antes de guardar, y SUNAT los valida
al guardar. `OCR_WORKERS` (1 por defecto) define cuántas lecturas OCR corren en paralelo; cada una
usa ~150 MB de RAM. Las fechas de "hoy" de la app siguen el calendario de Lima.

## Seguridad y operación (v1.9)

### Accesos
- El PDF de un anticipo (con datos bancarios) solo lo abren el solicitante, ADMIN y COORDINADOR.
  Los productores ven únicamente anticipos donde figuran como solicitante (ya no se compara por nombre):
  los anticipos antiguos sin solicitante asignado deben asignarse desde **Editar**.
- Los productores solo reciben su propio registro de **Personal**.
- Si un mismo DNI tiene varios perfiles, el login pide elegir con cuál ingresar.
- Tras 8 intentos fallidos para un DNI (o 40 desde una misma red) el login se bloquea 15 minutos.
- Las contraseñas nuevas requieren 8 caracteres con letras y números. Las actuales siguen funcionando
  hasta que se cambien. Cambiar contraseña, perfil o desactivar a una persona cierra sus otras sesiones.
- No se puede eliminar el propio usuario ni dejar el sistema sin un ADMIN activo.
- Las sesiones vencidas se eliminan automáticamente.

### Servidor
- Cabeceras de seguridad (CSP, HSTS en producción, `nosniff`, sin `X-Powered-By`) y bloqueo de
  operaciones enviadas desde otros sitios. Para aceptar otro dominio propio usa `ALLOWED_ORIGINS`.
- Los comprobantes y constancias se validan por su contenido real (no por la extensión).
- Los errores internos no muestran detalles al usuario: devuelven una referencia que aparece en el log.
- SUNAT tiene un límite de 15 s (`SUNAT_TIMEOUT_MS`); si no responde, la rendición queda en ERROR y se
  puede volver a validar.
- El OCR usa el modelo en español incluido en la app (no descarga nada al arrancar) y se reinicia solo si falla.
- Las importaciones aceptan **.xlsx y .csv** (con coma o punto y coma). El formato **.xls** antiguo ya no es
  compatible: guardar como .xlsx.

### Base de datos
- Las migraciones se registran en `schema_migrations` con su huella SHA-256: un reinicio normal no vuelve a
  ejecutar los SQL, y varias instancias esperan su turno. Al modificar un archivo SQL se aplica automáticamente.
- Configura `DATABASE_CA_CERT` (o `DATABASE_CA_CERT_PATH`) con el certificado CA de DigitalOcean para verificar
  el servidor PostgreSQL. Sin él la conexión sigue cifrada, pero sin verificar, y se muestra un aviso en el log.

### Despliegue
- Node.js 22.13 o superior. La imagen Docker corre como usuario sin privilegios, no incluye `.env` ni `uploads/`,
  tiene `HEALTHCHECK` y se apaga ordenadamente (termina las solicitudes en curso) al recibir SIGTERM.
- `TRUST_PROXY=1` (valor por defecto) es el correcto detrás de DigitalOcean App Platform.
- CI ejecuta `npm audit --omit=dev --audit-level=high`.

## Celular y PWA (v1.8)

El frontend adapta los registros a tarjetas con datos principales y **Ver más datos**, navegación
inferior (Inicio, Rendiciones, Anticipos y Más), menú por permisos, filtros rápidos y accesos
**Registrar gasto** y **Solicitar anticipo**. Los formularios ocupan la pantalla del celular y
los importes usan teclado decimal. Presupuestos y liquidaciones también se adaptan a tarjetas.
Se mantienen las tablas completas en escritorio. Incluye estados de carga, reintento y actualización.

El manifiesto y los iconos permiten instalar la app en pantalla de inicio. **Instalar app** usa
la invitación del navegador cuando está disponible y ofrece instrucciones para Android/iPhone
en los demás casos. La instalación real depende del navegador; en iPhone se utiliza Safari y
Compartir → Añadir a pantalla de inicio. Los accesos del manifiesto abren rendiciones o anticipos
después de comprobar la sesión y sus permisos.

Desplegar bajo **HTTPS** (localhost sirve para desarrollo), con los archivos públicos en la raíz.
`/sw.js` y el HTML no deben recibir una caché HTTP inmutable en el proxy/CDN.
El service worker conserva solamente la interfaz pública y sus recursos. Excluye todas las rutas
`/api/`, PDFs, Excel, comprobantes, constancias y subidas; las respuestas API llevan `Cache-Control: no-store`.
No se guardan datos financieros ni contraseñas en IndexedDB/localStorage y no se encolan pagos.

Sin conexión se abre la interfaz ya instalada y aparece un aviso. Iniciar sesión, consultar datos,
leer comprobantes y guardar requieren conexión. No hay guardado de borradores sin conexión.
La actualización de versión se ofrece con un botón; no recarga automáticamente un formulario abierto.
En cada nueva versión se debe cambiar `CACHE` en `public/sw.js` y actualizar la lista de recursos
cuando se agreguen módulos. La activación elimina únicamente cachés antiguas de la interfaz de Below.
Los PNG del monograma se regeneran con `python tools/generate-pwa-icons.py`, sin dependencias adicionales.

Las pruebas PWA verifican manifiesto/iconos, recursos disponibles, interfaz sin red, exclusión
de datos privados y limpieza selectiva de caché. Las pruebas en navegador usan dimensiones móviles;
la instalación y la cámara deben comprobarse además en los dispositivos reales del equipo.
Referencia técnica: [MDN: uso de service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

## Presupuestos, constancias y liquidación (v1.7)

### Presupuesto por proyecto y concepto

ADMIN y COORDINADOR disponen de **Presupuesto y liquidación**. Cada concepto asignado al
proyecto admite un presupuesto en PEN. Vacío significa sin definir y cero significa S/ 0.00.
La pantalla compara presupuesto, gastos aprobados, gastos por aprobar y disponible; marca
los conceptos excedidos. La alerta no bloquea automáticamente la aprobación de un gasto.

Para guardar se requiere un motivo. El historial conserva importe anterior, nuevo importe,
responsable y fecha. Una versión del presupuesto evita que dos usuarios sobrescriban sus cambios:
si otra persona lo modificó, hay que recargar el proyecto antes de guardar.
No puede retirarse un concepto con presupuesto definido; primero se debe limpiar su presupuesto.
Los conceptos con rendiciones vinculadas conservan también las restricciones existentes.

### Constancias bancarias

Los nuevos desembolsos, devoluciones y reembolsos requieren **una constancia PDF, JPG, PNG o WEBP
de hasta 10 MB**, además de su referencia. Se verifica la firma del formato, se registra una
huella SHA-256 y se evita adjuntar dos veces el mismo archivo a un movimiento.
Esto valida el formato y la integridad del archivo, no la autenticidad del pago ante el banco.

En **Conciliar e historial** se pueden agregar constancias a movimientos anteriores, con motivo
registrado. Los respaldos se añaden sin sustituir ni borrar los anteriores y sin modificar el importe.
También pueden agregarse respaldos a un anticipo ya liquidado.
ADMIN y COORDINADOR realizan las cargas; el solicitante puede consultar las constancias de sus
propios anticipos. Las rutas de archivos requieren sesión y verifican el acceso al registro.

Las constancias usan el mismo almacenamiento configurado para comprobantes, en la carpeta
`constancias/`. Una falla al guardar la constancia revierte el movimiento y su cambio de estado.
Los nuevos cierres requieren constancias en todos los movimientos del anticipo. Los anticipos
históricos ya liquidados mantienen su estado; sus respaldos faltantes se señalan en el reporte.

### Liquidación consolidada

Desde el proyecto se descargan **PDF y Excel** con fecha de corte en Lima. Las consultas se
ejecutan sobre una misma instantánea de PostgreSQL para que los importes del reporte sean consistentes.
Incluye presupuesto por concepto, anticipos solicitados/autorizados, desembolsos,
rendiciones con aprobación y SUNAT, devoluciones, reembolsos, saldos individuales, referencias
a constancias y cambios de presupuesto. Excel incorpora siete hojas y conserva referencias
completas; PDF abrevia textos extensos y repite encabezados al paginar.

Los aprobados sin vincular se presentan por separado. El saldo neto no compensa ni cierra saldos
individuales: se muestran por separado lo pendiente por sustentar/devolver y los reembolsos pendientes.
El estado **CONCILIADO** requiere anticipos liquidados, rendiciones aprobadas y vinculadas, y
constancias en todos los movimientos. **EN PROCESO** señala pendientes, y **SIN MOVIMIENTOS**
indica que todavía no hay anticipos ni rendiciones. El reporte no constituye un cierre irreversible
del proyecto ni un documento bancario y no incorpora los archivos binarios dentro del PDF/Excel;
las constancias se consultan desde sus identificadores en la aplicación.

Todos los importes presupuestarios y de conciliación se expresan en **PEN**. El campo USD del
proyecto no convierte automáticamente los gastos o el presupuesto.

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
Las pruebas (incluidas las de acceso y login de `test/server.test.js`) usan PostgreSQL integrado (PGlite) con datos ficticios y no necesitan
credenciales ni acceso a la base de producción.

`npm run db:init` y el arranque normal aplican `sql/schema.sql`, después
`sql/workflow.sql` y `sql/finance.sql`, todos repetibles. Los registros anteriores conservan sus datos;
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
