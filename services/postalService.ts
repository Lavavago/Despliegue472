import { PostalZone, AddressTemplate, PaginatedResult, MunicipalIndexEntry } from '../types';
import { GoogleGenAI } from "@google/genai";
import { createClient } from '@supabase/supabase-js';

/* 
  =============================================================================
  INDEXEDDB STORAGE
  =============================================================================
*/
const DB_NAME = 'ColPostalDB';
const DB_VERSION = 5;
const STORE_ZONES = 'zones';
const STORE_GEO_CACHE = 'geo_cache';
const STORE_MUNI_INDEX = 'muni_index';
const STORE_PROCESSOR_STATE = 'processor_state';

const normalizeStr = (str: string) => str ? str.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "";

const normalizeCityKey = (raw: string): string => {
    if (!raw) return "";
    // Remove parentheses content entirely
    let s = raw.toString().replace(/\(.*?\)/g, "").trim();
    // Normalize diacritics and case
    s = normalizeStr(s);
    // Remove residual punctuation and common prefixes/suffixes
    s = s.replace(/[\.,]/g, " ");
    s = s.replace(/\bciudad\s+de\b/gi, "");
    s = s.replace(/\bmunicipio\s+de\b/gi, "");
    s = s.replace(/\bd\.?c\.?\b/gi, "");
    s = s.replace(/\bdistrito\s+capital\b/gi, "");
    s = s.replace(/\bcolombia\b/gi, "");
    s = s.replace(/\s+/g, " ").trim();
    // Special rule: any variant of Bogota becomes exactly 'BOGOTA'
    if (s.toUpperCase().includes('BOGOTA')) return 'BOGOTA';
    return normalizeStr(s);
};

// In-memory cache for this session (faster than DB for repeated rows in same file)
const memCache: Record<string, { lat: number, lon: number } | null> = {};

let zonesMemCache: PostalZone[] = [];
let zonesByDaneIndex: Record<string, PostalZone[]> = {};
let zonesByCityIndex: Record<string, PostalZone[]> = {};
let zonesIndexReady = false;

export const ensureZonesWarmCache = async (): Promise<void> => {
  if (zonesIndexReady && zonesMemCache.length > 0) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_ZONES, 'readonly');
    const store = tx.objectStore(STORE_ZONES);
    const req = store.openCursor();
    const mem: PostalZone[] = [];
    const byDane: Record<string, PostalZone[]> = {};
    const byCity: Record<string, PostalZone[]> = {};
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result;
      if (cursor) {
        const z = cursor.value as PostalZone;
        mem.push(z);
        const d5 = String(z.codigo_municipio || '').replace(/\D/g, '').padStart(5, '0').slice(-5);
        if (!byDane[d5]) byDane[d5] = [];
        byDane[d5].push(z);
        const ck = normalizeCityKey(z.nombre_municipio || '');
        if (!byCity[ck]) byCity[ck] = [];
        byCity[ck].push(z);
        cursor.continue();
      } else {
        zonesMemCache = mem;
        zonesByDaneIndex = byDane;
        zonesByCityIndex = byCity;
        zonesIndexReady = true;
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
};

export const getZonesByDane = (dane: string): PostalZone[] => {
  const d5 = String(dane || '').replace(/\D/g, '').padStart(5, '0').slice(-5);
  return zonesByDaneIndex[d5] || [];
};

export const getZonesByCityKey = (city: string): PostalZone[] => {
  const key = normalizeCityKey(city || '');
  return zonesByCityIndex[key] || [];
};

// Initialize GenAI lazily to avoid browser error when API key is missing
const getGenAI = (): GoogleGenAI | null => {
  const key = (import.meta as any).env.VITE_GEMINI_API_KEY as string;
  const enabled = ((import.meta as any).env.VITE_ENABLE_GEMINI === '1');
  if (!enabled) return null;
  if (!key || key === 'demo_key_for_testing') return null;
  try {
    return new GoogleGenAI({ apiKey: key });
  } catch {
    return null;
  }
};

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
      // Reset geo cache on upgrade
      if (db.objectStoreNames.contains(STORE_GEO_CACHE)) {
          db.deleteObjectStore(STORE_GEO_CACHE);
      }
      db.createObjectStore(STORE_GEO_CACHE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_MUNI_INDEX)) {
        db.createObjectStore(STORE_MUNI_INDEX, { keyPath: 'dane' });
      }
      if (!db.objectStoreNames.contains(STORE_PROCESSOR_STATE)) {
        db.createObjectStore(STORE_PROCESSOR_STATE, { keyPath: 'id' });
      }
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
    
    const stopWordsRegex = new RegExp(`\\b(${stopWords.join('|')})\\b`, 'gi');
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

