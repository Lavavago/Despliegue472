import { PostalZone, AddressTemplate, PaginatedResult } from '../types';
import { GoogleGenAI } from "@google/genai";
import { createClient } from '@supabase/supabase-js';

/* 
  =============================================================================
  INDEXEDDB STORAGE
  =============================================================================
*/
const DB_NAME = 'ColPostalDB';
const DB_VERSION = 3; // Version bumped to 3 to invalidate old cache
const STORE_ZONES = 'zones';
const STORE_GEO_CACHE = 'geo_cache'; // New store for caching API responses

const normalizeStr = (str: string) => str ? str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";

const normalizeCityKey = (raw: string): string => {
    if (!raw) return "";
    let s = raw.toString();
    s = s.replace(/\(.*?\)/g, "");
    s = s.replace(/[\.,]/g, " ");
    s = s.replace(/\s+/g, " ");
    s = s.replace(/\bciudad\s+de\s+bogota\b/gi, "bogota");
    s = s.replace(/\bbogota\s*d\s*c\b/gi, "bogota dc");
    s = s.replace(/\bd\s*c\b/gi, "dc");
    return normalizeStr(s);
};

// In-memory cache for this session (faster than DB for repeated rows in same file)
const memCache: Record<string, { lat: number, lon: number } | null> = {};

// Initialize GenAI
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
);

// Helper to open DB
const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => reject("Error opening DB");
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_ZONES)) {
        db.createObjectStore(STORE_ZONES, { keyPath: 'id' });
      }
      // If upgrading to v3, delete old cache to ensure new logic runs
      if (db.objectStoreNames.contains(STORE_GEO_CACHE)) {
          db.deleteObjectStore(STORE_GEO_CACHE);
      }
      db.createObjectStore(STORE_GEO_CACHE, { keyPath: 'key' });
    };

    request.onsuccess = (event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };
  });
};

/* 
  =============================================================================
  CACHE HELPERS
  =============================================================================
*/

const getCachedLocation = async (key: string): Promise<{ lat: number, lon: number } | null | undefined> => {
    if (memCache[key] !== undefined) return memCache[key];
    
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_GEO_CACHE, 'readonly');
        const store = tx.objectStore(STORE_GEO_CACHE);
        const req = store.get(key);
        req.onsuccess = () => {
            const res = req.result;
            if (res) {
                memCache[key] = res.value; // Hydrate mem cache
                resolve(res.value);
            } else {
                resolve(undefined);
            }
        };
        req.onerror = () => resolve(undefined);
    });
};

const saveCachedLocation = async (key: string, value: { lat: number, lon: number } | null) => {
    memCache[key] = value;
    const db = await openDB();
    return new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_GEO_CACHE, 'readwrite');
        const store = tx.objectStore(STORE_GEO_CACHE);
        store.put({ key, value });
        tx.oncomplete = () => resolve();
    });
};

export const clearGeoCache = async (): Promise<void> => {
    Object.keys(memCache).forEach(k => delete memCache[k]);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_GEO_CACHE, 'readwrite');
        const store = tx.objectStore(STORE_GEO_CACHE);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
};

/* 
  =============================================================================
  JSON HELPERS
  =============================================================================
*/
const extractJSON = (text: string): any => {
    try {
        // First try standard parse
        return JSON.parse(text);
    } catch (e) {
        // Try finding the first '{' and last '}'
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first !== -1 && last !== -1) {
            try {
                return JSON.parse(text.substring(first, last + 1));
            } catch (e2) {
                return null;
            }
        }
        return null;
    }
};

/* 
  =============================================================================
  GEOMETRY LOGIC
  =============================================================================
*/

// Calculate Bounding Box [minLon, minLat, maxLon, maxLat]
const calculateBBox = (geometry: any): [number, number, number, number] => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    
    const updateBounds = (coords: any[]) => {
        for (const [lon, lat] of coords) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
    };

    if (geometry.type === 'Polygon') {
        updateBounds(geometry.coordinates[0]);
    } else if (geometry.type === 'MultiPolygon') {
        for (const polygon of geometry.coordinates) {
            updateBounds(polygon[0]);
        }
    }

    if (minLon === Infinity) return [0,0,0,0];
    return [minLon, minLat, maxLon, maxLat];
};

const pointInPolygon = (point: [number, number], vs: [number, number][]): boolean => {
    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i][0], yi = vs[i][1];
        const xj = vs[j][0], yj = vs[j][1];
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
};

const isPointInFeature = (lon: number, lat: number, zone: PostalZone): boolean => {
    if (zone.bbox) {
        const [minLon, minLat, maxLon, maxLat] = zone.bbox;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
            return false;
        }
    }

    const geometry = zone.geometry;
    if (!geometry || !geometry.coordinates) return false;
    
    const pt: [number, number] = [lon, lat];
    if (geometry.type === 'Polygon') return pointInPolygon(pt, geometry.coordinates[0]);
    else if (geometry.type === 'MultiPolygon') {
        for (const polygonCoords of geometry.coordinates) {
            if (pointInPolygon(pt, polygonCoords[0])) return true;
        }
    }
    return false;
};

const calculateCentroid = (geometry: any): { lat: number, lon: number } => {
    let coords: any[] = [];
    if (geometry.type === 'Polygon') coords = geometry.coordinates[0];
    else if (geometry.type === 'MultiPolygon') coords = geometry.coordinates[0][0];
    
    if (!coords || coords.length === 0) return { lat: 4.5709, lon: -74.2973 };

    let sumLon = 0, sumLat = 0;
    coords.forEach((p: any) => { sumLon += p[0]; sumLat += p[1]; });
    return { lat: sumLat / coords.length, lon: sumLon / coords.length };
};

/* 
  =============================================================================
  ADDRESS NORMALIZATION
  =============================================================================
*/

