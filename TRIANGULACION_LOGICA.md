# 🔺 Lógica de Triangulación - Explicación Detallada

## ¿Qué es "Triangulación"?

En tu caso, significa **usar 3 fuentes de datos juntas** para identificar correctamente un código postal:

1. **Polígonos** (Shapefile) - Delimitan zonas geográficas
2. **Base de Datos 472** - Códigos postales asociados a cada polígono
3. **Dirección del Usuario** - Ubicación exacta a geolocalizar

---

## Flujo Completo de Triangulación

```
┌─────────────────────────────────────────────────────────┐
│ USUARIO SUBE ARCHIVO EXCEL                              │
│ (Calle 59C 2C-76, Cali, DANE: 76001, Depto: Valle)     │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
        ┌─────────────────────┐
        │ ESTRATEGIA 1        │
        │ BUSCAR MUNICIPIO    │
        │ POR NOMBRE          │
        └────────┬────────────┘
                 │
        ① Normalizar nombre:
           "Cali" → sin acentos → "cali" → minúsculas
        
        ② Buscar en base de datos:
           SELECT * FROM zones WHERE nombre_municipio = "CALI"
        
        ③ Resultado:
           ✅ Encontradas 12 zonas para Cali
           (Ahora sé qué polígonos buscar)
                 │
                 ▼
        ┌─────────────────────────────────┐
        │ ESTRATEGIA 2 (BACKUP)           │
        │ SI FALLA NOMBRE, USAR DANE      │
        └────────┬────────────────────────┘
                 │
        Si no encontró por nombre:
        ① Buscar por DANE code:
           SELECT * FROM zones WHERE codigo_municipio = "76001"
        
        ② Resultado:
           ✅ Encontradas 12 zonas con ese DANE
                 │
                 ▼
        ┌──────────────────────────────┐
        │ ESTRATEGIA 3 (PRINCIPAL)     │
        │ GEOCODIFICAR Y MATCHEAR      │
        └────────┬─────────────────────┘
                 │
        ① Geocodificar dirección:
           "Calle 59C 2C-76, Cali" 
           →
           GOOGLE GEMINI (o NOMINATIM si falla)
           →
           Coordenadas: Lat: 3.4372, Lon: -76.5197
        
        ② Verificar punto en polígono:
           FOR EACH zona IN zones_encontradas:
               IF punto (3.4372, -76.5197) INSIDE polígono:
                   → ENCONTRADO!
                   → Código postal: 760212
        
        ③ Resultado:
           ✅ Código postal asignado: 760212
                 │
                 ▼
        ┌──────────────────────────────┐
        │ GUARDAR EN CACHE             │
        │ (Para siguiente búsqueda)    │
        └────────┬─────────────────────┘
                 │
                 ▼
        ┌──────────────────────────────┐
        │ RETORNAR RESULTADO           │
        │ {                            │
        │   postalCode: "760212",      │
        │   coords: "3.4372, -76.5197" │
        │ }                            │
        └──────────────────────────────┘
```

---

## Ejemplo Paso a Paso

### ENTRADA
```json
{
  "address": "Calle 59C 2C-76",
  "city": "Cali",
  "department": "Valle del Cauca",
  "dane": "76001"
}
```

### PASO 1: Estrategia 1 - Buscar por Nombre

```typescript
// Normalizar nombre
const normCity = "cali"  // Quitamos mayúsculas, acentos

// Buscar en base de datos
const candidates = zones.filter(z => 
  normalizeStr(z.nombre_municipio) === "cali"
)

// Resultado
console.log(candidates.length)  // 12 zonas encontradas

// Almacenadas en memoria para siguiente paso
const zonesToCheck = candidates  // 12 zonas
```

**Estado**: ✅ Encontramos el municipio

---

### PASO 2: Estrategia 3 - Geocodificar

```typescript
// Intentar Google Gemini primero
const response = await ai.models.generateContent({
  contents: `Find coordinates for: "Calle 59C 2C-76, Cali, Colombia"`
})

// Response (si falla, fallback a Nominatim)
const location = {
  lat: 3.4372,
  lon: -76.5197
}

console.log("Geocoded to:", location)
```

**Estado**: ✅ Geocodificación exitosa

---

### PASO 3: Matchear con Polígonos

```typescript
// Tenemos:
// - zonesToCheck: [zona1, zona2, ..., zona12]  (de Cali)
// - location: {lat: 3.4372, lon: -76.5197}

// Algoritmo: Point in Polygon (PiP)
// Para cada zona, verifica si el punto está dentro

for (let zone of zonesToCheck) {
  const isInside = pointInPolygon(
    [location.lon, location.lat],  // [lon, lat]
    zone.geometry
  )
  
  if (isInside) {
    // ¡ENCONTRADO!
    console.log("Postal code:", zone.codigo_postal)  // 760212
    return {
      postalCode: "760212",
      coords: "3.4372, -76.5197"
    }
  }
}

// Si llegamos aquí, el punto está FUERA de todos los polígonos
return {
  postalCode: "FUERA_DE_POLIGONO",
  coords: "3.4372, -76.5197"
}
```

**Estado**: ✅ Punto matcheado a zona postal

---

## Posibles Resultados

### ✅ ÉXITO: Código Postal Encontrado

```
Input: Calle 59C 2C-76, Cali
Result: 760212
Reason: Punto dentro de polígono de Cali
```

### ⚠️ FUERA DE POLÍGONO

