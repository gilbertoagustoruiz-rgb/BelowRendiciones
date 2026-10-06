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

La carga del PDF o foto funciona como evidencia y activa la validación. En esta versión, los datos tributarios del comprobante (RUC, serie, número, fecha e importe) se registran en el formulario y son los que se envían a SUNAT. La lectura OCR automática de fotos/PDF puede añadirse como siguiente capa sin modificar el modelo de rendiciones.
