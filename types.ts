export interface PostalZone {
  id: string;
  // Normalized properties from Shapefile attributes
  codigo_municipio: string;
  nombre_municipio: string;
  nombre_localidad?: string;
  codigo_departamento: string;
  nombre_departamento: string;
  codigo_postal: string; // The key field (e.g., CODIGO_POS)
  
  // GeoJSON Geometry
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: any[];
  };

  // Optimization: Bounding Box [minLon, minLat, maxLon, maxLat]
  bbox: [number, number, number, number];
  
  // Calculated for quick map centering
  centerLat: number;
  centerLon: number;
}

export type UserRole = 'TI' | 'Contabilidad' | 'Facturación' | 'Operaciones' | 'Admin';

export interface AuthSession {
  email: string;
  role: UserRole;
}

export interface AddressTemplate {
  id: string;
  dane_destino: string;
  ciudad_destino: string;
  departamento_destino?: string; // Added field for Department
  direccion: string;
  codigo_postal_asignado?: string;
  coordenadas?: string; // New field for Latitude, Longitude
  localidad_detectada?: string;
  direccion_google?: string; // Normalizada por API
  originalData?: any; // To store the full original row from Excel
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  totalPages: number;
}

export interface MunicipalIndexEntry {
  dane: string;
  nombre_municipio: string;
  nombre_departamento: string;
  entries: { codigo_postal: string; tipo: string }[];
  preferred_postal: string;
}

export enum ProcessStatus {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}