```
Input: Calle 100, Cali (dirección fuera de área)
Result: FUERA_DE_POLIGONO
Reason: Coordenadas fuera de todos los polígonos de Cali
```

### ❌ MUNICIPIO SIN ZONAS

```
Input: Calle 1, MUNICIPIO_FANTASMA
Result: MUNICIPIO_SIN_ZONAS
Reason: No hay datos de ese municipio en la BD
```

### ❌ DIRECCIÓN NO ENCONTRADA

```
Input: "csldfj aslfdj, random"
Result: DIR_NO_ENCONTRADA
Reason: Geocodificación falló (dirección no existe)
```

### ❌ DATOS INCOMPLETOS

```
Input: (sin dirección, solo city: "Cali")
Result: DATOS_INCOMPLETOS
Reason: Falta la dirección para geocodificar
```

---

## Visualización Gráfica

```
                    ┌─────────────────────────┐
                    │   ZONA POSTAL 760212    │
                    │   (Polígono)            │
                    │                         │
                    │      ╔═════════╗        │
                    │      ║         ║        │
                    │      ║ Punto   ║ ✅     │ DENTRO
                    │      ║ 3.4372  ║        │
                    │      ║-76.5197 ║        │
                    │      ╚═════════╝        │
                    │                         │
                    └─────────────────────────┘
                    
                    RESULTADO: Código postal: 760212
```

---

## Cómo Funciona el Cache

```
┌──────────────────────┐
│ BÚSQUEDA 1           │
│ "Calle 59C, Cali"    │
└────────┬─────────────┘
         │
         ├─→ Geocodificar
         ├─→ Matchear
         ├─→ RESULTADO: 760212
         │
         └─→ GUARDAR EN CACHE
             Key: "calle 59c 2c-76 cali"
             Value: {lat: 3.4372, lon: -76.5197}

┌──────────────────────┐
│ BÚSQUEDA 2           │
│ "Calle 59C, Cali"    │ (MISMA DIRECCIÓN)
└────────┬─────────────┘
         │
         ├─→ Verificar CACHE
         ├─→ ✅ ENCONTRADO EN CACHE!
         │
         └─→ Retornar inmediatamente
             (SIN hacer nueva geocodificación)
             TIEMPO: <100ms
```

---

## Rate Limiting

El sistema realiza las operaciones con pauses para no sobrecargar APIs:

```
Fila 1: Geocodificar + Matchear → ESPERAR 500ms
Fila 2: Geocodificar + Matchear → ESPERAR 500ms
Fila 3: Geocodificar + Matchear → ESPERAR 500ms
...
```

**Por qué**: 
- Evitar límites de cuota de APIs
- Respetar términos de servicio
- Permitir que el servidor procese

---

## Flujo de Error Handling

```
┌─────────────────────────┐
│ Intentar Geocodificar   │
└────────┬────────────────┘
         │
         ├─→ ① Google Gemini API
         │   ├─→ ✅ Exitoso
         │   │   └─→ Usar coordenadas
         │   │
         │   └─→ ❌ Fallo
         │       └─→ Ir a ②
         │
         ├─→ ② Nominatim (OpenStreetMap)
         │   ├─→ ✅ Exitoso
         │   │   └─→ Usar coordenadas
         │   │
         │   └─→ ❌ Fallo
         │       └─→ Ir a ③
         │
         └─→ ③ Retornar NULL
             └─→ Marcar como: DIR_NO_ENCONTRADA
```

---

## Ejemplo Real Completo

### Archivo Excel:
```
| Dirección              | Ciudad   | DANE  | Departamento     |
|------------------------|----------|-------|-----------------|
| Calle 59C 2C-76        | Cali     | 76001 | Valle del Cauca |
| Carrera 5 # 15-50      | Bogotá   | 11001 | Cundinamarca    |
| Calle 72 # 11-50       | Medellín | 05001 | Antioquia       |
```

### Procesamiento:

**Fila 1:**
```
Input:  Calle 59C 2C-76, Cali
Paso 1: Normalizar → "cali"
Paso 2: Buscar municipio → 12 zonas encontradas
Paso 3: Geocodificar → 3.4372, -76.5197
Paso 4: Matchear → DENTRO del polígono
Output: 760212 ✅
```

**Fila 2:**
```
Input:  Carrera 5 # 15-50, Bogotá
Paso 1: Normalizar → "bogota"
Paso 2: Buscar municipio → 45 zonas encontradas
Paso 3: Geocodificar → 4.6971, -74.0747
Paso 4: Matchear → DENTRO del polígono
Output: 110111 ✅
```

**Fila 3:**
```
Input:  Calle 72 # 11-50, Medellín
Paso 1: Normalizar → "medellin"
Paso 2: Buscar municipio → 8 zonas encontradas
Paso 3: Geocodificar → 6.2518, -75.5636
Paso 4: Matchear → DENTRO del polígono
Output: 050012 ✅
```

### Resultado Final:
```
✅ Encontrados: 3
❌ Errores: 0
📊 Tasa de éxito: 100%
```

---

## Conclusión

La **triangulación** funciona combinando:

1. **Búsqueda Local** (Nombre + DANE) → Rápido, confiable
2. **Geocodificación** (Coordenadas) → Preciso
3. **Matching de Polígonos** (Point-in-Polygon) → Decisión final

Todo esto funciona **incluso sin Google Gemini API Key** gracias al fallback a Nominatim.

---

**El sistema está diseñado para ser robusto, rápido y preciso. 🎯**
