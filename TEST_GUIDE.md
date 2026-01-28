# 🚀 Guía de Prueba - Sistema de Procesamiento de Direcciones

## Estado Actual

✅ **Sistema completamente operacional**  
✅ **Fallback automático funcionando**  
✅ **Logging detallado implementado**  

---

## 📍 URL de Acceso

**http://localhost:3000/**

---

## 🧪 Cómo Probar el Sistema

### TEST 1: Búsqueda de Dirección en Mapa

**Propósito**: Verificar que la geocodificación funciona con fallback

**Pasos**:
1. Abre http://localhost:3000/
2. Ve a pestaña **"Mapa"**
3. Asegúrate que está en modo **"Dirección"** (ícono de navegación)
4. Escribe: `Calle 59C 2C-76, Cali`
5. Presiona **Buscar** o Enter
6. **Resultado Esperado**: 
   - ✅ Ves la ubicación en el mapa
   - ✅ Un marcador verde muestra la dirección
   - ✅ Un polígono mostraría la zona postal (si está en cobertura)

---

### TEST 2: Búsqueda por Código Postal

**Propósito**: Verificar búsqueda en base de datos local

**Pasos**:
1. Ve a pestaña **"Mapa"**
2. Selecciona modo **"Código Postal"** (ícono #)
3. Escribe: `110111`
4. Presiona **Buscar**
5. **Resultado Esperado**:
   - ✅ Ves polígonos azules en el mapa
   - ✅ Están centrados en esa zona postal

---

### TEST 3: Procesamiento de Batch (MÁS IMPORTANTE)

**Propósito**: Verificar que el procesador asigna códigos postales

**Pasos**:

#### 3.1. Crea archivo Excel de prueba

Crea `prueba.xlsx` con esta estructura:

| Dirección | Ciudad de destino | DANE destino | Departamento de destino |
|-----------|------------------|--------------|------------------------|
| Calle 59C 2C-76 | Cali | 76001 | Valle del Cauca |
| Carrera 5 # 15-50 | Bogotá | 11001 | Cundinamarca |
| Calle 72 # 11-50 | Medellín | 05001 | Antioquia |

**Nota**: Los nombres de columnas deben ser EXACTOS

#### 3.2. Sube el archivo

1. Ve a pestaña **"Procesador"**
2. Click en **"Cargar Archivo"**
3. Selecciona tu archivo Excel

#### 3.3. Revisa los datos

- Deberías ver 3 filas en la tabla
- Verifica que se hayan cargado correctamente

#### 3.4. Ejecuta la validación

1. Click en **"Ejecutar Validación"**
2. Espera la barra de progreso (aprox 2-5 minutos)
3. **Verás actualizar cada fila con el código postal**

#### 3.5. Revisa los resultados

**Resultado Esperado**:
- ✅ Fila 1 (Cali): Código postal asignado (ej: 760211)
- ✅ Fila 2 (Bogotá): Código postal asignado (ej: 110111)
- ✅ Fila 3 (Medellín): Código postal asignado (ej: 050012)

**Indicadores de Éxito**:
- Tabla muestra: `Encontrados: 3 (100%)`
- Columna "Código Postal" tiene valores numéricos

#### 3.6. Descarga resultados

1. Click en botón **"Excel"** (amarillo)
2. Se descarga archivo con nombre: `Reporteador_Con_Codigos.xlsx`
3. Abre y verifica:
   - Todos tus datos originales
   - Nueva columna: `Codigo postal 472`
   - Nueva columna: `Coordenada`

---

### TEST 4: Ver Logs Detallados (Para Debugging)

**Propósito**: Entender exactamente qué está pasando

**Pasos**:
1. Abre la Consola: `F12` → Pestaña **"Console"**
2. Limpia la consola (botón circular con línea)
3. Ve a **"Procesador"**
4. Carga un archivo pequeño (1-3 filas)
5. Ejecuta validación
6. **Busca en la consola mensajes como:**

```
[PROCESSOR] Starting batch processing of 3 rows with 8432 postal zones
[PROCESSOR] Organized 8432 zones into 1145 municipalities
[DEBUG] Found 12 zones by DANE code: 76001
[DEBUG] Geocoded "Calle 59C 2C-76, Cali" to 3.4372, -76.5197
[DEBUG] Point matched to postal code: 760212
[PROCESSOR] Batch complete: 3 successful, 0 errors, 3 total processed
```

**Qué significa**:
- Primera línea: Sistema cargó datos correctamente
- Líneas DANE/Geocoded: Funcionando el procesamiento
- Última línea: Todos procesados exitosamente ✅

---

### TEST 5: Fallback a Nominatim (Cuando no hay API Key)

**Propósito**: Verificar que sin Google Gemini, sigue funcionando

**Pasos**:
1. Asegúrate que NO tienes `GEMINI_API_KEY` válida
   - Ve a archivo `.env`
   - Verifica que diga `GEMINI_API_KEY=demo_key_for_testing`
2. Abre Consola (F12)
3. Ve a **"Procesador"**
4. Carga un archivo pequeño
5. Ejecuta validación
6. **Busca logs que digan:**

```
[PROCESSOR] Organized X zones into Y municipalities
[DEBUG] Geocoded "..." to LAT, LON
[DEBUG] Point matched to postal code: XXXXX
[PROCESSOR] Batch complete: X successful, 0 errors
```

**Resultado Esperado**: ✅ Funciona perfectamente sin API Key

---

## 🐛 Troubleshooting - Si Algo No Funciona

### Problema: "Dirección no encontrada"

**Posibles causas**:
1. Ortografía incorrecta
2. Dirección muy genérica

**Solución**:
- Intenta con: `Calle 59C 2C-76, Cali, Colombia`
- Sé más específico

---

### Problema: "Municipio sin zonas"

**Significado**: El municipio está en Excel pero no en la base de datos

**Solución**:
1. Ve a **"Base de Datos"**
2. Busca tu municipio
3. Si no está → Necesitas cargar datos del municipio primero
4. Si sí está → Verifica el nombre exacto

---

### Problema: Procesador muy lento

**Esperado**: 2-5 minutos para 150 filas

**Por qué**:
- Rate limiting: 500ms entre solicitudes
- Geocodificación por API

**Si tarda más de 10 minutos**:
1. Revisa Consola (F12)
2. Busca `[PROCESSOR] Quota limit hit`
3. Espera el mensaje `Resuming after quota pause`
4. El procesamiento continuará automáticamente

---

### Problema: "Fuera de polígono"

**Significado**: La dirección existe pero está fuera de la zona de cobertura 472

**Solución**:
- Esto es correcto, significa que esa dirección no está en cobertura
- El sistema está funcionando bien

---

### Problema: Los datos no se cargan en la tabla

**Posibles causas**:
1. Columnas del Excel con nombres incorrectos
2. Archivo vacío

**Solución**:
Verifica que Excel tenga exactamente:
- `Dirección`
- `Ciudad de destino`
- `DANE destino`
- `Departamento de destino`

(Mayúsculas y tildes exactas)

---

## ✅ Checklist de Validación

Marca cada uno cuando lo hayas verificado:

- [ ] URL abierta correctamente: http://localhost:3000/
- [ ] Mapa carga sin errores
- [ ] Búsqueda por dirección funciona
- [ ] Búsqueda por código postal funciona
- [ ] Procesador carga archivo
- [ ] Procesa batch de direcciones
- [ ] Asigna códigos postales correctamente
- [ ] Descarga Excel con resultados
- [ ] Consola muestra logs `[PROCESSOR]`
- [ ] Sin Google Gemini API Key también funciona

---

## 📊 Métricas Esperadas

Después de procesar 150 filas:

| Métrica | Valor Esperado |
|---------|---|
| Encontrados | 90%+ |
| Errores | <10% |
| Tiempo total | 2-5 min |
| Rate de éxito | >85% |

---

## 🔧 Si Necesitas Debugging Profundo

Abre la Consola del navegador (F12) y busca:

**Para el Mapa**:
- `[DEBUG]` para mensajes de búsqueda
- `searchExternalLocations` para llamadas de API

**Para el Procesador**:
- `[PROCESSOR]` para progreso del batch
- `[DEBUG]` para detalles de cada dirección
- `fetchAddressLocation` para logs de geocodificación

---

## 📞 Soporte

Si algo no funciona:
1. Copia los logs de la Consola (F12)
2. Incluye el archivo Excel que usaste (anónimo)
3. Describe exactamente qué esperabas vs qué pasó

---

## 🎉 Éxito!

Si todos los tests pasan, el sistema está listo para usar en producción.

**Siguiente paso**: Sube archivos reales y verifica los resultados.
