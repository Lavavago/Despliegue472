<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# ColPostal 472 Visualizador - Gestor de Zonas Postales

Sistema web para visualizar, gestionar y buscar zonas postales de cobertura en Colombia (Código 472).

## Características

- **Visualización de Mapa**: Mapa interactivo con Leaflet.js
- **Búsqueda por Dirección**: Encuentra direcciones exactas y su zona postal correspondiente
- **Búsqueda por Código Postal**: Localiza zonas específicas por código postal
- **Búsqueda por Municipio**: Visualiza todas las zonas de un municipio
- **Búsqueda por Departamento**: Visualiza todas las zonas de un departamento
- **Base de Datos**: Gestiona y visualiza la base de datos de zonas postales
- **Procesamiento de Archivos**: Soporta archivos Excel para importación masiva

## Requisitos Previos

- Node.js 16+
- npm o yarn

## Instalación

1. Clona o descarga el proyecto
2. Navega a la carpeta del proyecto
3. Instala dependencias:
   ```bash
   npm install
   ```

## Configuración

### Opción 1: Con Google Gemini API (Recomendado)

Para búsquedas más precisas usando Google Maps y Google Search:

1. Obtén tu API Key de Google Gemini en: https://aistudio.google.com/app/apikeys
2. Crea un archivo `.env` en la raíz del proyecto:
   ```
   GEMINI_API_KEY=tu_clave_api_aqui
   ```
3. El sistema usará Google Gemini para geocodificación precisa

### Opción 2: Sin API Key (Fallback automático)

Si no tienes API Key de Google Gemini:
- El sistema automáticamente usa **Nominatim (OpenStreetMap)** para geocodificación
- **No requiere configuración adicional**
- Funciona sin límite de cuotas
- Precisión muy buena para direcciones en Colombia

## Uso

### Ejecutar en Desarrollo

```bash
npm run dev
```

La aplicación estará disponible en: **http://localhost:3000/**

### Compilar para Producción

```bash
npm run build
```

### Vista Previa de Producción

```bash
npm run preview
```

## Cómo Usar la Aplicación

### 1. Búsqueda por Dirección

1. Ve a la pestaña **"Mapa"**
2. Selecciona el modo **"Dirección"** (icono de navegación)
3. Escribe la dirección (ej: "Calle 59C 2C-76, Cali")
4. Presiona **Buscar** o Enter
5. El mapa mostrará:
   - La ubicación exacta con un marcador
   - La zona postal que la cubre (si existe en la base de datos)
   - Información de la zona

### 2. Búsqueda por Código Postal

1. Selecciona el modo **"Código Postal"** (icono de hash)
2. Escribe el código postal (ej: "110111")
3. Presiona **Buscar**
4. Se mostrarán todos los polígonos para ese código postal

### 3. Búsqueda por Municipio

1. Selecciona el modo **"Municipio"** (icono de edificio)
2. Escribe el nombre exacto del municipio (ej: "Cali")
3. Presiona **Buscar**
4. Se mostrarán todas las zonas del municipio

### 4. Búsqueda por Departamento

1. Selecciona el modo **"Departamento"** (icono de globo)
2. Escribe el nombre exacto del departamento (ej: "Valle del Cauca")
3. Presiona **Buscar**
4. Se mostrarán todas las zonas del departamento

### 5. Gestionar Base de Datos

1. Ve a la pestaña **"Base de Datos"**
2. Visualiza estadísticas y lista de zonas
3. Soporta búsqueda dentro de la tabla

### 6. Procesar Archivos

1. Ve a la pestaña **"Procesador"**
2. Carga un archivo Excel con direcciones
3. El sistema identifica las zonas postales automáticamente

## Estructura del Proyecto

```
.
├── components/
│   ├── DatabaseView.tsx      # Vista de base de datos
│   ├── MapView.tsx           # Visualizador de mapa interactivo
│   ├── Navbar.tsx            # Barra de navegación
│   └── ProcessorView.tsx     # Procesador de archivos
├── services/
│   └── postalService.ts      # Servicio de datos y geocodificación
├── App.tsx                   # Componente principal
├── index.tsx                 # Punto de entrada
├── types.ts                  # Definiciones TypeScript
├── vite.config.ts            # Configuración de Vite
├── tsconfig.json             # Configuración de TypeScript
├── package.json              # Dependencias
└── index.html                # HTML principal
```

## Stack Tecnológico

- **React 19**: Framework UI
- **TypeScript**: Tipado estático
- **Leaflet.js**: Mapas interactivos
- **Vite**: Build tool moderno
- **Tailwind CSS**: Estilos CSS
- **Google Gemini API**: Geocodificación avanzada (opcional)
- **OpenStreetMap Nominatim**: Geocodificación fallback gratuita
- **IndexedDB**: Almacenamiento local

## Mejoras Implementadas

✅ **Sistema de fallback automático**: Si Google Gemini falla o no está configurado, usa Nominatim (OpenStreetMap)  
✅ **Mensajes de feedback mejorados**: Muestra éxito y errores de búsqueda en la UI  
✅ **Caché de resultados**: Almacena búsquedas anteriores para respuestas rápidas  
✅ **Soporte sin API Key**: Funciona completamente sin necesidad de API Keys  
✅ **Validaciones mejoradas**: Mejor manejo de errores y casos edge  

## Solución de Problemas

### "Dirección no encontrada"

- **Verifica la ortografía** de la dirección
- **Sé más específico** - incluye ciudad (ej: "Calle 59 # 2C-76, Cali")
- **Usa nombres oficiales** para municipios y departamentos
- Revisa la **consola del navegador** (F12) para más detalles

### "Error de API"

- Verifica que tu **GEMINI_API_KEY** sea válida
- Comprueba tu **cuota de uso** en Google AI Studio
- El sistema **automáticamente respaldará** con Nominatim si hay problemas

### El mapa no carga

- Asegúrate de tener **conexión a Internet**
- Borra el **caché del navegador** (Ctrl+Shift+Del)
- Recarga la página (F5)

## API Keys (Opcional)

### Google Gemini API

Si deseas usar la geocodificación mejorada de Google:

1. Ve a: https://aistudio.google.com/app/apikeys
2. Crea una nueva API Key
3. Habilita las APIs: Gemini 2.5 Flash, Google Maps
4. Copia la clave en tu archivo `.env`

**Nota**: El sistema funciona perfectamente sin esta API Key usando el fallback de Nominatim.

## Licencia

Proyecto para gestión de zonas postales 472 en Colombia.

## Contacto

Para reportar bugs o sugerencias, consulta la documentación del proyecto.