export const normalizeAddressForGeocoding = (rawAddress: string): string => {
    if (!rawAddress || !rawAddress.trim()) return "";
    let clean = rawAddress.trim();
    
    // Remove email-like patterns
    clean = clean.replace(/\b[\w\.-]+@[\w\.-]+\.\w{2,4}\b/gi, "");
    
    // Standardize separators
    clean = clean.replace(/\./g, " ");
    clean = clean.replace(/\(.*?\)/g, ""); // Remove content in parens
    
    // EXPAND COMMON ABBREVIATIONS
    clean = clean.replace(/\b(ac)\b/gi, "Avenida Calle");
    clean = clean.replace(/\b(ak)\b/gi, "Avenida Carrera");
    clean = clean.replace(/\b(cl|cll|c)\b/gi, "Calle");
    clean = clean.replace(/\b(cra|kr|kra|k)\b/gi, "Carrera");
    clean = clean.replace(/\b(dg|diag)\b/gi, "Diagonal");
    clean = clean.replace(/\b(tv|trans|tr)\b/gi, "Transversal");
    clean = clean.replace(/\b(av|avda)\b/gi, "Avenida");
    clean = clean.replace(/\b(cir|circ)\b/gi, "Circular");
    clean = clean.replace(/\b(autop|autopista)\b/gi, "Autopista");
    
    // Stop words removal (noise for geocoding points)
    const stopWords = [
        "ap", "apt", "apto", "apartamento", "int", "interior", "casa", "cs", "local", 
        "oficina", "of", "piso", "torre", "manzana", "mz", "bloque", "bl", 
        "barrio", "br", "urb", "urbanizacion", "conjunto", "etapa", "hotel", 
        "edificio", "agrupacion", "zona", "vereda", "km", "kilometro", "via",
        "centro comercial", "c.c", "cc", "mall", "plaza", "ph"
    ];
    // Note: 'tr' removed from stop words to avoid conflict with Transversal if normalization happens first
    
    const stopWordsRegex = new RegExp(`\\b(${stopWords.join('|')})\\b.*$`, 'gi');
    clean = clean.replace(stopWordsRegex, ""); 

    // NUMBER AND FORMAT STANDARDIZATION
    
    // 1. Standardize "No", "Numero", "#" to " # "
    clean = clean.replace(/\b(?:No|Num|Numero|Nro)\.?\s+/gi, " # ");
    clean = clean.replace(/\bNo\b/gi, " # ");
    clean = clean.replace(/#/g, " # "); // Ensure spaces around #

    // 2. Remove spaces around hyphens to compact "20 - 30" -> "20-30"
    clean = clean.replace(/\s*-\s*/g, "-");

    // 3. Heuristic: If # is missing, try to insert it between Street Number and House Plate
    // Look for: (StreetType) (StreetNum+Suffixes) (HouseNum...)
    if (!clean.includes('#')) {
         const streetTypes = "Calle|Carrera|Diagonal|Transversal|Avenida|Circular|Autopista|Avenida Calle|Avenida Carrera";
         // Regex explanation:
         // ^(Type) 
         // \s+ 
         // ([0-9]+[A-Z]?\s?(?:Bis)?\s?[A-Z]?\s?(?:Sur|Norte|Este|Oeste)?) -> Street Number with suffixes
         // \s+ 
         // ([0-9]+.*)$ -> House Plate starting with a number
         const pattern = new RegExp(`^(${streetTypes})\\s+([0-9]+[a-z]?\\s?(?:bis)?\\s?[a-z]?\\s?(?:sur|norte|este|oeste)?)\\s+([0-9]+.*)$`, 'i');
         clean = clean.replace(pattern, "$1 $2 # $3");
    }

    // 4. Format House Plate: "# 10 20" -> "# 10-20"
    // This handles "Calle 12 # 45 67" converting to "Calle 12 # 45-67"
    // Also handles cases where we just inserted the # in step 3.
    clean = clean.replace(/ #\s*([0-9]+[a-z]?)\s+([0-9]+[a-z]?)/gi, " # $1-$2");

    // 5. Cleanup double spaces
    clean = clean.replace(/\s\s+/g, ' ');
    
    return clean.trim();
};

const findAttributeValue = (props: any, candidateKeys: string[]): string => {
    if (!props) return '';
    const propKeys = Object.keys(props);
    
    for (const candidate of candidateKeys) {
        if (props[candidate] !== undefined && props[candidate] !== null) return String(props[candidate]).trim();
        const foundKey = propKeys.find(k => k.toLowerCase() === candidate.toLowerCase());
        if (foundKey && props[foundKey] !== undefined && props[foundKey] !== null) return String(props[foundKey]).trim();
    }
    return '';
};

// Helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/* 
  =============================================================================
  DB MANAGEMENT
  =============================================================================
*/

export const getAllPostalZones = async (): Promise<PostalZone[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZONES, 'readonly');
    const store = tx.objectStore(STORE_ZONES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

export const updateZonesFromMasterExcel = async (excelData: any[], onProgress?: (percent: number) => void): Promise<{updated: number, total: number}> => {
  const db = await openDB();
  const lookupMap = new Map<string, { muni: string, depto: string, muniCode: string }>();
  
  excelData.forEach(row => {
     const cp = findAttributeValue(row, ['codigo_postal', 'postal_code', 'cp', 'código postal', 'zona_postal']);
     if (cp) {
        const muni = findAttributeValue(row, ['municipio', 'nombre_municipio', 'ciudad', 'nombre_ciudad']);
        const depto = findAttributeValue(row, ['departamento', 'nombre_departamento']);
        const muniCode = findAttributeValue(row, ['codigo_municipio', 'cod_municipio', 'dane_municipio', 'código dane municipio', 'dane']);
        lookupMap.set(normalizeStr(cp), { muni, depto, muniCode });
     }
  });

  return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ZONES, 'readwrite');
      const store = tx.objectStore(STORE_ZONES);
      const request = store.openCursor();
      let updatedCount = 0;
      let totalCount = 0;

      request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result;
          if (cursor) {
              const zone: PostalZone = cursor.value;
              const normCP = normalizeStr(zone.codigo_postal);
              if (lookupMap.has(normCP)) {
                  const masterInfo = lookupMap.get(normCP)!;
                  let changed = false;
                  if (masterInfo.muni && (zone.nombre_municipio === 'Desconocido' || !zone.nombre_municipio)) { zone.nombre_municipio = masterInfo.muni; changed = true; } 
                  else if (masterInfo.muni) { zone.nombre_municipio = masterInfo.muni; changed = true; }
                  if (masterInfo.depto && (!zone.nombre_departamento)) { zone.nombre_departamento = masterInfo.depto; changed = true; } 
                  else if (masterInfo.depto) { zone.nombre_departamento = masterInfo.depto; changed = true; }
                  if (masterInfo.muniCode && (!zone.codigo_municipio)) { zone.codigo_municipio = masterInfo.muniCode; changed = true; }

                  if (changed) { cursor.update(zone); updatedCount++; }
              }
              totalCount++;
              cursor.continue();
          } else { resolve({ updated: updatedCount, total: totalCount }); }
      };
      request.onerror = () => reject(request.error);
  });
};