const stripExtraneousAddressParts = (address: string, city: string): string => {
    let s = address || '';
    const lower = s.toLowerCase();
    // Cut at first comma
    if (s.includes(',')) s = s.split(',')[0];
    // Cut at keywords
    const keywords = ['piso','apto','apartamento','interior','barrio','casa','frente al parque','frente','esquina'];
    for (const kw of keywords) {
        const idx = lower.indexOf(kw);
        if (idx > -1) { s = s.substring(0, idx).trim(); break; }
    }
    // Cut at hyphen only if followed by keyword
    const hyKw = s.match(/\s-\s*(piso|apto|apartamento|interior|barrio|casa|frente|esquina)/i);
    if (hyKw && hyKw.index !== undefined) {
        s = s.substring(0, hyKw.index).trim();
    }
    // Remove conflicting city names inside address that do not match the provided city
    const cityNorm = normalizeStr(city);
    const conflicts = ['corinto','cauca','medellin','barranquilla','cartagena','cali','soacha','envigado','itagui','yopal','duitama'];
    for (const c of conflicts) {
        if (!cityNorm.includes(c) && s.toLowerCase().includes(c)) {
            s = s.replace(new RegExp(`\\b${c}\\b`, 'gi'), '').replace(/\s\s+/g, ' ').trim();
        }
    }
    return s.trim();
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
  if (zonesIndexReady && zonesMemCache.length > 0) return zonesMemCache;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_ZONES, 'readonly');
    const store = tx.objectStore(STORE_ZONES);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

export const loadProcessorState = async (): Promise<{ data: AddressTemplate[]; fileName?: string } | null> => {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_PROCESSOR_STATE, 'readonly');
    const store = tx.objectStore(STORE_PROCESSOR_STATE);
    const req = store.get('latest');
    req.onsuccess = () => {
      const res = req.result;
      if (res && Array.isArray(res.data)) resolve({ data: res.data, fileName: res.fileName || '' }); else resolve(null);
    };
    req.onerror = () => resolve(null);
  });
};

export const saveProcessorState = async (payload: { data: AddressTemplate[]; fileName?: string }): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROCESSOR_STATE, 'readwrite');
    const store = tx.objectStore(STORE_PROCESSOR_STATE);
    const req = store.put({ id: 'latest', ...payload, savedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
};

export const updateZonesFromMasterExcel = async (excelData: any[], onProgress?: (percent: number) => void): Promise<{updated: number, total: number}> => {
  const db = await openDB();
  const lookupMap = new Map<string, { muni: string, depto: string, muniCode: string, localidad: string }>();
  
  excelData.forEach(row => {
     const cp = findAttributeValue(row, ['codigo_postal', 'postal_code', 'cp', 'código postal', 'zona_postal']);
     if (cp) {
        const muni = findAttributeValue(row, ['municipio', 'nombre_municipio', 'ciudad', 'nombre_ciudad']);
        const depto = findAttributeValue(row, ['departamento', 'nombre_departamento']);
        const muniCode = findAttributeValue(row, ['codigo_municipio', 'cod_municipio', 'dane_municipio', 'código dane municipio', 'dane']);
        const localidad = findAttributeValue(row, ['localidad', 'nombre_localidad', 'ciudad_distrito']);
        lookupMap.set(normalizeStr(cp), { muni, depto, muniCode, localidad });
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

                  if (masterInfo.localidad) { zone.nombre_localidad = masterInfo.localidad; changed = true; }
                  if (changed) { cursor.update(zone); updatedCount++; }
              }
              totalCount++;
              cursor.continue();
          } else { resolve({ updated: updatedCount, total: totalCount }); }
      };
      request.onerror = () => reject(request.error);
  });
};

