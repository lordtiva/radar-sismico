# Radar Sísmico Argentina (INPRES + Cloudflare Workers)

Mapa interactivo en tiempo real de los sismos registrados en Argentina por el **INPRES**, construido con **TypeScript** sobre **Cloudflare Workers + D1 + Cron Triggers** y **MapLibre GL JS**.

## Características

- **Fuente oficial INPRES:** sincronización automática cada 5 minutos (`Cron Trigger`) desde `sismos.xml` y `sentidos.xml`, unificando eventos preliminares, revisados y sismos sentidos (con intensidad Mercalli y epicentro).
- **Historial persistente gratis:** almacenamiento en **Cloudflare D1** (SQLite serverless) más allá de la ventana de 30 eventos del XML.
- **Visualización sísmica:**
  - Tamaño exponencial por magnitud y color conmutable entre **profundidad** (`<70`, `70–300`, `>300 km`) y **estado INPRES**.
  - **Relieve 3D real** de la Cordillera de los Andes (`raster-dem` + `hillshade`).
  - **Perfil de Subducción sincronizado** (`Longitud vs. Profundidad`).
  - **Modo Replay + histograma** para reproducir enjambres sísmicos cronológicamente.

## Requisitos

- Node.js `>= 22.18`
- CLI oficial de Cloudflare (`npm install -g cf`)

## Desarrollo local

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## Despliegue en Cloudflare Workers

1. Autenticarse con Cloudflare:
   ```bash
   cf auth login
   ```
2. Crear la base D1 y aplicar el esquema (o dejar que `cf deploy` aprovisione automáticamente):
   ```bash
   cf d1 create --name sismos-argentina-db
   cf d1 migrations apply <DATABASE_ID>
   ```
3. Desplegar:
   ```bash
   cf deploy
   ```

## Fuentes de datos y atribución

- **Datos sísmicos:** obtenidos de las fuentes públicas del [Instituto Nacional de Prevención Sísmica (INPRES)](https://www.inpres.gob.ar/). Este proyecto es una visualización independiente no oficial y no sustituye los canales de alerta oficiales.
- **Mapas y relieve:** renderizado con **MapLibre GL JS**, mapas base de **CARTO** y elevación DEM de **AWS Terrain Tiles (Terrarium)**, sujetos a sus respectivos términos de uso.

## Licencia

El código fuente de este proyecto se distribuye bajo la licencia [MIT](LICENSE). La licencia aplica únicamente al código y no a los datos o servicios externos mencionados arriba.