export const saveShapefileData = async (geoJson: any, onProgress?: (percent: number, msg: string) => void): Promise<void> => {
  if (!geoJson || !geoJson.features) throw new Error("Datos GeoJSON inválidos");
  const db = await openDB();
  
  await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ZONES, 'readwrite');
      const store = tx.objectStore(STORE_ZONES);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
  });

  const features = geoJson.features;
  const total = features.length;
  const BATCH_SIZE = 500;

  for (let i = 0; i < total; i += BATCH_SIZE) {
      const end = Math.min(i + BATCH_SIZE, total);
      await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_ZONES, 'readwrite');
          const store = tx.objectStore(STORE_ZONES);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          
          for (let j = i; j < end; j++) {
              const f = features[j];
              const props = f.properties || {};
              const cp = findAttributeValue(props, ['CODIGO_POS', 'CODIGO_POSTAL', 'COD_POSTAL', 'POSTAL_CODE', 'ZONA_POSTAL', 'CP', 'COD_POS', 'CODIGO', 'ZONA']) || '000000';
              const muniCode = findAttributeValue(props, ['MPIO_CDGO', 'MPIO_CCNCT', 'COD_MPIO', 'CODIGO_MUNICIPIO', 'DANE_MPIO', 'DANE', 'MPIO_CCDGO', 'MPIO_COD', 'COD_MUN', 'MUN_COD']);
              const muniName = findAttributeValue(props, ['MPIO_CNMBR', 'NOM_MPIO', 'NOMBRE_MUNICIPIO', 'MUNICIPIO', 'NOM_MUNICIPIO', 'NOMBRE', 'MPIO_NJ', 'MPIO_CNM', 'MPI_CNMBR', 'MUN_CNMBR', 'MUNICIPIO_NOMBRE', 'MPIO_NOMBRE']);
              const deptoCode = findAttributeValue(props, ['DPTO_CCDGO', 'COD_DPTO', 'CODIGO_DEPARTAMENTO', 'COD_DEPTO', 'DEPTO_COD', 'DPTO_COD']);
              const deptoName = findAttributeValue(props, ['DPTO_CNMBR', 'NOM_DPTO', 'NOMBRE_DEPARTAMENTO', 'DEPARTAMENTO', 'NOM_DEPTO', 'DPTO_CNM', 'DEP_CNMBR', 'DEPARTAMENTO_NOMBRE', 'DPTO_NOMBRE']);
              const center = calculateCentroid(f.geometry);
              const bbox = calculateBBox(f.geometry);
              const zone: PostalZone = {
                  id: `feat-${j}`,
                  codigo_postal: cp,
                  codigo_municipio: muniCode,
                  nombre_municipio: muniName || 'Desconocido',
                  codigo_departamento: deptoCode,
                  nombre_departamento: deptoName,
                  geometry: f.geometry,
                  bbox: bbox,
                  centerLat: center.lat,
                  centerLon: center.lon
              };
              store.put(zone);
          }
      });
      if (onProgress) { onProgress(Math.round((end / total) * 100), `Procesando zona ${end}/${total}...`); await new Promise(r => setTimeout(r, 0)); }
  }
  if (onProgress) onProgress(100, 'Completado');
};