// Municipal Index (CSV) Loader
const muniNameMapMem: Record<string, string> = {}; // norm name -> dane
export const upsertMunicipalIndexFromCSV = async (rows: any[], onProgress?: (percent: number) => void): Promise<{ inserted: number, total: number }> => {
  const db = await openDB();
  // Aggregate by DANE
  const byDane = new Map<string, MunicipalIndexEntry>();
  const getTipo = (props: any): string => {
    const t = findAttributeValue(props, ['tipo']);
    const n = normalizeStr(t);
    if (n.includes('urb')) return 'urbana';
    if (n.includes('rur')) return 'rural';
    return n || 'desconocida';
  };
  const pad5 = (code: string): string => {
    const digits = String(code || '').replace(/\D/g, '');
    return digits ? digits.padStart(5, '0').slice(-5) : '00000';
  };
  rows.forEach((row) => {
    const daneRaw0 = findAttributeValue(row, ['codigo_municipio']);
    const daneClean = String(daneRaw0 || '').replace(/[\.,]/g, '');
    const dane = pad5(daneClean);
    if (!dane || dane === '00000') return;
    const cpRaw0 = findAttributeValue(row, ['codigo_postal']);
    let cpDigits = String(cpRaw0 || '').replace(/\D/g, '');
    if (cpDigits.length === 5) cpDigits = cpDigits + '0';
    const cp = cpDigits;
    if (!cp) return;
    const muni = findAttributeValue(row, ['nombre_municipio']);
    const depto = findAttributeValue(row, ['nombre_departamento']);
    const tipo = getTipo(row);
    const barrios = findAttributeValue(row, ['barrios_contenidos_en_el_codigo_postal']);
    if (!byDane.has(dane)) {
      byDane.set(dane, {
        dane,
        nombre_municipio: muni || '',
        nombre_departamento: depto || '',
        entries: [],
        preferred_postal: cp
      });
    }
    const entry = byDane.get(dane)!;
    entry.nombre_municipio = muni || entry.nombre_municipio;
    entry.nombre_departamento = depto || entry.nombre_departamento;
    entry.entries.push({ codigo_postal: cp, tipo });
    // prefer urbana
    if (normalizeStr(tipo).includes('urb')) entry.preferred_postal = cp;
  });

  // Populate name map in-memory
  byDane.forEach((val) => {
    if (val.nombre_municipio) {
      muniNameMapMem[normalizeCityKey(val.nombre_municipio)] = val.dane;
    }
  });

  // Write to IndexedDB
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MUNI_INDEX, 'readwrite');
    const store = tx.objectStore(STORE_MUNI_INDEX);
    let inserted = 0;
    const total = byDane.size;
    byDane.forEach((val) => { store.put(val); inserted++; });
    tx.oncomplete = () => {
      try { localStorage.setItem('MUNI_INDEX_READY', '1'); } catch {}
      if (onProgress) onProgress(100);
      resolve({ inserted, total });
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const loadOfficialPostalCSV = async (rows: any[]): Promise<{ loaded: number }> => {
  const { inserted } = await upsertMunicipalIndexFromCSV(rows);
  await ensureMunicipalIndexWarmCache();
  return { loaded: inserted };
};

export const getMunicipalIndexByDane = async (dane: string): Promise<MunicipalIndexEntry | null> => {
  const db = await openDB();
  const code = String(dane || '').replace(/\D/g, '').padStart(5, '0').slice(-5);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MUNI_INDEX, 'readonly');
    const store = tx.objectStore(STORE_MUNI_INDEX);
    const req = store.get(code);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
};

export const getMunicipalIndexStats = async (): Promise<{ count: number }> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MUNI_INDEX, 'readonly');
    const store = tx.objectStore(STORE_MUNI_INDEX);
    const req = store.count();
    req.onsuccess = () => resolve({ count: req.result });
    req.onerror = () => reject(req.error);
  });
};

export const clearMunicipalIndex = async (): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MUNI_INDEX, 'readwrite');
    const store = tx.objectStore(STORE_MUNI_INDEX);
    const req = store.clear();
    req.onsuccess = () => {
      try { localStorage.removeItem('MUNI_INDEX_READY'); } catch {}
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
};

