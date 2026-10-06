# Below Rendiciones

Aplicativo web para la gestión de proyectos y tablas maestras de Below.

## Primera versión

Incluye:

- Proyectos
- Clientes
- Productores
- Sub Productores
- Ejecutivos
- Conceptos de Eventos

Cada módulo permite crear, buscar, editar y eliminar registros.

## Relaciones

Un proyecto se relaciona con:

- 1 Cliente
- 1 Productor
- 0 o 1 Sub Productor
- 1 Ejecutivo
- 0 o varios Conceptos de Evento

Las relaciones están protegidas por claves foráneas PostgreSQL.

## Conceptos iniciales

- PRODUCCIÓN TÉCNICA
- ESTRUCTURAS Y MOBILIARIO
- CATERING
- IMPLEMENTACIONES
- DISEÑO Y PRODUCCIÓN

## Tecnología

- Node.js 20+
- Express
- PostgreSQL
- HTML/CSS/JavaScript

## Ejecutar localmente

1. Instalar dependencias:

```bash
npm install
```

2. Copiar `.env.example` a `.env` y configurar `DATABASE_URL`.

3. Crear tablas:

```bash
npm run db:init
```

4. Iniciar:

```bash
npm run dev
```

5. Abrir:

```
http://localhost:3000
```

## Estructura SQL

`sql/schema.sql` crea de forma no destructiva:

- clients
- producers
- subproducers
- executives
- event_concepts
- projects
- project_event_concepts

## Próxima etapa posible

La base está preparada para agregar:

- Rendiciones por proyecto
- Facturas y boletas
- Consulta y validación SUNAT
- Evidencias y documentos
- Aprobaciones
- Usuarios y roles
- Dashboard financiero
- Despliegue en DigitalOcean