export const syncZonesToSupabase = async (geoJson: any, onProgress?: (percent: number, msg: string) => void): Promise<{ inserted: number, total: number }> => {
  const table = (import.meta.env.VITE_SUPABASE_ZONES_TABLE as string) || 'postal_zones';
  const features = geoJson?.features || [];
  const total = features.length;
  let inserted = 0;
  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    return { inserted: 0, total };
  }
  const BATCH = 100;
  for (let i = 0; i < total; i += BATCH) {
    const end = Math.min(i + BATCH, total);
    const rows = [] as any[];
    for (let j = i; j < end; j++) {
      const f = features[j];
      const props = f.properties || {};
      const cp = findAttributeValue(props, ['CODIGO_POS', 'CODIGO_POSTAL', 'COD_POSTAL', 'POSTAL_CODE', 'ZONA_POSTAL', 'CP', 'COD_POS', 'CODIGO', 'ZONA']) || '000000';
      const muniCode = findAttributeValue(props, ['MPIO_CDGO', 'MPIO_CCNCT', 'COD_MPIO', 'CODIGO_MUNICIPIO', 'DANE_MPIO', 'DANE', 'MPIO_CCDGO', 'MPIO_COD', 'COD_MUN', 'MUN_COD']);
      const muniName = findAttributeValue(props, ['MPIO_CNMBR', 'NOM_MPIO', 'NOMBRE_MUNICIPIO', 'MUNICIPIO', 'NOM_MUNICIPIO', 'NOMBRE', 'MPIO_NJ', 'MPIO_CNM', 'MPI_CNMBR', 'MUN_CNMBR', 'MUNICIPIO_NOMBRE', 'MPIO_NOMBRE']);
      const deptoCode = findAttributeValue(props, ['DPTO_CCDGO', 'COD_DPTO', 'CODIGO_DEPARTAMENTO', 'COD_DEPTO', 'DEPTO_COD', 'DPTO_COD']);
      const deptoName = findAttributeValue(props, ['DPTO_CNMBR', 'NOM_DPTO', 'NOMBRE_DEPARTAMENTO', 'DEPARTAMENTO', 'NOM_DEPTO', 'DPTO_CNM', 'DEP_CNMBR', 'DEPARTAMENTO_NOMBRE', 'DPTO_NOMBRE']);
      rows.push({
        codigo_postal: cp,
        codigo_municipio: muniCode,
        nombre_municipio: muniName || null,
        codigo_departamento: deptoCode || null,
        nombre_departamento: deptoName || null,
        geometry: f.geometry
      });
    }
    const { error } = await supabase.from(table).upsert(rows);
    if (!error) {
      inserted += rows.length;
      if (onProgress) onProgress(Math.round((end / total) * 100), `Sincronizando Supabase ${end}/${total}...`);
    } else {
      console.warn('Supabase upsert error:', error.message);
      break;
    }
  }
  return { inserted, total };
};

export const getPostalDatabaseStats = async (): Promise<{ count: number; lastUpdated: Date | null }> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ZONES, 'readonly');
      const store = tx.objectStore(STORE_ZONES);
      const req = store.count();
      req.onsuccess = () => resolve({ count: req.result, lastUpdated: new Date() });
      req.onerror = () => reject(req.error);
  });
};

export const getPaginatedPostalDatabase = async (page: number = 1, limit: number = 20, searchQuery: string = ''): Promise<PaginatedResult<PostalZone>> => {
  const allZones = await getAllPostalZones();
  let parsed = allZones;
  if (searchQuery) {
    const lowerQ = normalizeStr(searchQuery);
    parsed = parsed.filter(p => normalizeStr(p.nombre_municipio).includes(lowerQ) || normalizeStr(p.codigo_postal).includes(lowerQ) || normalizeStr(p.nombre_departamento).includes(lowerQ));
  }
  parsed.sort((a, b) => {
    const cpA = parseInt(a.codigo_postal, 10);
    const cpB = parseInt(b.codigo_postal, 10);
    if (!isNaN(cpA) && !isNaN(cpB)) return cpA - cpB;
    return a.codigo_postal.localeCompare(b.codigo_postal);
  });
  const total = parsed.length;
  const totalPages = Math.ceil(total / limit);
  const safePage = Math.max(1, Math.min(page, totalPages || 1));
  const startIndex = (safePage - 1) * limit;
  const slicedData = parsed.slice(startIndex, startIndex + limit);
  return { data: slicedData, total, page: safePage, totalPages };
};

/* 
  =============================================================================
  REPORTER LOGIC (POWERED BY GOOGLE GENAI + MAPS GROUNDING)
  =============================================================================
*/