export const ensureMunicipalIndexWarmCache = async (): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MUNI_INDEX, 'readonly');
    const store = tx.objectStore(STORE_MUNI_INDEX);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result;
      if (cursor) {
        const val = cursor.value as MunicipalIndexEntry;
        if (val?.nombre_municipio && val?.dane) {
          muniNameMapMem[normalizeCityKey(val.nombre_municipio)] = val.dane;
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
};

export const getMunicipalIndexByCityName = async (city: string): Promise<MunicipalIndexEntry | null> => {
  const key = normalizeCityKey(city);
  const dane = muniNameMapMem[key];
  if (dane) return getMunicipalIndexByDane(dane);
  // if not in mem, perform a scan once
  await ensureMunicipalIndexWarmCache();
  const dane2 = muniNameMapMem[key];
  return dane2 ? getMunicipalIndexByDane(dane2) : null;
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
              const locName = findAttributeValue(props, ['LOCALIDAD', 'LOC_CNMBR', 'NOM_LOC', 'LOCALIDAD_NOMBRE', 'NOMBRE_LOCALIDAD', 'LOCALIDAD_NOM']);
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
                  nombre_localidad: locName,
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
      const locName = findAttributeValue(props, ['LOCALIDAD', 'LOC_CNMBR', 'NOM_LOC', 'LOCALIDAD_NOMBRE', 'NOMBRE_LOCALIDAD', 'LOCALIDAD_NOM']);
      rows.push({
        codigo_postal: cp,
        codigo_municipio: muniCode,
        nombre_municipio: muniName || null,
        codigo_departamento: deptoCode || null,
        nombre_departamento: deptoName || null,
        nombre_localidad: locName || null,
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
const fetchAddressLocation = async (address: string, city: string, department?: string, retryCount: number = 0, simplification: number = 0, recipient?: string): Promise<{ lat: number, lon: number } | null> => {
    if (!address || !address.trim()) return null;
    
    // NORMALIZE ADDRESS BEFORE SEARCHING
    const cleanAddress = normalizeAddressForGeocoding(address);
    const normCity = normalizeStr(city);
    const strictCity = normCity.includes('bogota') ? 'Bogotá' : city.trim();
    const departmentStrict = department && department.trim() ? department.trim() : (normCity.includes('bogota') ? 'Bogotá D.C.' : '');
    const primaryAddress = stripExtraneousAddressParts(cleanAddress, strictCity);
    let locationString = `${primaryAddress}, ${strictCity}${departmentStrict ? `, ${departmentStrict}` : ''}`;
    if (recipient && recipient.trim()) locationString += `, ${recipient.trim()}`;
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

    if (!result) {
        const g = await geocodeWithGoogleMaps(fullQuery, strictCity, departmentStrict);
        if (g) {
            result = g;
            console.log(`[GEOCODE] Google Maps SUCCESS: "${address}"`);
            await saveCachedLocation(key, result);
            return result;
        }
    }

    if (!result) {
        try {
            // Progressive simplification strategy for Nominatim
            let searchQuery = fullQuery;
            if (simplification === 1) {
                const m = cleanAddress.match(/^(Calle|Carrera|Diagonal|Transversal|Avenida|Circular|Autopista|Avenida Calle|Avenida Carrera)\s+[^,]+/i);
                const streetOnly = m ? m[0].trim() : cleanAddress;
                searchQuery = `${streetOnly}, ${strictCity}${departmentStrict ? `, ${departmentStrict}` : ''}, Colombia`;
            } else if (simplification === 2) {
                searchQuery = `${strictCity}${departmentStrict ? `, ${departmentStrict}` : ''}, Colombia`;
            }
            
            const delayMs = retryCount > 0 ? 5000 + (retryCount * 2000) : 2000;
            
            const encodedQuery = encodeURIComponent(searchQuery);
            const isBogota = normalizeStr(strictCity).includes('bogota');
            const bogotaViewbox = '-74.25,4.85,-73.95,4.45'; // lonW,latN,lonE,latS approx
            const baseUrlQ = `https://nominatim.openstreetmap.org/search?q=${encodedQuery}&format=json&limit=1&timeout=10&countrycodes=co`;
            const streetParamBase = (simplification === 1) ? (primaryAddress.match(/^(Calle|Carrera|Diagonal|Transversal|Avenida|Circular|Autopista|Avenida Calle|Avenida Carrera)\s+[^,]+/i)?.[0]?.trim() || primaryAddress) : primaryAddress;
            const streetParam = stripExtraneousAddressParts(streetParamBase, strictCity);
            const baseUrlStructured = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(streetParam)}&city=${encodeURIComponent(strictCity)}${departmentStrict ? `&state=${encodeURIComponent(departmentStrict)}` : ''}&country=Colombia&format=json&limit=1&timeout=10&countrycodes=co`;
            const baseUrl = departmentStrict ? baseUrlStructured : baseUrlQ;
            const url = isBogota ? `${baseUrl}&viewbox=${bogotaViewbox}&bounded=1` : baseUrl;
            const response = await fetch(
                url,
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
                    const minImp = simplification === 0 ? 0.7 : 0.5;
                    if (first.importance && first.importance >= minImp) {
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
                if (retryCount < 5) {
                    const base = 1000;
                    const delay = base * Math.pow(2, retryCount); // 1s, 2s, 4s, 8s, 16s
                    console.warn(`[GEOCODE] Nominatim 429, intento ${retryCount + 1}, esperando ${delay}ms`);
                    await sleep(delay);
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

    if (!result) {
        const g = await geocodeWithGoogleMaps(fullQuery);
        if (g) {
            await saveCachedLocation(key, g);
            return g;
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
    const candidates = zones.filter(z => {
        const [minLon, minLat, maxLon, maxLat] = z.bbox;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    });
    return candidates.find(zone => isPointInFeature(lon, lat, zone));
};

const resolveSingleAddress = async (
    row: { dane: string, city: string, department: string, address: string, recipient?: string }, 
    db: PostalZone[], 
    zonesByMuni?: Record<string, PostalZone[]>
): Promise<{ postalCode: string, coords: string, localidad?: string }> => {
    
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
    let foundLocalidad = "";

    // Validate input
    if (!city && !address) {
        return { postalCode: "DATOS_INCOMPLETOS", coords: "" };
    }

    const cleanCityName = city.replace(/\(.*?\)/g, "").trim();
    const normCity = normalizeCityKey(cleanCityName);
    try { console.log(`[TRACE] cityKey="${normCity}", initialCandidates=${(localZonesByMuni[normCity]||[]).length}`); } catch {}
    
    // Strategy 1: Try to match by municipality name
    let candidates: PostalZone[] | undefined = localZonesByMuni[normCity];
    
    // Strategy 1b: Try city synonyms (e.g., "bogota dc" -> "bogota")
    if ((!candidates || candidates.length === 0)) {
        const synonyms: string[] = [];
        const base = normCity.replace(/\bdc\b/g, '').trim();
        if (base && base !== normCity) synonyms.push(base);
        if (normCity.includes('bogota')) synonyms.push('bogota');
        if (normCity.includes('ibague')) synonyms.push('ibague');
        if (normCity.includes('barranquilla')) synonyms.push('barranquilla');
        if (normCity.includes('medellin')) synonyms.push('medellin');
        for (const syn of synonyms) {
            if (localZonesByMuni[syn] && localZonesByMuni[syn].length > 0) {
                candidates = localZonesByMuni[syn];
                console.log(`[DEBUG] Found ${candidates.length} zones by city synonym: ${syn}`);
                break;
            }
        }
        // As a last resort on name, scan db for normalized name equality
        if ((!candidates || candidates.length === 0)) {
            const eq = db.filter(z => normalizeCityKey(z.nombre_municipio || '') === normCity);
            if (eq.length > 0) {
                candidates = eq;
                console.log(`[DEBUG] Found ${candidates.length} zones by normalized municipality equality: ${normCity}`);
            }
        }
    }
    
    // Strategy 2: If municipality name didn't match, try DANE code (allow prefix/suffix variants)
    if ((!candidates || candidates.length === 0) && dane) { 
        const d5 = String(dane).replace(/\D/g, '').padStart(5, '0').slice(-5);
        const byD = zonesIndexReady ? getZonesByDane(d5) : [];
        if (byD.length > 0) {
            candidates = byD;
        } else {
            const byExact = db.filter(z => String(z.codigo_municipio || '').replace(/\D/g, '').padStart(5, '0').slice(-5) === d5);
            const byStarts = byExact.length > 0 ? byExact : db.filter(z => String(z.codigo_municipio || '').replace(/\D/g, '').padStart(5, '0').slice(-5).startsWith(d5));
            const byEnds = byStarts.length > 0 ? byStarts : db.filter(z => d5.startsWith(String(z.codigo_municipio || '').replace(/\D/g, '').padStart(5, '0').slice(-5)));
            candidates = byEnds;
        }
        if (candidates.length > 0) {
            console.log(`[DEBUG] Found ${candidates.length} zones by DANE match: ${d5}`);
        }
    }

    // Strategy 3: Fallback by department if still not found
    if ((!candidates || candidates.length === 0)) {
        const depRaw = row.department || '';
        const depNorm = normalizeStr(depRaw);
        if (depNorm) {
            const depCandidates = db.filter(z => normalizeStr(z.nombre_departamento || '') === depNorm);
            if (depCandidates.length > 0) {
                candidates = depCandidates;
                console.log(`[DEBUG] Found ${candidates.length} zones by department: ${depRaw}`);
            }
        }
        // Special case: Bogotá D.C. often labeled as department
        if ((!candidates || candidates.length === 0) && normCity.includes('bogota')) {
            const bogotaDep = db.filter(z => normalizeStr(z.nombre_departamento || '') === normalizeStr('Bogotá D.C.'));
            if (bogotaDep.length > 0) {
                candidates = bogotaDep;
                console.log(`[DEBUG] Found ${candidates.length} zones by department fallback: Bogotá D.C.`);
            }
        }
    }
    
    const zonesToCheck: PostalZone[] = candidates && candidates.length > 0 ? candidates : []; 
    const strictCityName = normalizeStr(cleanCityName).includes('bogota') ? 'Bogotá' : cleanCityName;
    const departmentParam = (department && department.trim()) ? department : (zonesToCheck[0]?.nombre_departamento || '');
    
    // LOOKUP DIRECTO POR DANE
    if (dane && dane !== '00000') {
        const muniIndex = await getMunicipalIndexByDane(dane);
        if (muniIndex?.preferred_postal) {
            let selectedCP = muniIndex.preferred_postal;
            if (address && muniIndex.entries.length > 1) {
                const isRural = /vereda|rural|finca|km\s*\d/i.test(address);
                const refined = muniIndex.entries.find(e =>
                    isRural ? normalizeStr(e.tipo).includes('rural') : normalizeStr(e.tipo).includes('urb')
                );
                if (refined) selectedCP = refined.codigo_postal;
            }
            const zone = zonesToCheck.find(z => z.codigo_postal === selectedCP) || db.find(z => z.codigo_postal === selectedCP);
            if (zone) {
                const lat = zone.centerLat || calculateCentroid(zone.geometry).lat;
                const lon = zone.centerLon || calculateCentroid(zone.geometry).lon;
                foundCoords = `${lat}, ${lon}`;
                foundLocalidad = zone.nombre_localidad || muniIndex.nombre_municipio;
            }
            foundPostalCode = selectedCP;
            console.log(`[LOOKUP] DANE ${dane} → ${selectedCP}`);
            return { postalCode: foundPostalCode, coords: foundCoords, localidad: foundLocalidad };
        }
    }

    // If still no candidates found, log warning
    if (zonesToCheck.length === 0 && (city || dane)) {
        console.warn(`[DEBUG] No zones found for city="${city}" or dane="${dane}". Database has ${db.length} total zones.`);
        return { postalCode: "MUNICIPIO_SIN_ZONAS", coords: "" };
    }
    
    // Strategy 3: Geocode address and match against zones
    if (address && zonesToCheck.length > 0) {
        try {
            const loc = await fetchAddressLocation(address, strictCityName, departmentParam, 0, 0, row.recipient);
            
            if (loc) {
                foundCoords = `${loc.lat}, ${loc.lon}`;
                console.log(`[DEBUG] Geocoded "${address}, ${city}" to ${foundCoords}`);
                
                // Try to find zone containing this point using bbox prefilter
                const bboxPrefilter = zonesToCheck.filter(z => {
                    const [minLon, minLat, maxLon, maxLat] = z.bbox;
                    return loc.lon >= minLon && loc.lon <= maxLon && loc.lat >= minLat && loc.lat <= maxLat;
                });
                const match = bboxPrefilter.find(zone => isPointInFeature(loc.lon, loc.lat, zone));
                
                if (match) {
                    foundPostalCode = match.codigo_postal;
                    if (match.nombre_localidad) foundLocalidad = match.nombre_localidad;
                    console.log(`[DEBUG] Point matched to postal code: ${foundPostalCode}`);
                } else {
                    console.warn(`[DEBUG] Geocoded point (${foundCoords}) is outside all polygons for ${city}`);
                    const loc2 = await fetchAddressLocation(address, strictCityName, departmentParam, 0, 1, row.recipient);
                    if (loc2) {
                        const match2 = zonesToCheck.find(zone => isPointInFeature(loc2.lon, loc2.lat, zone));
                        if (match2) {
                            foundPostalCode = match2.codigo_postal;
                            if (match2.nombre_localidad) foundLocalidad = match2.nombre_localidad;
                            foundCoords = `${loc2.lat}, ${loc2.lon}`;
                        } else {
                            foundPostalCode = "REVISAR_DIRECCION";
                        }
                    } else {
                        foundPostalCode = "REVISAR_DIRECCION";
                    }
                    // Fallback to municipal index by DANE or city name
                    if (foundPostalCode === "REVISAR_DIRECCION") {
                        const idx = row.dane ? await getMunicipalIndexByDane(row.dane) : null;
                        if (idx && idx.preferred_postal) {
                            foundPostalCode = idx.preferred_postal;
                            const zc = zonesToCheck.find(z => z.codigo_postal === foundPostalCode) || db.find(z => z.codigo_postal === foundPostalCode);
                            if (zc) {
                                const cl = zc.centerLat;
                                const cn = zc.centerLon;
                                if (typeof cl === 'number' && typeof cn === 'number') {
                                    foundCoords = `${cl}, ${cn}`;
                                } else {
                                    const ct = calculateCentroid(zc.geometry);
                                    foundCoords = `${ct.lat}, ${ct.lon}`;
                                }
                            }
                        } else {
                            const idx2 = await getMunicipalIndexByCityName(strictCityName);
                            if (idx2 && idx2.preferred_postal) {
                                foundPostalCode = idx2.preferred_postal;
                                const zc2 = zonesToCheck.find(z => z.codigo_postal === foundPostalCode) || db.find(z => z.codigo_postal === foundPostalCode);
                                if (zc2) {
                                    const cl2 = zc2.centerLat;
                                    const cn2 = zc2.centerLon;
                                    if (typeof cl2 === 'number' && typeof cn2 === 'number') {
                                        foundCoords = `${cl2}, ${cn2}`;
                                    } else {
                                        const ct2 = calculateCentroid(zc2.geometry);
                                        foundCoords = `${ct2.lat}, ${ct2.lon}`;
                                    }
                                }
                            }
                        }
                    }
                }
                if (!foundLocalidad) {
                    const locName = await reverseGeocodeLocalidad(loc.lat, loc.lon);
                    if (locName) foundLocalidad = locName;
                }
                if (foundLocalidad) {
                    const normLoc = normalizeStr(foundLocalidad);
                    const byLoc = zonesToCheck.find(z => normalizeStr(z.nombre_localidad || '') === normLoc);
                    if (byLoc) {
                        foundPostalCode = byLoc.codigo_postal;
                    }
                }
            } else { 
                console.warn(`[DEBUG] Could not geocode address: "${address}, ${city}"`);
                // Fallback: do NOT infer from municipality centroid; require precise geocoding
                foundPostalCode = "DIR_NO_ENCONTRADA";

                // Consistency retry: if still DIR_NO_ENCONTRADA, try strict re-geocode and re-match
                if (foundPostalCode === "DIR_NO_ENCONTRADA") {
                    const retryLoc = await fetchAddressLocation(address, strictCityName, departmentParam, 1, 0, row.recipient);
                    if (retryLoc) {
                        foundCoords = `${retryLoc.lat}, ${retryLoc.lon}`;
                        const match2 = zonesToCheck.find(zone => isPointInFeature(retryLoc.lon, retryLoc.lat, zone));
                        if (match2) {
                            foundPostalCode = match2.codigo_postal;
                            if (match2.nombre_localidad) foundLocalidad = match2.nombre_localidad;
                        } else {
                            const locName2 = await reverseGeocodeLocalidad(retryLoc.lat, retryLoc.lon);
                            if (locName2) {
                                foundLocalidad = locName2;
                                const byLoc2 = zonesToCheck.find(z => normalizeStr(z.nombre_localidad || '') === normalizeStr(locName2));
                                if (byLoc2) foundPostalCode = byLoc2.codigo_postal;
                            }
                        }
                    }
                }
                // If still unresolved, assign by municipal index
                if (!foundPostalCode || foundPostalCode.includes('DIR_NO_ENCONTRADA') || foundPostalCode.includes('REVISAR_DIRECCION')) {
                    const idx = row.dane ? await getMunicipalIndexByDane(row.dane) : null;
                    if (idx && idx.preferred_postal) {
                        foundPostalCode = idx.preferred_postal;
                        const zf = zonesToCheck.find(z => z.codigo_postal === foundPostalCode) || db.find(z => z.codigo_postal === foundPostalCode);
                        if (zf) {
                            const cl3 = zf.centerLat;
                            const cn3 = zf.centerLon;
                            if (typeof cl3 === 'number' && typeof cn3 === 'number') {
                                foundCoords = `${cl3}, ${cn3}`;
                            } else {
                                const ct3 = calculateCentroid(zf.geometry);
                                foundCoords = `${ct3.lat}, ${ct3.lon}`;
                            }
                        }
                    } else {
                        const idx2 = await getMunicipalIndexByCityName(strictCityName);
                        if (idx2 && idx2.preferred_postal) {
                            foundPostalCode = idx2.preferred_postal;
                            const zf2 = zonesToCheck.find(z => z.codigo_postal === foundPostalCode) || db.find(z => z.codigo_postal === foundPostalCode);
                            if (zf2) {
                                const cl4 = zf2.centerLat;
                                const cn4 = zf2.centerLon;
                                if (typeof cl4 === 'number' && typeof cn4 === 'number') {
                                    foundCoords = `${cl4}, ${cn4}`;
                                } else {
                                    const ct4 = calculateCentroid(zf2.geometry);
                                    foundCoords = `${ct4.lat}, ${ct4.lon}`;
                                }
                            }
                        }
                    }
                }
            }
            if ((!foundPostalCode || foundPostalCode.includes('DIR_NO_ENCONTRADA')) && zonesToCheck.length > 0) {
                foundPostalCode = "REVISAR_DIRECCION";
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

    return { postalCode: foundPostalCode, coords: foundCoords, localidad: foundLocalidad || undefined };
};

// ADAPTIVE QUEUE PROCESSOR WITH ABORT SIGNAL
export const processTemplateBatch = async (
    templateRows: any[], 
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal,
    onPause?: (ms: number) => void
): Promise<AddressTemplate[]> => {
    
  const db = await getAllPostalZones();
  if (db.length === 0) throw new Error("No hay base maestra (Shapefile) cargada.");
  
  console.log(`[PROCESSOR] Starting batch processing of ${templateRows.length} rows with ${db.length} postal zones`);
  
  const zonesByMuni: Record<string, PostalZone[]> = zonesIndexReady ? zonesByCityIndex : {};
  if (!zonesIndexReady) {
    db.forEach(z => {
        const k = normalizeCityKey(z.nombre_municipio);
        if (!zonesByMuni[k]) zonesByMuni[k] = [];
        zonesByMuni[k].push(z);
    });
  }
  
  console.log(`[PROCESSOR] Organized ${db.length} zones into ${Object.keys(zonesByMuni).length} municipalities`);

  const results: AddressTemplate[] = new Array(templateRows.length);
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;
  
  // Work Queue
  const queue = Array.from({ length: templateRows.length }, (_, i) => i);
  
  let concurrency = 1;
  const mapsKey = ((import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY) || '';
  const useGoogle = !!(mapsKey && mapsKey !== 'demo_key_for_testing' && ((import.meta as any).env.VITE_ENABLE_GOOGLE === '1'));
  const geminiKey = ((import.meta as any).env.VITE_GEMINI_API_KEY) || '';
  const useGemini = !!(geminiKey && geminiKey !== 'demo_key_for_testing' && ((import.meta as any).env.VITE_ENABLE_GEMINI === '1'));
  if (useGoogle) {
    concurrency = 2;
    const envConc = parseInt(String(((import.meta as any).env.VITE_GEOCODE_CONCURRENCY || '')), 10);
    if (!isNaN(envConc) && envConc > 0 && envConc <= 16) concurrency = envConc;
  } else {
    concurrency = 1;
  }
  
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
              const normKey = (k: string) => normalizeStr(k);
              const pick = (obj: any, aliases: string[], contains?: string[]) => {
                  const keys = Object.keys(obj);
                  for (const al of aliases) {
                      const nal = normKey(al);
                      const found = keys.find(k => normKey(k) === nal);
                      if (found) return obj[found];
                  }
                  if (contains && contains.length) {
                      const ncont = contains.map(c => normKey(c));
                      const found2 = keys.find(k => ncont.some(c => normKey(k).includes(c)));
                      if (found2) return obj[found2];
                  }
                  return '';
              };
              const city = pick(row, ['Ciudad de destino','Ciudad','Municipio','Mpio'], ['ciudad','municipio','mpio']) || '';
              const department = pick(row, ['Departamento de destino','Departamento','Depto'], ['departamento','depto']) || '';
              const address = String(pick(row, ['Dirección','Direccion','Destino'], ['direccion','destino']) || '');
              const daneRaw = pick(row, ['DANE destino','Código DANE','Cod Mpio','DANE','codigo_municipio'], ['dane','codigo','mpio']) || '';
              const dane = String(daneRaw).replace(/\D/g, '').padStart(5, '0').slice(-5);
              const globalId = index;

              try {
                  const now = Date.now();
                  const minDelay = useGoogle ? 150 : (useGemini ? 400 : 1200);
                  const timeSinceLastRequest = now - lastRequestTime.value;
                  if (timeSinceLastRequest < minDelay) {
                      await sleep(minDelay - timeSinceLastRequest);
                  }
                  lastRequestTime.value = Date.now();
                  const recipient = String(row['Destinatario'] || row['destinatario'] || '').trim();
                  const rowTimeoutMs = 8000;
                  const timeoutPromise = new Promise<{ postalCode: string, coords: string, localidad?: string }>((resolveTimeout) => {
                      setTimeout(() => resolveTimeout({ postalCode: "DIR_NO_ENCONTRADA", coords: "" }), rowTimeoutMs);
                  });
                  const res = await Promise.race([
                      resolveSingleAddress({ dane, city, department, address, recipient }, db, zonesByMuni),
                      timeoutPromise
                  ]);
                  
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
                      localidad_detectada: res.localidad || '',
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
                          
                          try { onPause && onPause(30000); } catch {}
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
                          localidad_detectada: '',
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

    const recipient = String(row['Destinatario'] || row['destinatario'] || '').trim();
    const resolved = await resolveSingleAddress({
      dane,
      city,
      department,
      address,
      recipient
    }, db, zonesByMuni);
    const cp = resolved.postalCode;
    const coords = resolved.coords;
    const localidad = resolved.localidad || '';

    results[i] = {
      id: `tmpl-fast-${i+1}`,
      dane_destino: dane ? dane.padStart(5, '0').slice(-5) : '00000',
      ciudad_destino: city,
      departamento_destino: department,
      direccion: address,
      codigo_postal_asignado: cp,
      coordenadas: coords,
      localidad_detectada: localidad,
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
    const recipient = String((item as any)?.originalData?.Destinatario || (item as any)?.originalData?.destinatario || '').trim();
    const result = await resolveSingleAddress({
        dane: item.dane_destino,
        city: item.ciudad_destino,
        department: item.departamento_destino || '',
        address: item.direccion,
        recipient
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
const geocodeWithGoogleMaps = async (query: string, city?: string, state?: string): Promise<{ lat: number, lon: number } | null> => {
    const apiKey = (import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY;
    const enabled = ((import.meta as any).env.VITE_ENABLE_GOOGLE === '1');
    if (!enabled) return null;
    if (!apiKey || apiKey === 'demo_key_for_testing') return null;
    try {
        const encoded = encodeURIComponent(`${query}, Colombia`);
        const compParts: string[] = ['country:CO'];
        if (city && city.trim()) compParts.push(`locality:${encodeURIComponent(city.trim())}`);
        if (state && state.trim()) compParts.push(`administrative_area:${encodeURIComponent(state.trim())}`);
        const componentsParam = compParts.join('|');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&components=${componentsParam}&region=CO&key=${apiKey}`;
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

const reverseGeocodeLocalidad = async (lat: number, lon: number): Promise<string | null> => {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=16&addressdetails=1`;
        const res = await fetch(url, { headers: { 'User-Agent': 'ColPostalValidator/1.0', 'Accept-Language': 'es' } });
        if (!res.ok) return null;
        const data = await res.json();
        const addr = data?.address || {};
        const loc = addr.city_district || addr.suburb || addr.town || addr.neighbourhood || null;
        if (typeof loc === 'string') return loc.trim();
        return null;
    } catch {
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

        result = await geocodeWithNominatim(cleanQuery);
        if (!result) {
            result = await geocodeWithGoogleMaps(cleanQuery);
        }
        if (!result) {
            const genAI = getGenAI();
            if (genAI) {
                try {
                    const response = await genAI.models.generateContent({
                        model: 'gemini-1.5-flash',
                        contents: `You are a precise geocoding assistant. Find the EXACT latitude and longitude coordinates for the specific address in Colombia: "${cleanQuery}". Return ONLY JSON with keys lat and lon.`,
                        config: { tools: [{ googleMaps: {} }, { googleSearch: {} }], maxOutputTokens: 100, temperature: 0 }
                    });
                    let text = response.text || "";
                    result = extractJSON(text);
                    if (!result) {
                        const latRegex = /["']?(?:lat|latitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                        const lonRegex = /["']?(?:lon|lng|long|longitude)["']?[:\s=]*([+-]?\d+(?:\.\d+)?)/i;
                        const latMatch = text.match(latRegex);
                        const lonMatch = text.match(lonRegex);
                        if (latMatch && lonMatch) {
                            result = { lat: parseFloat(latMatch[1]), lon: parseFloat(lonMatch[1]) };
                        }
                    }
                } catch (e: any) {
                    console.warn("Gemini API failed, falling back:", e);
                }
            }
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