// Fetch Location with Caching and Retry Logic
const fetchAddressLocation = async (address: string, city: string, department?: string, retryCount: number = 0, simplification: number = 0): Promise<{ lat: number, lon: number } | null> => {
    if (!address || !address.trim()) return null;
    
    // NORMALIZE ADDRESS BEFORE SEARCHING
    const cleanAddress = normalizeAddressForGeocoding(address);
    let locationString = `${cleanAddress}, ${city}`;
    if (department) locationString += `, ${department}`;
    const fullQuery = `${locationString}, Colombia`;
    const key = `loc_search_${fullQuery.toLowerCase()}`;

    // 1. Check Persisted Cache first
    const cached = await getCachedLocation(key);
    if (cached !== undefined) {
        if (cached === null) {
            // Negative cache - was already tried and failed
            // Try simpler version if available
            if (simplification === 0) {
                return fetchAddressLocation(address, city, department, retryCount, 1);
            }
            return null;
        }
        return cached;
    }

    let result: { lat: number, lon: number } | null = null;

    // Try Google Maps Geocoding first if available
    result = await geocodeWithGoogleMaps(fullQuery);

    // Try Gemini API next if still not found
    if (!result && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'demo_key_for_testing') {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `You are a precise geocoding assistant. 
                Find the EXACT latitude and longitude coordinates for the specific address: "${fullQuery}".
                1. Use Google Maps to find the location.
                2. Return ONLY a valid JSON object with keys "lat" and "lon" (numbers).
                3. Do not return the city center unless the street is not found.
                4. Do not include markdown code blocks.`, 
                config: {
                    tools: [{ googleMaps: {} }, { googleSearch: {} }], 
                    maxOutputTokens: 100,
                    temperature: 0 // Deterministic
                }
            });

            let text = response.text || "";
            result = extractJSON(text);
            
            // Fallback to regex if JSON extraction failed
            if (!result) {
                const latRegex = /["']?(?:lat|latitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                const lonRegex = /["']?(?:lon|lng|long|longitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                const latMatch = text.match(latRegex);
                const lonMatch = text.match(lonRegex);
                if (latMatch && lonMatch) {
                    result = {
                        lat: parseFloat(latMatch[1]),
                        lon: parseFloat(lonMatch[1])
                    };
                }
            }
            
            if (result) {
                await saveCachedLocation(key, result);
                return result;
            }
        } catch (e: any) {
            const msg = e.toString().toLowerCase();
            // Propagate Quota errors up for special handling
            if (msg.includes('429') || msg.includes('quota') || msg.includes('limit')) {
                throw new Error('QUOTA_EXCEEDED');
            }
            console.warn(`[GEOCODE] Gemini failed for "${address}", trying Nominatim:`, e.message);
        }
    }

    // Fallback to Nominatim (OpenStreetMap) with retry logic
    if (!result) {
        try {
            // Progressive simplification strategy for Nominatim
            let searchQuery = fullQuery;
            if (simplification === 1) {
                // Try without street number
                searchQuery = `${city}, ${department}, Colombia`;
                console.log(`[GEOCODE] Simplification 1: "${searchQuery}"`);
            } else if (simplification === 2) {
                // Try just city and department
                searchQuery = `${city}, Colombia`;
                console.log(`[GEOCODE] Simplification 2: "${searchQuery}"`);
            }
            
            // Nominatim is strict about rate limiting, increase delay for batch operations
            const delayMs = retryCount > 0 ? 2000 + (retryCount * 1000) : 800;
            
            const encodedQuery = encodeURIComponent(searchQuery);
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=1&timeout=10`,
                {
                    headers: {
                        'User-Agent': 'ColPostalValidator/1.0 (batch-processing)',
                        'Accept-Language': 'es'
                    },
                    signal: AbortSignal.timeout(10000) // 10 second timeout
                }
            );
            
            if (response.ok) {
                const results = await response.json();
                if (results && results.length > 0) {
                    const first = results[0];
                    // Only accept results with reasonable confidence (importance > 0.5)
                    if (first.importance && first.importance > 0.3) {
                        result = {
                            lat: parseFloat(first.lat),
                            lon: parseFloat(first.lon)
                        };
                        console.log(`[GEOCODE] Nominatim SUCCESS (simp=${simplification}): "${address}" → ${result.lat}, ${result.lon}`);
                        await saveCachedLocation(key, result);
                        return result;
                    } else if (simplification < 2) {
                        // Try simpler version
                        console.warn(`[GEOCODE] Nominatim LOW CONFIDENCE (simp=${simplification}), trying simpler...`);
                        return fetchAddressLocation(address, city, department, retryCount, simplification + 1);
                    }
                }
            } else if (response.status === 429) {
                // Rate limited - retry with exponential backoff
                if (retryCount < 2) {
                    console.warn(`[GEOCODE] Nominatim rate limited, retry attempt ${retryCount + 1}`);
                    await sleep(3000 + (retryCount * 2000));
                    return fetchAddressLocation(address, city, department, retryCount + 1, simplification);
                }
            }
        } catch (e: any) {
            const msg = e.message?.toLowerCase() || '';
            if (msg.includes('abort') || msg.includes('timeout')) {
                console.warn(`[GEOCODE] Nominatim timeout for "${address}"`);
            } else {
                console.warn(`[GEOCODE] Nominatim error for "${address}":`, e.message);
            }
        }
    }

    // Cache result (including null) to avoid repeated failures
    if (result && typeof result.lat === 'number' && typeof result.lon === 'number') {
        await saveCachedLocation(key, result);
        return result;
    } else {
        // Try progressively simpler queries
        if (simplification < 2) {
            console.log(`[GEOCODE] Trying simplification ${simplification + 1} for "${address}"`);
            return fetchAddressLocation(address, city, department, retryCount, simplification + 1);
        }
        
        // Cache negative result to avoid trying again
        await saveCachedLocation(key, null);
        return null;
    }
};

export const findZoneByPoint = (lat: number, lon: number, zones: PostalZone[]): PostalZone | undefined => {
    return zones.find(zone => isPointInFeature(lon, lat, zone));
};

const resolveSingleAddress = async (
    row: { dane: string, city: string, department: string, address: string }, 
    db: PostalZone[], 
    zonesByMuni?: Record<string, PostalZone[]>
): Promise<{ postalCode: string, coords: string }> => {
    
    let localZonesByMuni = zonesByMuni;
    if (!localZonesByMuni) {
        localZonesByMuni = {};
        db.forEach(z => {
            const k = normalizeCityKey(z.nombre_municipio);
            if (!localZonesByMuni![k]) localZonesByMuni![k] = [];
            localZonesByMuni![k].push(z);
        });
    }

    const { city, address, dane, department } = row;
    let foundPostalCode = "SIN_COBERTURA";
    let foundCoords = "";

    // Validate input
    if (!city && !address) {
        return { postalCode: "DATOS_INCOMPLETOS", coords: "" };
    }

    const cleanCityName = city.replace(/\(.*?\)/g, "").trim();
    const normCity = normalizeCityKey(cleanCityName);
    
    // Strategy 1: Try to match by municipality name
    let candidates: PostalZone[] | undefined = localZonesByMuni[normCity];
    
    // Strategy 2: If municipality name didn't match, try DANE code
    if ((!candidates || candidates.length === 0) && dane) { 
        candidates = db.filter(z => z.codigo_municipio === dane); 
        if (candidates.length > 0) {
            console.log(`[DEBUG] Found ${candidates.length} zones by DANE code: ${dane}`);
        }
    }
    
    const zonesToCheck: PostalZone[] = candidates && candidates.length > 0 ? candidates : []; 
    
    // If still no candidates found, log warning
    if (zonesToCheck.length === 0 && (city || dane)) {
        console.warn(`[DEBUG] No zones found for city="${city}" or dane="${dane}". Database has ${db.length} total zones.`);
        return { postalCode: "MUNICIPIO_SIN_ZONAS", coords: "" };
    }
    
    // Strategy 3: Geocode address and match against zones
    if (address && zonesToCheck.length > 0) {
        try {
            const loc = await fetchAddressLocation(address, city, department);
            
            if (loc) {
                foundCoords = `${loc.lat}, ${loc.lon}`;
                console.log(`[DEBUG] Geocoded "${address}, ${city}" to ${foundCoords}`);
                
                // Try to find zone containing this point
                const match = zonesToCheck.find(zone => isPointInFeature(loc.lon, loc.lat, zone));
                
                if (match) {
                    foundPostalCode = match.codigo_postal;
                    console.log(`[DEBUG] Point matched to postal code: ${foundPostalCode}`);
                } else {
                    // Point is outside all polygons
                    console.warn(`[DEBUG] Geocoded point (${foundCoords}) is outside all polygons for ${city}`);
                    // Try a fallback: find closest zone by centroid distance
                    let closestZone: PostalZone | null = null;
                    let minDistance = Infinity;
                    
                    zonesToCheck.forEach(zone => {
                        const zoneCenter = calculateCentroid(zone.geometry);
                        const distance = Math.sqrt(
                            Math.pow(loc.lat - zoneCenter.lat, 2) + 
                            Math.pow(loc.lon - zoneCenter.lon, 2)
                        );
                        if (distance < minDistance && distance < 0.05) { // Within ~5km
                            minDistance = distance;
                            closestZone = zone;
                        }
                    });
                    
                    if (closestZone !== null) {
                        const cz = closestZone as PostalZone;
                        foundPostalCode = cz.codigo_postal;
                        const c = calculateCentroid(cz.geometry);
                        foundCoords = `${c.lat}, ${c.lon}`;
                        console.log(`[DEBUG] Point NEAR polygon, assigned closest zone: ${foundPostalCode}`);
                    } else {
                        foundPostalCode = "FUERA_DE_POLIGONO";
                    }
                }
            } else { 
                console.warn(`[DEBUG] Could not geocode address: "${address}, ${city}"`);
                // Fallback: If geocoding failed but we have municipality zones, 
                // assign the first zone (partial coverage)
                if (zonesToCheck.length > 0) {
                    const z0 = zonesToCheck[0];
                    foundPostalCode = z0.codigo_postal;
                    const c0 = calculateCentroid(z0.geometry);
                    foundCoords = `${c0.lat}, ${c0.lon}`;
                    console.warn(`[DEBUG] Geocoding failed, assigned first zone of ${city}: ${foundPostalCode}`);
                } else {
                    foundPostalCode = "DIR_NO_ENCONTRADA";
                }
            }
        } catch (geoErr: any) {
            console.error(`[DEBUG] Geocoding error for "${address}":`, geoErr.message);
            // If it's a quota error, propagate it
            if (geoErr.message === 'QUOTA_EXCEEDED') {
                throw geoErr;
            }
            foundPostalCode = "ERROR_GEOCODIFICACION";
        }
    } else if (!address) {
        // No address provided, but we have municipality - assign first zone or mark as incomplete
        foundPostalCode = "DATOS_INCOMPLETOS";
        console.warn(`[DEBUG] No address provided for ${city}`);
    }

    return { postalCode: foundPostalCode, coords: foundCoords };
};

// ADAPTIVE QUEUE PROCESSOR WITH ABORT SIGNAL
export const processTemplateBatch = async (
    templateRows: any[], 
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal
): Promise<AddressTemplate[]> => {
    
  const db = await getAllPostalZones();
  if (db.length === 0) throw new Error("No hay base maestra (Shapefile) cargada.");
  
  console.log(`[PROCESSOR] Starting batch processing of ${templateRows.length} rows with ${db.length} postal zones`);
  
  const zonesByMuni: Record<string, PostalZone[]> = {};
  db.forEach(z => {
      const k = normalizeCityKey(z.nombre_municipio);
      if (!zonesByMuni[k]) zonesByMuni[k] = [];
      zonesByMuni[k].push(z);
  });
  
  console.log(`[PROCESSOR] Organized ${db.length} zones into ${Object.keys(zonesByMuni).length} municipalities`);

  const results: AddressTemplate[] = new Array(templateRows.length);
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  
  // Work Queue
  const queue = Array.from({ length: templateRows.length }, (_, i) => i);
  
  let concurrency = 1;
  const useGoogle = !!(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY !== 'demo_key_for_testing');
  const useGemini = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'demo_key_for_testing');
  if (useGoogle) concurrency = 8; else if (useGemini) concurrency = 3;
  const envConc = parseInt(String(process.env.GEOCODE_CONCURRENCY || ''), 10);
  if (!isNaN(envConc) && envConc > 0 && envConc <= 16) concurrency = envConc;
  
  let isPaused = false;
  let activeWorkers = 0;
  const lastRequestTime = { value: 0 };
  let lastPercentReported = -1;
  let lastReportTs = 0;
  
  return new Promise((resolve, reject) => {
      // Handle Abort
      if (signal) {
          signal.addEventListener('abort', () => {
              console.log(`[PROCESSOR] Batch processing aborted. Processed: ${processedCount}/${templateRows.length}`);
              // Clear queue immediately
              queue.length = 0;
              // Workers will stop on next loop iteration
              // We resolve with what we have so far
              resolve(results.filter(r => r !== undefined)); 
          });
      }

      const startWorker = async () => {
          if (isPaused || queue.length === 0 || signal?.aborted) return;
          
          activeWorkers++;
          
          while (queue.length > 0) {
              if (signal?.aborted) break;
              if (isPaused) break;
              
              const index = queue.shift();
              if (index === undefined) break;

              const row = templateRows[index];
              const city = row['Ciudad de destino'] || row['ciudad_destino'] || '';
              const department = row['Departamento de destino'] || row['departamento_destino'] || row['departamento'] || '';
              const address = String(row['Dirección'] || row['direccion'] || '');
              const dane = String(row['DANE destino'] || row['dane_destino'] || '');
              const globalId = index;

              try {
                  const now = Date.now();
                  const minDelay = useGoogle ? 150 : (useGemini ? 400 : 1200);
                  const timeSinceLastRequest = now - lastRequestTime.value;
                  if (timeSinceLastRequest < minDelay) {
                      await sleep(minDelay - timeSinceLastRequest);
                  }
                  lastRequestTime.value = Date.now();
                  const res = await resolveSingleAddress({ dane, city, department, address }, db, zonesByMuni);
                  
                  // Check if result is valid postal code (not error status)
                  const isValidPostalCode = res.postalCode && 
                                           res.postalCode.length <= 6 && 
                                           !res.postalCode.includes('ERROR') &&
                                           !res.postalCode.includes('NO_') &&
                                           !res.postalCode.includes('SIN_');
                  
                  if (isValidPostalCode) {
                      successCount++;
                  } else {
                      errorCount++;
                      console.warn(`[PROCESSOR] Row ${globalId}: ${res.postalCode} for "${city}" - ${address}`);
                  }
                  
                  results[index] = { 
                      id: `tmpl-${globalId}`, 
                      dane_destino: dane, 
                      ciudad_destino: city,
                      departamento_destino: department,
                      direccion: address, 
                      codigo_postal_asignado: res.postalCode,
                      coordenadas: res.coords,
                      originalData: { ...row, 'DANE destino': dane } 
                  };
                  
                  processedCount++;
                  const pct = Math.round((processedCount / templateRows.length) * 100);
                  const ts = Date.now();
                  if (onProgress && (pct !== lastPercentReported || ts - lastReportTs > 500)) { onProgress(pct); lastPercentReported = pct; lastReportTs = ts; }
                  
                  // No additional delay needed - rate limiting is handled in fetchAddressLocation 

              } catch (err: any) {
                  if (err.message === 'QUOTA_EXCEEDED') {
                      // 1. Put item back in queue
                      queue.unshift(index);
                      
                      if (!isPaused) {
                          isPaused = true;
                          console.warn(`[PROCESSOR] Quota limit hit at row ${globalId}. Pausing for 30s...`);
                          errorCount++;
                          
                          setTimeout(() => {
                              if (signal?.aborted) return;
                              isPaused = false;
                              console.log("[PROCESSOR] Resuming after quota pause...");
                              for(let i=0; i<concurrency; i++) startWorker();
                          }, 30000); // 30s pause
                      }
                      
                      activeWorkers--;
                      return; 
                  } else {
                      // Non-quota error - mark as error but continue
                      console.error(`[PROCESSOR] Row ${globalId} error:`, err.message);
                      errorCount++;
                      
                      results[index] = { 
                          id: `tmpl-${globalId}`, 
                          dane_destino: dane, 
                          ciudad_destino: city,
                          departamento_destino: department, 
                          direccion: address, 
                          codigo_postal_asignado: "ERROR_PROCESO", 
                          coordenadas: "", 
                          originalData: row 
                      };
                      
                      processedCount++;
                      const pct2 = Math.round((processedCount / templateRows.length) * 100);
                      const ts2 = Date.now();
                      if (onProgress && (pct2 !== lastPercentReported || ts2 - lastReportTs > 500)) { onProgress(pct2); lastPercentReported = pct2; lastReportTs = ts2; }
                  }
              }
          }
          
          activeWorkers--;
          if (activeWorkers === 0 && queue.length === 0 && !isPaused && !signal?.aborted) {
              console.log(`[PROCESSOR] Batch complete: ${successCount} successful, ${errorCount} errors, ${processedCount} total processed`);
              resolve(results);
          } else if (signal?.aborted && activeWorkers === 0) {
              console.log(`[PROCESSOR] Aborted with partial results: ${processedCount}/${templateRows.length}`);
              resolve(results.filter(r => r !== undefined));
          }
      };

      for (let i = 0; i < concurrency; i++) startWorker();
  });
};

export const processTemplateTurbo = async (
  templateRows: any[],
  onProgress?: (percentage: number) => void,
  signal?: AbortSignal
): Promise<AddressTemplate[]> => {
  const db = await getAllPostalZones();
  if (db.length === 0) throw new Error("No hay base maestra (Shapefile) cargada.");

  const zonesByMuni: Record<string, PostalZone[]> = {};
  db.forEach(z => {
    const k = normalizeCityKey(z.nombre_municipio);
    if (!zonesByMuni[k]) zonesByMuni[k] = [];
    zonesByMuni[k].push(z);
  });

  const results: AddressTemplate[] = new Array(templateRows.length);
  let processedCount = 0;

  for (let i = 0; i < templateRows.length; i++) {
    if (signal?.aborted) break;
    const row = templateRows[i] || {};
    const dane = String(row['DANE destino'] || '').trim();
    const city = String(row['Ciudad de destino'] || '').trim();
    const department = String(row['Departamento de destino'] || row['departamento_destino'] || row['departamento'] || '').trim();
    const address = String(row['Dirección'] || row['direccion'] || '').trim();

    let candidates: PostalZone[] | undefined = zonesByMuni[normalizeCityKey(city)];
    if ((!candidates || candidates.length === 0) && dane) {
      candidates = db.filter(z => z.codigo_municipio === dane);
    }

    let chosen: PostalZone | undefined;
    if (candidates && candidates.length > 0) {
      if (candidates.length === 1) {
        chosen = candidates[0];
      } else {
        const muniCentroid = (() => {
          let sx = 0, sy = 0;
          candidates!.forEach(z => { sx += z.centerLon; sy += z.centerLat; });
          return { lon: sx / candidates!.length, lat: sy / candidates!.length };
        })();
        let minD = Infinity;
        candidates.forEach(z => {
          const d = Math.sqrt(Math.pow(z.centerLon - muniCentroid.lon, 2) + Math.pow(z.centerLat - muniCentroid.lat, 2));
          if (d < minD) { minD = d; chosen = z; }
        });
      }
    }

    const cp = chosen ? chosen.codigo_postal : (city || dane ? "MUNICIPIO_SIN_ZONAS" : "DATOS_INCOMPLETOS");
    const coords = chosen ? `${chosen.centerLat}, ${chosen.centerLon}` : '';

    results[i] = {
      id: `tmpl-fast-${i+1}`,
      dane_destino: dane ? dane.padStart(5, '0').slice(-5) : '00000',
      ciudad_destino: city,
      departamento_destino: department,
      direccion: address,
      codigo_postal_asignado: cp,
      coordenadas: coords,
      originalData: { ...row, 'DANE destino': dane ? dane.padStart(5, '0').slice(-5) : '00000' }
    };

    processedCount++;
    const pct = Math.round((processedCount / templateRows.length) * 100);
    if (onProgress) onProgress(pct);
  }

  return results;
};

export const reprocessSingleRow = async (item: AddressTemplate): Promise<AddressTemplate> => {
    const db = await getAllPostalZones();
    const result = await resolveSingleAddress({
        dane: item.dane_destino,
        city: item.ciudad_destino,
        department: item.departamento_destino || '',
        address: item.direccion
    }, db);

    return {
        ...item,
        codigo_postal_asignado: result.postalCode,
        coordenadas: result.coords
    };
};

export const searchPlaces = async (query: string, filter: 'all' | 'cp' | 'muni' = 'all'): Promise<any[]> => {
  // Kept for internal DB search if needed, but UI uses specific loaders now
  return []; 
};

// Helper: Geocode using Nominatim (OpenStreetMap) - FREE and no API key required
const geocodeWithNominatim = async (query: string): Promise<{ lat: number, lon: number } | null> => {
    try {
        const encodedQuery = encodeURIComponent(query + ", Colombia");
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=1`,
            {
                headers: {
                    'User-Agent': 'ColPostalVisualizerApp/1.0'
                }
            }
        );
        
        if (!response.ok) return null;
        
        const results = await response.json();
        if (results && results.length > 0) {
            const first = results[0];
            return {
                lat: parseFloat(first.lat),
                lon: parseFloat(first.lon)
            };
        }
        return null;
    } catch (e) {
        console.warn("Nominatim geocoding failed:", e);
        return null;
    }
};

// Geocode using Google Maps Geocoding API
const geocodeWithGoogleMaps = async (query: string): Promise<{ lat: number, lon: number } | null> => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey || apiKey === 'demo_key_for_testing') return null;
    try {
        const encoded = encodeURIComponent(`${query}, Colombia`);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&components=country:CO&region=CO&key=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.status === 'OK' && data.results && data.results.length > 0) {
            const loc = data.results[0]?.geometry?.location;
            if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
                return { lat: loc.lat, lon: loc.lng };
            }
        }
        const url2 = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encoded}&inputtype=textquery&fields=geometry&region=CO&key=${apiKey}`;
        const res2 = await fetch(url2);
        if (!res2.ok) return null;
        const data2 = await res2.json();
        const candidate = data2.candidates && data2.candidates[0];
        const geom = candidate?.geometry?.location;
        if (geom && typeof geom.lat === 'number' && typeof geom.lng === 'number') {
            return { lat: geom.lat, lon: geom.lng };
        }
        return null;
    } catch (e) {
        console.warn('Google Maps geocoding failed:', e);
        return null;
    }
};

export const searchExternalLocations = async (query: string): Promise<any[]> => {
    if (!query || !query.trim()) return [];
    
    // NORMALIZE SEARCH QUERY
    const cleanQuery = normalizeAddressForGeocoding(query);
    const key = `loc_search_${cleanQuery.toLowerCase()}`;

    try {
        // Check cache first
        const cached = await getCachedLocation(key);
        if (cached) {
             return [{
                type: 'ADDRESS',
                data: {
                    lat: cached.lat,
                    lon: cached.lon,
                    display_name: cleanQuery, 
                    address: { road: cleanQuery }
                }
            }];
        }

        let result: { lat: number, lon: number } | null = null;

        // Try Google Maps Geocoding first
        result = await geocodeWithGoogleMaps(cleanQuery);

        // Try Gemini next if not found
        if (!result && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'demo_key_for_testing') {
            try {
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: `You are a precise geocoding assistant. 
                    Find the EXACT latitude and longitude coordinates for the specific address in Colombia: "${cleanQuery}".
                    1. Use Google Maps to find the location.
                    2. Return ONLY a valid JSON object with keys "lat" and "lon" (numbers).
                    3. Do not return the city center unless the street is not found.
                    4. Do not include markdown code blocks.`, 
                    config: {
                        tools: [{ googleMaps: {} }, { googleSearch: {} }],
                        maxOutputTokens: 100,
                        temperature: 0
                    }
                });

                let text = response.text || "";
                result = extractJSON(text);

                if (!result) {
                    const latRegex = /["']?(?:lat|latitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                    const lonRegex = /["']?(?:lon|lng|long|longitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                    const latMatch = text.match(latRegex);
                    const lonMatch = text.match(lonRegex);
                    if (latMatch && lonMatch) {
                        result = {
                            lat: parseFloat(latMatch[1]),
                            lon: parseFloat(lonMatch[1])
                        };
                    }
                }
            } catch (e: any) {
                console.warn("Gemini API failed, falling back to Nominatim:", e);
            }
        }

        // Fallback to Nominatim (OpenStreetMap) - FREE and always available
        if (!result) {
            result = await geocodeWithNominatim(cleanQuery);
        }

        if (result && typeof result.lat === 'number' && typeof result.lon === 'number') {
            await saveCachedLocation(key, result);
            return [{
                type: 'ADDRESS',
                data: {
                    lat: result.lat,
                    lon: result.lon,
                    display_name: cleanQuery, 
                    address: { road: cleanQuery }
                }
            }];
        }
        
        return [];

    } catch (e: any) {
        const msg = e.toString().toLowerCase();
        if (msg.includes('key') || msg.includes('quota') || msg.includes('permission') || msg.includes('403') || msg.includes('429')) {
            throw e; 
        }
        console.error("Error in external search:", e);
        return [];
    }
};